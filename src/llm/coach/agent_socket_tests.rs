//! Fake agents use the same channel driver as WS /coach/session and Tauri.
//! No CLI, HTTP provider, network listener or image renderer is used.

use super::*;
use std::cell::Cell;
use std::sync::atomic::AtomicU64;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedReceiver;

use crate::config::Config;
use crate::llm::agent_runs::{AgentRequest, AgentRunRegistry, AgentRunStatus, AppAgentHook};
use crate::llm::{ChatReply, ToolCall};

struct Socket {
    incoming: UnboundedSender<String>,
    outgoing: UnboundedReceiver<ServerFrame>,
    driver: tokio::task::JoinHandle<()>,
}

impl Socket {
    fn new(state: Shared) -> Self {
        let (incoming, rx) = mpsc::unbounded_channel();
        let (tx, outgoing) = mpsc::unbounded_channel();
        let driver = tokio::spawn(drive_channels(state, rx, tx));
        Self {
            incoming,
            outgoing,
            driver,
        }
    }

    fn send(&self, frame: Value) {
        self.incoming.send(frame.to_string()).unwrap();
    }

    async fn next(&mut self) -> Value {
        serde_json::to_value(
            tokio::time::timeout(Duration::from_secs(3), self.outgoing.recv())
                .await
                .expect("frame deadline")
                .expect("socket open"),
        )
        .unwrap()
    }

    async fn close(self) {
        drop(self.incoming);
        tokio::time::timeout(Duration::from_secs(3), self.driver)
            .await
            .unwrap()
            .unwrap();
    }
}

fn state() -> Shared {
    let mut cfg = Config::default();
    cfg.llm.modes.review = "bot".into();
    cfg.llm.modes.viz = "bot".into();
    crate::serve::new_state(cfg)
}

fn ask() -> Value {
    json!({"surface":"whiteboard","question":"show a pair","draw":true,
        "board":{"recognized_text":"pair","scene_structure":[{"id":"student"}],"png":"fake-png"}})
}

async fn waiting(
    socket: &mut Socket,
    state: &Shared,
    request_id: &str,
    payload: Value,
) -> AgentRequest {
    socket.send(json!({"type":"run","request_id":request_id,"action":"ask","payload":payload}));
    assert_eq!(
        socket.next().await,
        json!({"type":"stage","request_id":request_id,"stage":"received","detail":"got question"})
    );
    assert_eq!(
        socket.next().await,
        json!({"type":"stage","request_id":request_id,"stage":"ask","detail":"Waiting for the AI assistant"})
    );
    state
        .agent_runs
        .list_waiting_bots()
        .into_iter()
        .find(|run| run.request_id == request_id)
        .unwrap()
}

fn tool(name: &str, arguments: Value) -> ToolCall {
    ToolCall {
        name: name.into(),
        arguments,
    }
}

fn tool_frame(
    request_id: &str,
    name: &str,
    status: &str,
    summary: &str,
    reason: Option<&str>,
) -> Value {
    let mut frame = json!({"type":"tool_event","request_id":request_id,"name":name,"status":status,"summary":summary});
    if let Some(reason) = reason {
        frame["reason"] = json!(reason);
    }
    frame
}

