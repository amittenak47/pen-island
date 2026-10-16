use super::*;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::llm::coach::{parse_review, DrawReview, LazyFillResponse};
use crate::llm::docs::ArtifactProposal;
use crate::serve::{coach, viz};

fn input(action: AgentAction, payload: Value) -> AgentRunInput {
    AgentRunInput {
        action,
        payload,
        cfg: Config::default(),
        context: AgentTaskContext {
            task_id: "task".into(),
            cases: vec![IoCase {
                input: "[2,7]".into(),
                output: "9".into(),
            }],
            board: BoardSnapshot {
                scene_structure: Some(json!([{"id":"student"}])),
                ..Default::default()
            },
            ..Default::default()
        },
    }
}

fn create(registry: &AgentRunRegistry, action: AgentAction, payload: Value) -> AgentRunHandle {
    registry.create(
        "socket-request".into(),
        AgentResponder::Bot,
        input(action, payload),
        EventSink::none(),
        None,
    )
}

fn call(name: &str, arguments: Value) -> ToolCall {
    ToolCall {
        name: name.into(),
        arguments,
    }
}

#[test]
fn tool_permissions_match_each_api_action_and_ask_surface() {
    let cases = [
        (
            AgentAction::Ask,
            json!({"surface":"whiteboard"}),
            vec!["create_attachment"],
        ),
        (
            AgentAction::Ask,
            json!({"surface":"whiteboard","draw":true}),
            vec![
                "draw_structure",
                "animate_trace",
                "annotate_region",
                "create_attachment",
            ],
        ),
        (
            AgentAction::Ask,
            json!({"surface":"problem","draw":true}),
            vec!["create_attachment"],
        ),
        (AgentAction::Review, json!({}), vec![]),
        (AgentAction::Lazy, json!({}), vec![]),
        (
            AgentAction::Viz,
            json!({}),
            vec![
                "draw_structure",
                "animate_trace",
                "annotate_region",
                "cite_test_case",
                "highlight_student_work",
            ],
        ),
        (
            AgentAction::DrawReview,
            json!({}),
            vec!["draw_structure", "animate_trace"],
        ),
    ];
    for (action, payload, expected) in cases {
        let registry = AgentRunRegistry::default();
        let run = create(&registry, action, payload);
        assert_eq!(
            registry.get_request(&run.id).unwrap().allowed_tools,
            expected
        );
        for name in ["search_web", "teleport"] {
            assert!(registry
                .apply_tool(&run.id, &call(name, json!({})))
                .is_err());
        }
        assert!(registry
            .get_request(&run.id)
            .unwrap()
            .envelope
            .programs
            .is_empty());
    }
    let document = input(
        AgentAction::Ask,
        json!({"surface":"annotate","document_hash":"hash"}),
    );
    let mut expected: Vec<_> = document_tools(&document.cfg)
        .iter()
        .map(|tool| tool["function"]["name"].as_str().unwrap().to_string())
        .collect();
    expected.push("create_attachment".into());
    assert_eq!(document.allowed_tools(), expected);
    assert!(!document
        .allowed_tools()
        .iter()
        .any(|name| name == "cite_test_case"));
}

#[test]
fn attachments_still_use_the_shared_validation_and_eight_item_limit() {
    let registry = AgentRunRegistry::default();
    let run = create(&registry, AgentAction::Ask, json!({"surface":"whiteboard"}));
    for n in 0..9 {
        let feedback = registry
            .apply_tool(
                &run.id,
                &call(
                    "create_attachment",
                    json!({"kind":"code","title":format!("{n}.py"),"source":"print(1)"}),
                ),
            )
            .unwrap()
            .unwrap();
        assert_eq!(feedback.contains("too many attachments"), n == 8);
    }
    let artifacts: Vec<ArtifactProposal> =
        registry.get_request(&run.id).unwrap().envelope.artifacts;
    assert_eq!(artifacts.len(), 8);
    let body = registry.reply(&run.id, " files ").unwrap();
    assert_eq!(
        body,
        serde_json::to_value(coach::AskEnvelope {
            task_id: "task".into(),
            provider: "bot".into(),
            reply: "files".into(),
            artifacts,
            reasoning: String::new(),
            proposed_annotations: vec![],
            programs: vec![],
            process_events: vec![],
        })
        .unwrap()
    );
}