#[tokio::test]
async fn fake_bot_drives_the_socket_with_exact_live_frames_and_api_envelope() {
    let state = state();
    let mut socket = Socket::new(state.clone());
    let payload = ask();
    let run = waiting(&mut socket, &state, "r1", payload.clone()).await;
    assert_eq!(run.payload, payload);
    assert_eq!(run.context.board.png.as_deref(), Some("fake-png"));
    assert_eq!(
        run.context.board.scene_structure,
        Some(json!([{"id":"student"}]))
    );
    assert_eq!(run.context.task_id, crate::pad::WHITEBOARD_TASK_ID);
    state
        .agent_runs
        .report_step(&run.id, "Reading your board")
        .unwrap();
    assert_eq!(
        socket.next().await,
        json!({"type":"stage","request_id":"r1","stage":"agent_step","detail":"Reading your board"})
    );

    let program = json!({"viz":"array","id":"pair","title":"Pair","frames":[{"cells":[2,7]}]});
    state
        .agent_runs
        .apply_tool(&run.id, &tool("draw_structure", program.clone()))
        .unwrap();
    assert_eq!(
        socket.next().await,
        tool_frame(
            "r1",
            "draw_structure",
            "proposed",
            "drawing a structure",
            None
        )
    );
    assert_eq!(
        socket.next().await,
        tool_frame("r1", "draw_structure", "accepted", "Pair", None)
    );
    state
        .agent_runs
        .apply_tool(
            &run.id,
            &tool("draw_structure", json!({"viz":"array","frames":[]})),
        )
        .unwrap();
    assert_eq!(
        socket.next().await,
        tool_frame(
            "r1",
            "draw_structure",
            "proposed",
            "drawing a structure",
            None
        )
    );
    assert_eq!(
        socket.next().await,
        tool_frame(
            "r1",
            "draw_structure",
            "rejected",
            "draw_structure",
            Some("the diagram had no frames")
        )
    );
    assert!(state
        .agent_runs
        .apply_tool(&run.id, &tool("cite_test_case", json!({"case_index":0})))
        .is_err());
    assert_eq!(
        socket.next().await,
        tool_frame("r1", "cite_test_case", "proposed", "cite_test_case", None)
    );
    assert_eq!(
        socket.next().await,
        tool_frame(
            "r1",
            "cite_test_case",
            "rejected",
            "cite_test_case",
            Some("tool \"cite_test_case\" is not allowed for this ask run")
        )
    );
    assert!(state
        .agent_runs
        .apply_tool(&run.id, &tool("teleport", json!({})))
        .is_err());
    assert_eq!(
        socket.next().await,
        tool_frame("r1", "teleport", "proposed", "teleport", None)
    );
    assert_eq!(
        socket.next().await,
        tool_frame(
            "r1",
            "teleport",
            "rejected",
            "teleport",
            Some("tool \"teleport\" is not allowed for this ask run")
        )
    );

    state.agent_runs.reply(&run.id, " A pair. ").unwrap();
    assert_eq!(
        socket.next().await,
        json!({"type":"stage","request_id":"r1","stage":"done","detail":""})
    );
    let program: crate::llm::VizProgram = serde_json::from_value(program).unwrap();
    let expected = serde_json::to_value(coach::AskEnvelope {
        task_id: crate::pad::WHITEBOARD_TASK_ID.into(),
        provider: "bot".into(),
        reply: "A pair.".into(),
        programs: vec![program],
        artifacts: vec![],
        reasoning: String::new(),
        proposed_annotations: vec![],
        process_events: vec![],
    })
    .unwrap();
    assert_eq!(
        socket.next().await,
        json!({"type":"result","request_id":"r1","action":"ask","body":expected})
    );
    assert_eq!(
        state.agent_runs.get_request(&run.id).unwrap().status,
        AgentRunStatus::Done
    );
    assert!(
        socket.outgoing.try_recv().is_err(),
        "no reasoning or extra frames"
    );
    socket.close().await;
}

#[tokio::test]
async fn cancellation_busy_stale_cancel_and_disconnect_close_the_correct_run() {
    let state = state();
    let mut socket = Socket::new(state.clone());
    let first = waiting(&mut socket, &state, "first", ask()).await;
    socket.send(json!({"type":"run","request_id":"busy","action":"ask","payload":ask()}));
    assert_eq!(
        socket.next().await,
        json!({"type":"error","request_id":"busy","message":"busy — the coach is still working on the previous request"})
    );
    socket.send(json!({"type":"cancel","request_id":"first"}));
    assert_eq!(
        socket.next().await,
        json!({"type":"error","request_id":"first","message":"cancelled"})
    );
    let second = waiting(&mut socket, &state, "second", ask()).await;
    // Polling the next request means the aborted task has had a chance to drop.
    assert_eq!(
        state.agent_runs.get_request(&first.id).unwrap().status,
        AgentRunStatus::Cancelled
    );
    socket.send(json!({"type":"cancel","request_id":"first"}));
    state
        .agent_runs
        .report_step(&second.id, "Still working")
        .unwrap();
    assert_eq!(
        socket.next().await,
        json!({"type":"stage","request_id":"second","stage":"agent_step","detail":"Still working"})
    );
    socket.close().await;
    // Aborts are processed when the runtime next polls the task.
    tokio::task::yield_now().await;
    assert_eq!(
        state.agent_runs.get_request(&second.id).unwrap().status,
        AgentRunStatus::Cancelled
    );
    assert!(state.agent_runs.reply(&second.id, "late").is_err());
}

#[tokio::test]
async fn controlled_deadline_fails_the_waiting_socket_and_late_reply_is_refused() {
    let clock = Arc::new(AtomicU64::new(1000));
    let mut state = state();
    Arc::get_mut(&mut state).unwrap().agent_runs = Arc::new(AgentRunRegistry::with_clock({
        let clock = clock.clone();
        move || clock.load(Ordering::SeqCst)
    }));
    let mut socket = Socket::new(state.clone());
    let run = waiting(&mut socket, &state, "deadline", ask()).await;
    clock.store(run.deadline, Ordering::SeqCst);
    assert!(state.agent_runs.expire(&run.id).unwrap());
    assert_eq!(
        socket.next().await,
        json!({"type":"error","request_id":"deadline",
        "message":"agent run deadline expired — no reply arrived in time; please ask again"})
    );
    assert!(state.agent_runs.reply(&run.id, "too late").is_err());
    assert!(state.agent_runs.list_waiting_bots().is_empty());
    socket.close().await;
}

#[tokio::test]
async fn socket_deadline_timer_expires_without_an_agent_polling_the_registry() {
    use crate::llm::agent_runs::{AgentResponder, AgentRunInput, AgentTaskContext};
    let state = state();
    let run_state = state.clone();
    let (outgoing, mut frames) = mpsc::unbounded_channel();
    let (id_tx, mut id_rx) = mpsc::unbounded_channel();
    let run = spawn_run_with(
        outgoing,
        "timer".into(),
        RunAction::Ask,
        ask(),
        move |payload, events| async move {
            let handle = run_state.agent_runs.create(
                "timer".into(),
                AgentResponder::Bot,
                AgentRunInput {
                    action: RunAction::Ask,
                    payload,
                    cfg: Config::default(),
                    context: AgentTaskContext::default(),
                },
                events,
                Some(Duration::from_millis(5)),
            );
            id_tx.send(handle.id.clone()).unwrap();
            agent_socket::wait_for_reply(&run_state, handle).await
        },
    );
    let id = id_rx.recv().await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), run.task)
        .await
        .unwrap()
        .unwrap();
    let mut actual = vec![];
    while let Some(frame) = frames.recv().await {
        actual.push(serde_json::to_value(frame).unwrap());
    }
    assert_eq!(
        actual,
        vec![
            json!({"type":"stage","request_id":"timer","stage":"received","detail":"got question"}),
            json!({"type":"error","request_id":"timer","message":"agent run deadline expired — no reply arrived in time; please ask again"}),
        ]
    );
    assert_eq!(
        state.agent_runs.get_request(&id).unwrap().status,
        AgentRunStatus::Failed
    );
}