#[test]
fn structured_replies_match_the_http_envelopes_and_can_be_corrected() {
    let registry = AgentRunRegistry::default();
    let review = create(&registry, AgentAction::Review, json!({}));
    assert!(registry.reply(&review.id, "not JSON").is_err());
    assert_eq!(
        registry.get_request(&review.id).unwrap().status,
        AgentRunStatus::Waiting
    );
    let raw = r#"{"verdict":"wrong_track","rating":{"correctness":99},"counterexample":{"case_index":0,"input":"invented","expected":"invented"}}"#;
    let parsed = parse_review(raw, &input(AgentAction::Review, json!({})).context.cases).unwrap();
    assert_eq!(
        registry.reply(&review.id, raw).unwrap(),
        serde_json::to_value(coach::ReviewEnvelope {
            task_id: "task".into(),
            provider: "bot".into(),
            review: parsed,
            approach_transition: None,
            candidate_approaches: vec![],
        })
        .unwrap()
    );
    let lazy = create(&registry, AgentAction::Lazy, json!({}));
    assert!(registry.reply(&lazy.id, r#"{"filled_code":" "}"#).is_err());
    assert_eq!(
        registry
            .reply(&lazy.id, r#"{"filled_code":" print(1) ","note":"filled"}"#)
            .unwrap(),
        serde_json::to_value(coach::LazyEnvelope {
            task_id: "task".into(),
            provider: "bot".into(),
            fill: LazyFillResponse {
                filled_code: "print(1)".into(),
                note: "filled".into()
            }
        })
        .unwrap()
    );

    let draw = create(
        &registry,
        AgentAction::DrawReview,
        json!({"program":{"id":"original"}}),
    );
    // A malformed MCP argument must be rejected by the executor, never panic
    // while the adapter pins the replacement id.
    registry
        .apply_tool(&draw.id, &call("draw_structure", json!("malformed")))
        .unwrap();
    assert!(registry
        .get_request(&draw.id)
        .unwrap()
        .envelope
        .programs
        .is_empty());
    registry
        .apply_tool(
            &draw.id,
            &call(
                "draw_structure",
                json!({
                    "viz":"array","id":"wrong-id","frames":[{"cells":[1,2]}]
                }),
            ),
        )
        .unwrap();
    assert!(registry
        .apply_tool(&draw.id, &call("draw_structure", json!({})))
        .is_err());
    let program = registry.get_request(&draw.id).unwrap().envelope.programs[0].clone();
    assert_eq!(program.id, "original");
    assert_eq!(
        registry
            .reply(
                &draw.id,
                r#"{"ok":false,"issues":["wrong pair"],"fix_hint":"move i"}"#
            )
            .unwrap(),
        serde_json::to_value(viz::DrawReviewEnvelope {
            task_id: "task".into(),
            provider: "bot".into(),
            review: DrawReview {
                ok: false,
                issues: vec!["wrong pair".into()],
                fix_hint: "move i".into()
            },
            program: Some(program),
            skipped: None,
        })
        .unwrap()
    );
}

#[test]
fn viz_results_validate_real_cases_and_board_ids() {
    let registry = AgentRunRegistry::default();
    let run = create(&registry, AgentAction::Viz, json!({}));
    registry
        .apply_tool(
            &run.id,
            &call("cite_test_case", json!({"case_index":0,"why":"pair"})),
        )
        .unwrap();
    registry
        .apply_tool(&run.id, &call("cite_test_case", json!({"case_index":99})))
        .unwrap();
    registry
        .apply_tool(
            &run.id,
            &call(
                "highlight_student_work",
                json!({"ids":["student","fake"],"note":"look"}),
            ),
        )
        .unwrap();
    let envelope = registry.get_request(&run.id).unwrap().envelope;
    assert_eq!(envelope.citations[0].input, "[2,7]");
    assert_eq!(envelope.highlights[0].ids, vec!["student"]);
    assert_eq!(envelope.rejected.len(), 1);
    assert_eq!(
        registry.reply(&run.id, "Done").unwrap(),
        serde_json::to_value(viz::VizEnvelope {
            task_id: "task".into(),
            provider: "bot".into(),
            message: "Done".into(),
            programs: envelope.programs,
            annotations: envelope.annotations,
            citations: envelope.citations,
            highlights: envelope.highlights,
            rejected: envelope.rejected,
        })
        .unwrap()
    );
}

#[test]
fn deadlines_timestamps_and_terminal_transitions_use_the_controlled_clock() {
    let clock = Arc::new(AtomicU64::new(1000));
    let registry = AgentRunRegistry::with_clock({
        let clock = clock.clone();
        move || clock.load(Ordering::SeqCst)
    });
    let run = create(&registry, AgentAction::Ask, json!({"surface":"whiteboard"}));
    let initial = registry.get_request(&run.id).unwrap();
    assert_eq!(initial.created_at, 1000);
    assert_eq!(initial.deadline, 601_000);
    assert_eq!(registry.list_waiting_bots().len(), 1);
    clock.store(2000, Ordering::SeqCst);
    registry.report_step(&run.id, "Reading").unwrap();
    let working = registry.get_request(&run.id).unwrap();
    assert_eq!(working.started_at, Some(2000));
    assert_eq!(working.updated_at, 2000);
    assert!(registry.list_waiting_bots().is_empty());
    clock.store(initial.deadline, Ordering::SeqCst);
    assert!(registry.reply(&run.id, "too late").is_err());
    let expired = registry.get_request(&run.id).unwrap();
    assert_eq!(expired.status, AgentRunStatus::Failed);
    assert_eq!(expired.finished_at, Some(initial.deadline));
    assert!(expired.error.unwrap().contains("deadline expired"));
    assert!(matches!(
        &*run.completion.borrow(),
        Some(AgentCompletion::Failed(_))
    ));
    registry.cancel(&run.id).unwrap();
    assert_eq!(
        registry.get_request(&run.id).unwrap().status,
        AgentRunStatus::Failed
    );

    let app = registry.create(
        "app".into(),
        AgentResponder::App,
        input(AgentAction::Ask, json!({})),
        EventSink::none(),
        None,
    );
    assert_eq!(
        registry.get_request(&app.id).unwrap().deadline,
        initial.deadline + 300_000
    );
    assert!(registry.list_waiting_bots().is_empty());
    registry.cancel(&app.id).unwrap();
    assert_eq!(
        registry.get_request(&app.id).unwrap().status,
        AgentRunStatus::Cancelled
    );
    assert!(matches!(
        &*app.completion.borrow(),
        Some(AgentCompletion::Cancelled)
    ));
    assert!(registry.report_step(&app.id, "late").is_err());
    assert!(registry
        .apply_tool(&app.id, &call("create_attachment", json!({})))
        .is_err());
    assert!(registry.reply(&app.id, "late").is_err());
}

#[test]
fn completed_runs_release_their_event_sink_and_ignore_late_work() {
    let (tx, rx) = std::sync::mpsc::channel();
    let events = EventSink::new(move |event| {
        let _ = tx.send(event);
    });
    let registry = AgentRunRegistry::default();
    let run = registry.create(
        "r".into(),
        AgentResponder::Bot,
        input(AgentAction::Ask, json!({})),
        events,
        None,
    );
    registry.reply(&run.id, "done").unwrap();
    assert!(rx.recv().is_ok());
    assert!(
        rx.recv().is_err(),
        "terminal entries cannot hold a socket writer open"
    );
    assert!(registry.reply(&run.id, "duplicate").is_err());
    registry.fail(&run.id, "late failure".into()).unwrap();
    assert_eq!(
        registry.get_request(&run.id).unwrap().status,
        AgentRunStatus::Done
    );
}

#[test]
fn default_app_hook_leaves_the_run_waiting_and_cannot_launch_a_bot() {
    let registry = Arc::new(AgentRunRegistry::default());
    let app = registry.create(
        "app".into(),
        AgentResponder::App,
        input(AgentAction::Ask, json!({})),
        EventSink::none(),
        None,
    );
    registry.start_app(&app.id).unwrap();
    assert_eq!(
        registry.get_request(&app.id).unwrap().status,
        AgentRunStatus::Waiting
    );
    assert!(app.completion.borrow().is_none());
    let bot = create(&registry, AgentAction::Ask, json!({}));
    assert!(registry.start_app(&bot.id).is_err());
}

#[test]
fn document_tools_receive_the_document_context_and_queue_annotations() {
    let registry = AgentRunRegistry::default();
    let run = create(
        &registry,
        AgentAction::Ask,
        json!({
            "surface":"annotate","document_hash":"hash","page":3,
            "page_text":"The current page.","highlight":"A highlighted sentence.","marks_prose":"A saved mark."
        }),
    );
    for (name, text) in [
        ("get_current_page", "The current page."),
        ("get_highlight", "A highlighted sentence."),
        ("list_document_marks", "A saved mark."),
    ] {
        assert_eq!(
            registry
                .apply_tool(&run.id, &call(name, json!({})))
                .unwrap(),
            Some(format!("{name}: {text}"))
        );
    }
    registry
        .apply_tool(
            &run.id,
            &call(
                "save_annotation",
                json!({
                    "excerpt":"sentence","note":"Explain this","page":3
                }),
            ),
        )
        .unwrap();
    let body = registry.reply(&run.id, "An explanation.").unwrap();
    assert_eq!(body["proposed_annotations"][0]["excerpt"], "sentence");
    assert_eq!(body["proposed_annotations"][0]["page"], 3);
    assert!(body.get("reasoning").is_none());
}

#[test]
fn app_deadline_calls_the_cancellation_hook_once() {
    struct Hook(Arc<Mutex<Vec<String>>>);
    impl AppAgentHook for Hook {
        fn start(&self, id: &str, _: Arc<AgentRunRegistry>) -> Result<()> {
            self.0.lock().unwrap().push(format!("start:{id}"));
            Ok(())
        }
        fn cancel(&self, id: &str) {
            self.0.lock().unwrap().push(format!("cancel:{id}"));
        }
    }
    let clock = Arc::new(AtomicU64::new(1000));
    let registry = Arc::new(AgentRunRegistry::with_clock({
        let clock = clock.clone();
        move || clock.load(Ordering::SeqCst)
    }));
    let calls = Arc::new(Mutex::new(vec![]));
    registry.set_app_hook(Arc::new(Hook(calls.clone())));
    let run = registry.create(
        "app".into(),
        AgentResponder::App,
        input(AgentAction::Ask, json!({})),
        EventSink::none(),
        Some(Duration::from_millis(1)),
    );
    registry.start_app(&run.id).unwrap();
    clock.store(1001, Ordering::SeqCst);
    assert!(registry.expire(&run.id).unwrap());
    assert!(!registry.expire(&run.id).unwrap());
    registry.cancel(&run.id).unwrap();
    assert_eq!(
        *calls.lock().unwrap(),
        vec![format!("start:{}", run.id), format!("cancel:{}", run.id)]
    );
}

#[test]
fn providers_round_trip_without_changing_existing_defaults_or_api_values() {
    let mut cfg = Config::default();
    for provider in crate::config::LLM_PROVIDERS {
        cfg.set("llm.modes.review", provider).unwrap();
        assert_eq!(cfg.llm.modes.get("review").unwrap(), provider);
    }
    cfg.set("llm.modes.review", "app").unwrap();
    cfg.set("llm.modes.viz", "bot").unwrap();
    let roundtrip: Config = toml::from_str(&toml::to_string(&cfg).unwrap()).unwrap();
    assert_eq!(roundtrip.llm.modes.review, "app");
    assert_eq!(roundtrip.llm.modes.viz, "bot");
    let caps = roundtrip.llm.modes.capabilities(&roundtrip.llm).unwrap();
    for mode in ["ask", "review", "viz"] {
        let cap = caps.iter().find(|cap| cap.mode == mode).unwrap();
        assert!(cap.vision);
        assert!(cap.model.is_empty());
    }
    assert_eq!(Config::default().llm.modes.review, "local");
    assert!(cfg.set("llm.modes.review", "fake-provider").is_err());
    for action in [AgentAction::Ask, AgentAction::Review, AgentAction::Lazy] {
        assert_eq!(action.provider_mode(), "review");
    }
    for action in [AgentAction::Viz, AgentAction::DrawReview] {
        assert_eq!(action.provider_mode(), "viz");
    }
}

#[test]
fn configured_bot_deadline_uses_the_clock_and_only_applies_to_new_bot_runs() {
    let clock = Arc::new(AtomicU64::new(1000));
    let registry = AgentRunRegistry::with_clock({
        let clock = clock.clone();
        move || clock.load(Ordering::SeqCst)
    });
    let mut task = input(AgentAction::Ask, json!({"surface":"whiteboard"}));
    let old = registry.create(
        "old".into(),
        AgentResponder::Bot,
        input(AgentAction::Ask, json!({})),
        EventSink::none(),
        None,
    );
    task.cfg.set("coach.agent_bot_timeout_secs", "60").unwrap();
    let new = registry.create(
        "new".into(),
        AgentResponder::Bot,
        task,
        EventSink::none(),
        None,
    );
    let app = registry.create(
        "app".into(),
        AgentResponder::App,
        input(AgentAction::Ask, json!({})),
        EventSink::none(),
        None,
    );
    assert_eq!(registry.get_request(&old.id).unwrap().deadline, 601_000);
    assert_eq!(registry.get_request(&new.id).unwrap().deadline, 61_000);
    assert_eq!(registry.get_request(&app.id).unwrap().deadline, 301_000);
    clock.store(60_999, Ordering::SeqCst);
    assert_eq!(
        registry.get_request(&new.id).unwrap().status,
        AgentRunStatus::Waiting
    );
    clock.store(61_000, Ordering::SeqCst);
    assert_eq!(
        registry.get_request(&new.id).unwrap().status,
        AgentRunStatus::Failed
    );
    assert!(registry.reply(&new.id, "Too late").is_err());
    assert_eq!(
        registry.get_request(&old.id).unwrap().status,
        AgentRunStatus::Waiting
    );
}