#[tokio::test]
async fn two_sockets_with_the_same_request_id_keep_independent_tools_and_results() {
    let state = state();
    let mut a = Socket::new(state.clone());
    let mut b = Socket::new(state.clone());
    let first = waiting(&mut a, &state, "same-id", ask()).await;
    // Find the second by id because a client-generated request id is not global.
    b.send(json!({"type":"run","request_id":"same-id","action":"ask","payload":ask()}));
    b.next().await;
    b.next().await;
    let second = state
        .agent_runs
        .list_waiting_bots()
        .into_iter()
        .find(|run| run.id != first.id)
        .unwrap();
    assert_ne!(first.id, second.id);
    state
        .agent_runs
        .apply_tool(
            &second.id,
            &tool(
                "create_attachment",
                json!({"kind":"code","title":"b.py","source":"print(2)"}),
            ),
        )
        .unwrap();
    assert_eq!(
        b.next().await,
        tool_frame(
            "same-id",
            "create_attachment",
            "proposed",
            "calling a tool",
            None
        )
    );
    assert_eq!(
        b.next().await,
        tool_frame(
            "same-id",
            "create_attachment",
            "accepted",
            "Preparing b.py",
            None
        )
    );
    assert!(a.outgoing.try_recv().is_err());
    state.agent_runs.cancel(&first.id).unwrap();
    assert_eq!(
        a.next().await,
        json!({"type":"error","request_id":"same-id","message":"cancelled"})
    );
    state.agent_runs.reply(&second.id, "B answer").unwrap();
    b.next().await;
    let result = b.next().await;
    assert_eq!(result["body"]["reply"], "B answer");
    assert_eq!(result["body"]["artifacts"][0]["title"], "b.py");
    assert_eq!(
        state.agent_runs.get_request(&first.id).unwrap().status,
        AgentRunStatus::Cancelled
    );
    assert_eq!(
        state.agent_runs.get_request(&second.id).unwrap().status,
        AgentRunStatus::Done
    );
    a.close().await;
    b.close().await;
}

struct FakeApp {
    started: UnboundedSender<String>,
    cancelled: UnboundedSender<String>,
    fail: bool,
}

impl AppAgentHook for FakeApp {
    fn start(&self, id: &str, _: Arc<AgentRunRegistry>) -> Result<()> {
        self.started.send(id.into()).unwrap();
        anyhow::ensure!(!self.fail, "fake launch failure");
        Ok(())
    }
    fn cancel(&self, id: &str) {
        self.cancelled.send(id.into()).unwrap();
    }
}

#[tokio::test]
async fn app_hook_gets_a_scoped_run_and_cancellation_and_launch_failure() {
    for fail in [false, true] {
        let state = state();
        state.cfg.write().unwrap().llm.modes.review = "app".into();
        let (started, mut starts) = mpsc::unbounded_channel();
        let (cancelled, mut cancels) = mpsc::unbounded_channel();
        state.agent_runs.set_app_hook(Arc::new(FakeApp {
            started,
            cancelled,
            fail,
        }));
        let mut socket = Socket::new(state.clone());
        socket.send(json!({"type":"run","request_id":"app","action":"ask","payload":ask()}));
        socket.next().await;
        assert_eq!(
            socket.next().await,
            json!({"type":"stage","request_id":"app","stage":"ask","detail":"Waiting for the AI application"})
        );
        let id = starts.recv().await.unwrap();
        assert!(state.agent_runs.list_waiting_bots().is_empty());
        if fail {
            assert_eq!(
                socket.next().await,
                json!({"type":"error","request_id":"app","message":"could not start the AI application: fake launch failure"})
            );
            assert_eq!(
                state.agent_runs.get_request(&id).unwrap().status,
                AgentRunStatus::Failed
            );
        } else {
            socket.send(json!({"type":"cancel","request_id":"app"}));
            assert_eq!(
                socket.next().await,
                json!({"type":"error","request_id":"app","message":"cancelled"})
            );
        }
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(3), cancels.recv())
                .await
                .unwrap(),
            Some(id)
        );
        socket.close().await;
    }
}

/// Run the real API tool loop with a fake provider at the common socket task
/// boundary. The literal frame contract was present before agent routing; the
/// normal run_action dispatcher and its HTTP handlers remain unchanged.
#[tokio::test]
async fn api_provider_regression_preserves_exact_frames_and_envelope() {
    struct Api {
        calls: Cell<usize>,
    }
    impl LlmProvider for Api {
        fn label(&self) -> String {
            "fake-api".into()
        }
        fn chat(&self, _: &str, _: &str) -> Result<String> {
            unreachable!()
        }
        fn chat_ex(&self, _: &ChatRequest) -> Result<ChatReply> {
            let n = self.calls.get();
            self.calls.set(n + 1);
            Ok(if n == 0 {
                ChatReply {
                    content: String::new(),
                    reasoning: "Inspect the pair.".into(),
                    tool_calls: vec![
                        tool(
                            "draw_structure",
                            json!({"viz":"array","id":"pair","title":"Pair","frames":[{"cells":[2,7]}]}),
                        ),
                        tool("draw_structure", json!({"viz":"array","frames":[]})),
                    ],
                }
            } else {
                ChatReply {
                    content: "A pair.".into(),
                    ..Default::default()
                }
            })
        }
    }
    let (outgoing, mut frames) = mpsc::unbounded_channel();
    let run = spawn_run_with(
        outgoing,
        "api".into(),
        RunAction::Ask,
        ask(),
        |_, events| async move {
            events.stage("ask", "Answering from the pad");
            let outcome = crate::llm::docs::run_pad_ask(
                &Api {
                    calls: Cell::new(0),
                },
                &Config::default(),
                crate::llm::coach::PAD_ASK_SYSTEM_PROMPT,
                "show a pair".into(),
                vec![],
                &events,
                true,
                None,
                true,
            )?;
            events.stage("done", "");
            Ok(serde_json::to_value(coach::AskEnvelope {
                task_id: crate::pad::WHITEBOARD_TASK_ID.into(),
                provider: "fake-api".into(),
                reply: outcome.reply,
                reasoning: outcome.reasoning,
                programs: outcome.programs,
                artifacts: outcome.artifacts,
                proposed_annotations: outcome.proposed,
                process_events: vec![],
            })?)
        },
    );
    run.task.await.unwrap();
    let mut actual = Vec::new();
    while let Some(frame) = frames.recv().await {
        actual.push(serde_json::to_value(frame).unwrap());
    }
    let program: crate::llm::VizProgram = serde_json::from_value(
        json!({"viz":"array","id":"pair","title":"Pair","frames":[{"cells":[2,7]}]}),
    )
    .unwrap();
    assert_eq!(
        actual,
        vec![
            json!({"type":"stage","request_id":"api","stage":"received","detail":"got question"}),
            json!({"type":"stage","request_id":"api","stage":"ask","detail":"Answering from the pad"}),
            json!({"type":"reasoning","request_id":"api","text":"Inspect the pair."}),
            json!({"type":"stage","request_id":"api","stage":"reason","detail":"Inspect the pair."}),
            tool_frame(
                "api",
                "draw_structure",
                "proposed",
                "drawing a structure",
                None
            ),
            tool_frame("api", "draw_structure", "accepted", "Pair", None),
            tool_frame(
                "api",
                "draw_structure",
                "proposed",
                "drawing a structure",
                None
            ),
            tool_frame(
                "api",
                "draw_structure",
                "rejected",
                "draw_structure",
                Some("the diagram had no frames")
            ),
            json!({"type":"stage","request_id":"api","stage":"done","detail":""}),
            json!({"type":"result","request_id":"api","action":"ask","body":{
            "task_id":crate::pad::WHITEBOARD_TASK_ID,"provider":"fake-api","reply":"A pair.",
            "reasoning":"Inspect the pair.","programs":[program]}}),
        ]
    );
}

#[tokio::test]
async fn api_routing_still_uses_the_original_handler_validation() {
    let state = crate::serve::new_state(Config::default());
    let mut socket = Socket::new(state.clone());
    socket.send(json!({"type":"run","request_id":"api","action":"ask","payload":{"question":" "}}));
    assert_eq!(
        socket.next().await,
        json!({"type":"stage","request_id":"api","stage":"received","detail":"got your message"})
    );
    assert_eq!(
        socket.next().await,
        json!({"type":"error","request_id":"api","message":"type a question first"})
    );
    assert!(state.agent_runs.list_waiting_bots().is_empty());
    socket.close().await;
}

#[tokio::test]
async fn other_actions_route_by_their_existing_mode_and_use_their_http_results() {
    for (action, reply) in [
        (
            RunAction::Review,
            r#"{"verdict":"on_track","understood_approach":"pair"}"#,
        ),
        (
            RunAction::Lazy,
            r#"{"filled_code":"print(1)","note":"earned"}"#,
        ),
        (RunAction::Viz, "A pair."),
        (RunAction::DrawReview, r#"{"ok":true}"#),
    ] {
        let state = state();
        state.cfg.write().unwrap().coach.draw_review_enabled = true;
        // The unused mode must never be consulted or call a model.
        if action.provider_mode() == "review" {
            state.cfg.write().unwrap().llm.modes.viz = "invalid-unused-provider".into();
        } else {
            state.cfg.write().unwrap().llm.modes.review = "invalid-unused-provider".into();
        }
        let program = json!({"viz":"array","id":"pair","frames":[{"cells":[2,7]}]});
        let mut payload = json!({"task_id":crate::pad::WHITEBOARD_TASK_ID,
            "program":program,"png":"fake-png"});
        // Review flattens its board, while Lazy and Viz nest it.
        if action == RunAction::Review {
            payload["recognized_text"] = json!("pair");
        } else {
            payload["board"] = json!({"recognized_text":"pair"});
        }
        let mut socket = Socket::new(state.clone());
        socket.send(json!({"type":"run","request_id":"other","action":action,"payload":payload}));
        assert_eq!(socket.next().await["stage"], "received");
        assert_eq!(
            socket.next().await,
            json!({"type":"stage","request_id":"other","stage":"ask","detail":"Waiting for the AI assistant"})
        );
        let run = state.agent_runs.list_waiting_bots().pop().unwrap();
        assert_eq!(run.action, action);
        assert_eq!(run.payload, payload);
        let expected = match action {
            RunAction::Review => serde_json::to_value(coach::ReviewEnvelope {
                task_id: crate::pad::WHITEBOARD_TASK_ID.into(),
                provider: "bot".into(),
                review: crate::llm::coach::parse_review(reply, &[]).unwrap(),
                approach_transition: None,
                candidate_approaches: vec![],
            })
            .unwrap(),
            RunAction::Lazy => serde_json::to_value(coach::LazyEnvelope {
                task_id: crate::pad::WHITEBOARD_TASK_ID.into(),
                provider: "bot".into(),
                fill: crate::llm::coach::parse_lazy_fill(reply).unwrap(),
            })
            .unwrap(),
            RunAction::Viz => serde_json::to_value(viz::VizEnvelope {
                task_id: crate::pad::WHITEBOARD_TASK_ID.into(),
                provider: "bot".into(),
                message: reply.into(),
                ..Default::default()
            })
            .unwrap(),
            RunAction::DrawReview => serde_json::to_value(viz::DrawReviewEnvelope {
                task_id: crate::pad::WHITEBOARD_TASK_ID.into(),
                provider: "bot".into(),
                review: crate::llm::coach::parse_draw_review(reply).unwrap(),
                program: None,
                skipped: None,
            })
            .unwrap(),
            RunAction::Ask => unreachable!(),
        };
        state.agent_runs.reply(&run.id, reply).unwrap();
        assert_eq!(
            socket.next().await,
            json!({"type":"stage","request_id":"other","stage":"done","detail":""})
        );
        assert_eq!(
            socket.next().await,
            json!({"type":"result","request_id":"other","action":action,"body":expected})
        );
        socket.close().await;
    }
}
