use super::*;
use std::cell::{Cell, RefCell};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};

use crate::config::Config;
use crate::llm::agent_runs::{AgentAction, AgentRunInput, AgentRunRegistry, AgentTaskContext};
use crate::llm::coach::{BoardSnapshot, CoachEvent, EventSink};
use crate::llm::{ChatReply, ChatRequest, LlmProvider};
use crate::pads::footnotes::FootnoteSubmission;
use crate::problem::IoCase;

#[derive(Clone)]
struct FakeClient(Shared);

impl FootnoteHub for FakeClient {
    fn bot_inbox_tools(&self) -> Vec<Value> {
        general_tools(self)
    }
    fn list_pending(&self) -> Result<Value, String> {
        Ok(json!([]))
    }
    fn get(&self, _: &str) -> Result<Value, String> {
        panic!("no footnote access")
    }
    fn submit(&self, _: &str, _: &FootnoteSubmission) -> Result<Value, String> {
        panic!("no footnote access")
    }
    fn call(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
        assert_eq!((method, path), ("POST", ROUTE));
        let request = serde_json::from_value(body.unwrap()).map_err(|error| error.to_string())?;
        handle(&self.0, request).map_err(|error| error.to_string())
    }
}

fn message(method: &str, params: Value) -> Value {
    json!({"jsonrpc":"2.0","id":1,"method":method,"params":params})
}

fn rpc(hub: &dyn FootnoteHub, method: &str, params: Value) -> Value {
    super::super::dispatch(hub, &message(method, params)).unwrap()["result"].clone()
}

fn call_tool(hub: &dyn FootnoteHub, name: &str, arguments: Value) -> Value {
    rpc(
        hub,
        "tools/call",
        json!({"name":name,"arguments":arguments}),
    )
}

fn data(result: &Value) -> Value {
    assert_ne!(result["isError"], true, "{result}");
    serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap()
}

fn names(hub: &dyn FootnoteHub) -> Vec<String> {
    rpc(hub, "tools/list", json!({}))["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap().to_owned())
        .collect()
}

fn input(action: AgentAction, payload: Value) -> AgentRunInput {
    AgentRunInput {
        cfg: Config::default(),
        action,
        payload,
        context: AgentTaskContext {
            task_id: "pair".into(),
            description: Some("Find a pair".into()),
            cases: vec![IoCase {
                input: "[2,7]".into(),
                output: "9".into(),
            }],
            board: BoardSnapshot {
                scene_structure: Some(json!([{"id":"student"}])),
                png: Some("aW1hZ2U=".into()),
                ..Default::default()
            },
        },
    }
}

fn create(
    state: &Shared,
    responder: AgentResponder,
    action: AgentAction,
    payload: Value,
) -> String {
    state
        .agent_runs
        .create(
            "socket-request".into(),
            responder,
            input(action, payload),
            EventSink::none(),
            None,
        )
        .id
}

fn app(state: &Shared, id: &str) -> AgentHub<FakeClient> {
    AgentHub::new(
        FakeClient(state.clone()),
        AgentScope::app(id.into()).unwrap(),
    )
    .unwrap()
}

fn bots(state: &Shared) -> AgentHub<FakeClient> {
    AgentHub::new(FakeClient(state.clone()), AgentScope::BotInbox).unwrap()
}

fn program() -> Value {
    json!({"viz":"array","id":"pair","title":"Pair","frames":[{"label":"pair","cells":[2,7],"entries":[]}]})
}

#[test]
fn listing_matches_each_action_and_preserves_api_schemas() {
    let state = crate::serve::new_state(Config::default());
    for (action, payload) in [
        (
            AgentAction::Ask,
            json!({"surface":"whiteboard","draw":true}),
        ),
        (
            AgentAction::Ask,
            json!({"surface":"whiteboard","draw":false}),
        ),
        (AgentAction::Ask, json!({"surface":"problem","draw":true})),
        (
            AgentAction::Ask,
            json!({"surface":"annotate","document_hash":"hash","draw":true}),
        ),
        (AgentAction::Review, json!({})),
        (AgentAction::Lazy, json!({})),
        (AgentAction::Viz, json!({})),
        (AgentAction::DrawReview, json!({})),
    ] {
        let schemas = input(action, payload.clone()).tool_schemas();
        let id = create(&state, AgentResponder::App, action, payload);
        let hub = app(&state, &id);
        let listed = rpc(&hub, "tools/list", json!({}));
        let tools = listed["tools"].as_array().unwrap();
        assert_eq!(tools.len(), schemas.len() + 3);
        assert_eq!(
            &names(&hub)[..3],
            ["get_agent_request", "report_step", "reply"]
        );
        for schema in schemas {
            let tool = tools
                .iter()
                .find(|tool| tool["name"] == schema["function"]["name"])
                .unwrap();
            assert_eq!(tool["inputSchema"], schema["function"]["parameters"]);
        }
        assert!(!names(&hub)
            .iter()
            .any(|name| name.contains("footnote") || name == "list_agent_requests"));
        assert!(call_tool(&hub, "list_footnote_requests", json!({}))["isError"] == true);
        assert_eq!(rpc(&hub, "prompts/list", json!({})), json!({"prompts":[]}));
        let init = rpc(&hub, "initialize", json!({}));
        assert!(init["instructions"].as_str().unwrap().contains(&id));
    }
    let general = FakeClient(state.clone());
    assert!(!names(&general)
        .iter()
        .any(|name| name.contains("agent") || name == "reply" || name == "draw_structure"));
    assert_eq!(
        call_tool(&general, "get_agent_request", json!({}))["isError"],
        true
    );
    let bot = bots(&state);
    assert!(names(&bot).contains(&"list_agent_requests".into()));
    for tool in rpc(&bot, "tools/list", json!({}))["tools"]
        .as_array()
        .unwrap()
    {
        if tool["name"] != "list_agent_requests" {
            assert!(tool["inputSchema"]["required"]
                .as_array()
                .unwrap()
                .contains(&json!("run_id")));
        }
    }
}

#[test]
fn request_contains_text_elements_cases_and_image_with_no_image_bypass() {
    let state = crate::serve::new_state(Config::default());
    let payload = json!({"question":"Why a pair?","page_text":"A document","highlight":"pair",
        "png":"top-secret-image","board":{"png":"nested-secret-image","scene_structure":[{"id":"student"}]}});
    let id = create(
        &state,
        AgentResponder::App,
        AgentAction::Ask,
        payload.clone(),
    );
    let hub = app(&state, &id);
    let result = call_tool(&hub, "get_agent_request", json!({}));
    let request = data(&result);
    assert_eq!(request["action"], "ask");
    assert_eq!(request["payload"]["question"], payload["question"]);
    assert_eq!(request["payload"]["page_text"], "A document");
    assert_eq!(request["context"]["description"], "Find a pair");
    assert_eq!(
        request["context"]["cases"],
        json!([{"input":"[2,7]","output":"9"}])
    );
    assert_eq!(
        request["context"]["board"]["scene_structure"],
        json!([{"id":"student"}])
    );
    assert_eq!(
        result["content"][1],
        json!({"type":"image","mimeType":"image/png","data":"aW1hZ2U="})
    );
    state.cfg.write().unwrap().coach.agent_send_board_image = false;
    let result = call_tool(&hub, "get_agent_request", json!({}));
    assert_eq!(result["content"].as_array().unwrap().len(), 1);
    for image in ["aW1hZ2U=", "top-secret-image", "nested-secret-image"] {
        assert!(!result.to_string().contains(image));
    }
    let run = state.agent_runs.get_request(&id).unwrap();
    assert_eq!(
        run.payload, payload,
        "filtering must not mutate the stored run"
    );
    assert_eq!(run.context.board.png.as_deref(), Some("aW1hZ2U="));
    for png in [None, Some("data:image/jpeg;base64,aW1hZ2U=")] {
        let mut task = input(AgentAction::Ask, json!({}));
        task.context.board.png = png.map(str::to_owned);
        let id = state
            .agent_runs
            .create(
                "image".into(),
                AgentResponder::App,
                task,
                EventSink::none(),
                None,
            )
            .id;
        state.cfg.write().unwrap().coach.agent_send_board_image = true;
        let result = call_tool(&app(&state, &id), "get_agent_request", json!({}));
        assert_eq!(
            result["content"].as_array().unwrap().len(),
            if png.is_some() { 2 } else { 1 }
        );
        if png.is_some() {
            assert_eq!(result["content"][1]["mimeType"], "image/jpeg");
        }
    }
}

#[test]
fn bot_inbox_and_every_per_run_tool_reject_app_and_foreign_runs() {
    let state = crate::serve::new_state(Config::default());
    let first = create(&state, AgentResponder::App, AgentAction::Viz, json!({}));
    let foreign = create(&state, AgentResponder::App, AgentAction::Viz, json!({}));
    let bot_id = create(&state, AgentResponder::Bot, AgentAction::Viz, json!({}));
    let hub = app(&state, &first);
    let bot = bots(&state);
    let waiting = data(&call_tool(&bot, "list_agent_requests", json!({})));
    assert_eq!(waiting.as_array().unwrap().len(), 1);
    assert_eq!(waiting[0]["id"], bot_id);
    assert!(waiting[0].get("payload").is_none());
    let tools = [
        ("get_agent_request", json!({})),
        ("report_step", json!({"text":"Reading"})),
        ("reply", json!({"text":"Done"})),
        ("draw_structure", program()),
        ("animate_trace", program()),
        ("annotate_region", json!({"region":"agent","text":"note"})),
        ("cite_test_case", json!({"case_index":0,"why":"pair"})),
        (
            "highlight_student_work",
            json!({"ids":["student"],"note":"pair"}),
        ),
    ];
    for (name, args) in tools {
        let mut wrong = args.clone();
        wrong["run_id"] = json!(foreign);
        assert_eq!(call_tool(&hub, name, wrong)["isError"], true, "{name}");
        let mut wrong = args.clone();
        wrong["run_id"] = json!(first);
        assert_eq!(call_tool(&bot, name, wrong)["isError"], true, "{name}");
        assert_eq!(
            call_tool(&bot, name, args)["isError"],
            true,
            "missing bot run id {name}"
        );
    }
    assert_eq!(
        call_tool(&hub, "list_agent_requests", json!({}))["isError"],
        true
    );
    assert_eq!(
        state.agent_runs.get_request(&first).unwrap().status,
        AgentRunStatus::Waiting
    );
    assert_eq!(
        state.agent_runs.get_request(&foreign).unwrap().status,
        AgentRunStatus::Waiting
    );
    assert_ne!(
        call_tool(
            &bot,
            "report_step",
            json!({"run_id":bot_id,"text":"Reading"})
        )["isError"],
        true
    );
    assert!(data(&call_tool(&bot, "list_agent_requests", json!({})))
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(
        data(&call_tool(
            &bot,
            "reply",
            json!({"run_id":bot_id,"text":"Done"})
        ))["message"],
        "Done"
    );
}

#[test]
fn tools_record_the_same_envelope_and_report_executor_rejections() {
    let state = crate::serve::new_state(Config::default());
    let id = create(&state, AgentResponder::App, AgentAction::Viz, json!({}));
    let hub = app(&state, &id);
    let mut trace = program();
    let second = trace["frames"][0].clone();
    trace["frames"].as_array_mut().unwrap().push(second);
    for (name, args) in [
        ("draw_structure", program()),
        ("animate_trace", trace),
        (
            "annotate_region",
            json!({"region":"approach","text":"Pair","tone":"confirm"}),
        ),
        ("cite_test_case", json!({"case_index":0,"why":"Pair"})),
        (
            "highlight_student_work",
            json!({"ids":["student"],"note":"Pair"}),
        ),
    ] {
        assert_eq!(data(&call_tool(&hub, name, args))["ok"], true);
        assert_eq!(call_tool(&hub, name, json!({}))["isError"], true, "{name}");
    }
    let run = state.agent_runs.get_request(&id).unwrap();
    assert_eq!(
        (
            run.envelope.programs.len(),
            run.envelope.annotations.len(),
            run.envelope.citations.len(),
            run.envelope.highlights.len()
        ),
        (2, 1, 1, 1)
    );
    assert_eq!(run.envelope.rejected.len(), 5);
    let id = create(
        &state,
        AgentResponder::App,
        AgentAction::Ask,
        json!({"surface":"whiteboard","draw":true}),
    );
    let hub = app(&state, &id);
    assert_eq!(
        data(&call_tool(
            &hub,
            "create_attachment",
            json!({"kind":"code","title":"Pair","source":"print(9)"})
        ))["ok"],
        true
    );
    assert_eq!(
        call_tool(
            &hub,
            "create_attachment",
            json!({"kind":"file","title":"Pair"})
        )["isError"],
        true
    );
    assert_eq!(
        call_tool(&hub, "cite_test_case", json!({"case_index":0,"why":"Pair"}))["isError"],
        true
    );
    assert_eq!(
        call_tool(
            &hub,
            "highlight_student_work",
            json!({"ids":["student"],"note":"Pair"})
        )["isError"],
        true
    );
    assert_eq!(
        call_tool(&hub, "draw_structure", json!({"viz":"array","frames":[]}))["isError"],
        true
    );
    let answer = data(&call_tool(&hub, "reply", json!({"text":"A pair."})));
    assert_eq!(answer["artifacts"][0]["source"], "print(9)");
}

#[test]
fn malformed_arguments_cannot_mutate_or_reach_document_io() {
    let state = crate::serve::new_state(Config::default());
    let id = create(
        &state,
        AgentResponder::App,
        AgentAction::Ask,
        json!({"surface":"annotate","document_hash":"hash","draw":true,"page_text":"A pair","highlight":"pair","marks_prose":"note"}),
    );
    let hub = app(&state, &id);
    for (name, args) in [
        ("get_current_page", json!({})),
        ("get_highlight", json!({})),
        ("list_document_marks", json!({})),
        ("save_annotation", json!({"excerpt":"pair","note":"A pair"})),
    ] {
        assert_eq!(data(&call_tool(&hub, name, args))["ok"], true);
    }
    for name in [
        "query_document_vectors",
        "query_library_vectors",
        "get_document_section",
        "lookup_reference",
        "save_annotation",
    ] {
        assert_eq!(call_tool(&hub, name, json!({}))["isError"], true, "{name}");
    }
    for (name, args) in [
        ("query_document_vectors", json!({"query":3})),
        ("query_library_vectors", json!({"query":"pair","k":99})),
        ("get_document_section", json!({"section_name":false})),
        ("lookup_reference", json!({"n":0})),
        ("save_annotation", json!({"excerpt":"pair","note":3})),
        ("report_step", json!({"text":3})),
        ("report_step", json!({"text":" "})),
        ("report_step", json!({"text":"x".repeat(1001)})),
        ("reply", json!({"text":""})),
        ("reply", json!({"text":4})),
        ("get_agent_request", json!({"run_id":3})),
        ("get_agent_request", json!({"extra":true})),
    ] {
        assert_eq!(call_tool(&hub, name, args)["isError"], true, "{name}");
    }
    for name in names(&hub) {
        assert_eq!(call_tool(&hub, &name, json!([]))["isError"], true, "{name}");
    }
    assert_eq!(
        state
            .agent_runs
            .get_request(&id)
            .unwrap()
            .envelope
            .proposed
            .len(),
        1
    );
    assert_ne!(
        state.agent_runs.get_request(&id).unwrap().status,
        AgentRunStatus::Done
    );
}

#[test]
fn terminal_runs_refuse_every_tool_and_bot_inbox_expires_without_sleeping() {
    let clock = Arc::new(AtomicU64::new(1));
    let mut state = crate::serve::new_state(Config::default());
    Arc::get_mut(&mut state).unwrap().agent_runs = Arc::new(AgentRunRegistry::with_clock({
        let clock = clock.clone();
        move || clock.load(Ordering::SeqCst)
    }));
    for terminal in ["done", "cancelled", "expired"] {
        let id = create(
            &state,
            AgentResponder::App,
            AgentAction::Ask,
            json!({"surface":"whiteboard","draw":true}),
        );
        let hub = app(&state, &id);
        let tool_names = names(&hub);
        match terminal {
            "done" => {
                state.agent_runs.reply(&id, "done").unwrap();
            }
            "cancelled" => state.agent_runs.cancel(&id).unwrap(),
            _ => clock.store(
                state.agent_runs.get_request(&id).unwrap().deadline,
                Ordering::SeqCst,
            ),
        }
        for name in tool_names {
            assert_eq!(
                call_tool(&hub, &name, json!({"text":"late"}))["isError"],
                true,
                "{terminal}: {name}"
            );
        }
        let result = super::super::dispatch(&hub, &message("tools/list", json!({}))).unwrap();
        assert!(result.get("error").is_some());
    }
    let id = create(&state, AgentResponder::Bot, AgentAction::Ask, json!({}));
    clock.store(
        state.agent_runs.get_request(&id).unwrap().deadline,
        Ordering::SeqCst,
    );
    assert_eq!(
        data(&call_tool(&bots(&state), "list_agent_requests", json!({}))),
        json!([])
    );
    assert_eq!(
        state.agent_runs.get_request(&id).unwrap().status,
        AgentRunStatus::Failed
    );
}

#[test]
fn structured_replies_and_draw_review_replacement_use_agent_api_validation() {
    let state = crate::serve::new_state(Config::default());
    for (action, text) in [
        (
            AgentAction::Review,
            r#"{"verdict":"on_track","understood_approach":"pair"}"#,
        ),
        (
            AgentAction::Lazy,
            r#"{"filled_code":"print(9)","note":"pair"}"#,
        ),
        (AgentAction::DrawReview, r#"{"ok":false,"issues":["fix"]}"#),
    ] {
        let id = create(
            &state,
            AgentResponder::App,
            action,
            json!({"program":{"id":"original"}}),
        );
        let hub = app(&state, &id);
        assert_eq!(
            call_tool(&hub, "reply", json!({"text":"bad json"}))["isError"],
            true
        );
        if action == AgentAction::DrawReview {
            assert_eq!(
                data(&call_tool(&hub, "draw_structure", program()))["ok"],
                true
            );
            assert_eq!(call_tool(&hub, "animate_trace", program())["isError"], true);
        } else {
            assert_eq!(
                call_tool(&hub, "draw_structure", program())["isError"],
                true
            );
        }
        let result = data(&call_tool(&hub, "reply", json!({"text":text})));
        assert_eq!(result["provider"], "app");
        if action == AgentAction::DrawReview {
            assert_eq!(result["program"]["id"], "original");
        }
        assert_eq!(
            state.agent_runs.get_request(&id).unwrap().status,
            AgentRunStatus::Done
        );
    }
}

#[test]
fn settings_and_both_cli_scope_inputs_are_explicit_and_fail_closed() {
    let cfg: Config = toml::from_str("").unwrap();
    assert!(cfg.coach.agent_mcp_tools && cfg.coach.agent_send_board_image);
    let state = crate::serve::new_state(cfg);
    let id = create(&state, AgentResponder::App, AgentAction::Ask, json!({}));
    let expected = AgentScope::app(id.clone()).unwrap();
    assert_eq!(scope_from_values(None, None).unwrap(), None);
    assert_eq!(
        scope_from_values(Some(id.clone()), None).unwrap(),
        Some(expected.clone())
    );
    assert_eq!(
        scope_from_values(None, Some("true".into())).unwrap(),
        Some(AgentScope::BotInbox)
    );
    for value in [
        "",
        "../escape",
        "agent-nope",
        "agent-0000000000000000000000000000000/",
    ] {
        assert!(scope_from_values(Some(value.into()), None).is_err());
    }
    assert!(scope_from_values(Some(id.clone()), Some("1".into())).is_err());
    assert!(scope_from_values(None, Some("oops".into())).is_err());
    let job_hub =
        super::super::AppFootnoteHub::new(FakeClient(state.clone()), Some(id.clone()), false)
            .unwrap();
    assert_eq!(job_hub.agent_scope(), Some(expected));
    assert_eq!(names(&job_hub), names(&app(&state, &id)));
    let job_bots =
        super::super::AppFootnoteHub::new(FakeClient(state.clone()), Some(BOTS_JOB.into()), false)
            .unwrap();
    assert!(names(&job_bots).contains(&"list_agent_requests".into()));
    let read_only =
        super::super::AppFootnoteHub::new(FakeClient(state.clone()), Some(id.clone()), true)
            .unwrap();
    assert_ne!(
        call_tool(&read_only, "get_agent_request", json!({}))["isError"],
        true
    );
    assert_eq!(
        call_tool(&read_only, "reply", json!({"text":"done"}))["isError"],
        true
    );
    state
        .cfg
        .write()
        .unwrap()
        .set("coach.agent_mcp_tools", "false")
        .unwrap();
    for hub in [&app(&state, &id) as &dyn FootnoteHub, &bots(&state)] {
        assert!(names(hub).is_empty());
        for name in [
            "get_agent_request",
            "list_agent_requests",
            "reply",
            "draw_structure",
        ] {
            assert_eq!(call_tool(hub, name, json!({}))["isError"], true);
        }
    }
    let mut cfg = state.cfg_snapshot();
    cfg.set("coach.agent_send_board_image", "false").unwrap();
    let roundtrip: Config = toml::from_str(&toml::to_string(&cfg).unwrap()).unwrap();
    assert!(!roundtrip.coach.agent_mcp_tools && !roundtrip.coach.agent_send_board_image);
}

#[test]
fn scoped_transports_reject_attempts_to_replace_the_connection_scope() {
    let state = crate::serve::new_state(Config::default());
    let first = create(&state, AgentResponder::App, AgentAction::Ask, json!({}));
    let other = create(&state, AgentResponder::App, AgentAction::Ask, json!({}));
    let hub = app(&state, &first);
    let job_hub =
        super::super::AppFootnoteHub::new(FakeClient(state.clone()), Some(first), false).unwrap();
    for connection in [&hub as &dyn FootnoteHub, &job_hub] {
        for scope in [
            AgentScope::app(other.clone()).unwrap(),
            AgentScope::BotInbox,
        ] {
            assert!(connection
                .call(
                    "POST",
                    ROUTE,
                    Some(json!({
                        "scope":scope,"method":"tools/list","params":{}
                    }))
                )
                .is_err());
        }
        assert!(connection.call("POST", ROUTE, None).is_err());
        assert!(connection.call("GET", "/annotation-jobs", None).is_err());
    }
    assert_eq!(
        call_tool(
            &bots(&state),
            "get_agent_request",
            json!({
                "run_id":"agent-00000000000000000000000000000000"
            })
        )["isError"],
        true
    );
}

#[test]
fn document_and_pad_tool_schemas_match_actual_api_requests_with_optional_search() {
    let mut cfg = Config::default();
    cfg.serve.searxng_url = "http://unused.invalid".into();
    for draw in [false, true] {
        for document in [false, true] {
            let api = Api {
                calls: Cell::new(0),
                schemas: RefCell::new(vec![]),
            };
            // Skip scripted tool calls; capture the API's request without I/O.
            api.calls.set(1);
            let payload = if document {
                json!({"surface":"annotate","document_hash":"hash","draw":draw})
            } else {
                json!({"surface":"whiteboard","draw":draw})
            };
            let mut task = input(AgentAction::Ask, payload);
            task.cfg = cfg.clone();
            if document {
                let context = crate::llm::docs::AskContext {
                    document_hash: Some("hash".into()),
                    page: Some(1),
                    highlight: String::new(),
                    page_text: "A pair".into(),
                    marks_prose: String::new(),
                    retrieved: String::new(),
                };
                crate::llm::docs::run_document_ask(
                    &api,
                    &cfg,
                    "Answer",
                    "Pair?".into(),
                    vec![],
                    &context,
                    &EventSink::none(),
                    false,
                    None,
                    draw,
                )
                .unwrap();
            } else {
                crate::llm::docs::run_pad_ask(
                    &api,
                    &cfg,
                    "Answer",
                    "Pair?".into(),
                    vec![],
                    &EventSink::none(),
                    false,
                    None,
                    draw,
                )
                .unwrap();
            }
            assert_eq!(task.tool_schemas(), *api.schemas.borrow());
        }
    }
}

#[tokio::test]
async fn agent_transport_route_is_available_in_process_without_a_network() {
    let state = crate::serve::new_state(Config::default());
    let id = create(
        &state,
        AgentResponder::App,
        AgentAction::Ask,
        json!({"question":"pair"}),
    );
    let request = json!({"scope":AgentScope::app(id).unwrap(),"method":"tools/call","params":{"name":"get_agent_request","arguments":{}}});
    let (status, body, _) = crate::serve::dispatch(
        state,
        "POST",
        ROUTE,
        serde_json::to_vec(&request).unwrap(),
        Some("application/json"),
    )
    .await
    .unwrap();
    assert_eq!(status, 200);
    assert_eq!(
        data(&serde_json::from_slice(&body).unwrap())["payload"]["question"],
        "pair"
    );
}

struct Api {
    calls: Cell<usize>,
    schemas: RefCell<Vec<Value>>,
}

impl LlmProvider for Api {
    fn label(&self) -> String {
        "fake-api".into()
    }
    fn chat(&self, _: &str, _: &str) -> Result<String> {
        unreachable!()
    }
    fn chat_ex(&self, request: &ChatRequest) -> Result<ChatReply> {
        self.schemas.replace(request.tools.clone());
        let first = self.calls.replace(self.calls.get() + 1) == 0;
        Ok(ChatReply {
            content: if first {
                String::new()
            } else {
                "A pair.".into()
            },
            reasoning: String::new(),
            tool_calls: if first {
                vec![
                    ToolCall {
                        name: "draw_structure".into(),
                        arguments: program(),
                    },
                    ToolCall {
                        name: "draw_structure".into(),
                        arguments: json!({"viz":"array","frames":[]}),
                    },
                    ToolCall {
                        name: "create_attachment".into(),
                        arguments: json!({"kind":"code","title":"Pair","source":"print(9)"}),
                    },
                ]
            } else {
                vec![]
            },
        })
    }
}

#[tokio::test]
async fn socket_run_driven_by_mcp_matches_real_api_tool_events_stages_and_result() {
    socket_mcp_contract(false).await;
}

#[tokio::test]
async fn socket_bot_run_answered_through_general_mcp_matches_api_frames() {
    socket_mcp_contract(true).await;
}

async fn socket_mcp_contract(general: bool) {
    use crate::serve::ws::{drive_channels, ServerFrame};
    use std::time::Duration;
    use tokio::sync::mpsc;
    let mut cfg = Config::default();
    cfg.llm.modes.review = "bot".into();
    let state = crate::serve::new_state(cfg);
    let hub: Box<dyn FootnoteHub> = if general {
        Box::new(FakeClient(state.clone()))
    } else {
        Box::new(bots(&state))
    };
    let hub = hub.as_ref();
    let (incoming, rx) = mpsc::unbounded_channel();
    let (tx, mut frames) = mpsc::unbounded_channel::<ServerFrame>();
    let driver = tokio::spawn(drive_channels(state.clone(), rx, tx));
    incoming.send(json!({"type":"run","request_id":"mcp","action":"ask","payload":{
        "surface":"whiteboard","question":"show a pair","draw":true,"board":{"scene_structure":[{"id":"student"}]}
    }}).to_string()).unwrap();
    for stage in ["received", "ask"] {
        let frame = tokio::time::timeout(Duration::from_secs(3), frames.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(serde_json::to_value(frame).unwrap()["stage"], stage);
    }
    let run_id = data(&call_tool(hub, "list_agent_requests", json!({})))[0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        data(&call_tool(
            hub,
            "get_agent_request",
            json!({"run_id":run_id})
        ))["request_id"],
        "mcp"
    );
    assert_ne!(
        call_tool(
            hub,
            "report_step",
            json!({"run_id":run_id,"text":"Reading your board"})
        )["isError"],
        true
    );
    let step = serde_json::to_value(frames.recv().await.unwrap()).unwrap();
    assert_eq!(
        step,
        json!({"type":"stage","request_id":"mcp","stage":"agent_step","detail":"Reading your board"})
    );
    let api = Api {
        calls: Cell::new(0),
        schemas: RefCell::new(vec![]),
    };
    let events = Arc::new(Mutex::new(vec![]));
    let capture = events.clone();
    let api_events = EventSink::new(move |event| capture.lock().unwrap().push(event));
    let outcome = crate::llm::docs::run_pad_ask(
        &api,
        &Config::default(),
        crate::llm::coach::PAD_ASK_SYSTEM_PROMPT,
        "show a pair".into(),
        vec![],
        &api_events,
        false,
        None,
        true,
    )
    .unwrap();
    // Assert the attachment schema really is the one advertised by the API.
    let api_schemas = api.schemas.borrow().clone();
    let actual = state.agent_runs.get_request(&run_id).unwrap();
    assert_eq!(&actual.tool_schemas, &api_schemas);
    for (name, mut args, success) in [
        ("draw_structure", program(), true),
        ("draw_structure", json!({"viz":"array","frames":[]}), false),
        (
            "create_attachment",
            json!({"kind":"code","title":"Pair","source":"print(9)"}),
            true,
        ),
    ] {
        args["run_id"] = json!(run_id);
        let result = call_tool(hub, name, args);
        assert_eq!(result["isError"] == true, !success);
    }
    let expected_events = events.lock().unwrap().clone();
    for event in expected_events {
        let CoachEvent::Tool {
            name,
            status,
            summary,
            reason,
        } = event
        else {
            panic!("unexpected API event")
        };
        let mut expected = json!({"type":"tool_event","request_id":"mcp","name":name,"status":status.as_str(),"summary":summary});
        if let Some(reason) = reason {
            expected["reason"] = json!(reason);
        }
        let actual = tokio::time::timeout(Duration::from_secs(3), frames.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(serde_json::to_value(actual).unwrap(), expected);
    }
    call_tool(hub, "reply", json!({"run_id":run_id,"text":outcome.reply}));
    assert_eq!(
        serde_json::to_value(frames.recv().await.unwrap()).unwrap(),
        json!({"type":"stage","request_id":"mcp","stage":"done","detail":""})
    );
    let expected = serde_json::to_value(crate::serve::coach::AskEnvelope {
        task_id: crate::pad::WHITEBOARD_TASK_ID.into(),
        provider: "bot".into(),
        reply: outcome.reply,
        reasoning: outcome.reasoning,
        programs: outcome.programs,
        artifacts: outcome.artifacts,
        proposed_annotations: outcome.proposed,
        process_events: vec![],
    })
    .unwrap();
    assert_eq!(
        serde_json::to_value(frames.recv().await.unwrap()).unwrap(),
        json!({"type":"result","request_id":"mcp","action":"ask","body":expected})
    );
    assert!(frames.try_recv().is_err(), "no reasoning or extra frames");
    drop(incoming);
    tokio::time::timeout(Duration::from_secs(3), driver)
        .await
        .unwrap()
        .unwrap();
}

#[test]
fn general_inbox_gate_is_live_bot_only_and_restores_the_exact_original_list() {
    let state = crate::serve::new_state(Config::default());
    let hub = FakeClient(state.clone());
    let original = rpc(&hub, "tools/list", json!({}));
    assert_eq!(original, json!({"tools":super::super::tool_list()}));
    let bot_id = create(&state, AgentResponder::Bot, AgentAction::Viz, json!({}));
    let app_id = create(&state, AgentResponder::App, AgentAction::Viz, json!({}));
    let closed = call_tool(&hub, "list_agent_requests", json!({}));
    assert_eq!(closed["isError"], true);
    assert!(closed["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("inbox is disabled"));
    for mode in crate::config::COACH_MODES {
        state
            .cfg
            .write()
            .unwrap()
            .set(&format!("llm.modes.{mode}"), "bot")
            .unwrap();
        let offered = rpc(&hub, "tools/list", json!({}));
        let bot_tools = rpc(&bots(&state), "tools/list", json!({}));
        let mut expected = super::super::tool_list();
        expected.extend(bot_tools["tools"].as_array().unwrap().clone());
        assert_eq!(offered, json!({"tools":expected}));
        for tool in bot_tools["tools"].as_array().unwrap() {
            assert!(COACH_TOOLS.contains(&tool["name"].as_str().unwrap()));
        }
        let waiting = data(&call_tool(&hub, "list_agent_requests", json!({})));
        assert_eq!(waiting.as_array().unwrap().len(), 1);
        assert_eq!(waiting[0]["id"], bot_id);
        assert_eq!(
            call_tool(&hub, "get_agent_request", json!({"run_id":app_id}))["isError"],
            true
        );
        state.cfg.write().unwrap().coach.agent_mcp_tools = false;
        assert_eq!(rpc(&hub, "tools/list", json!({})), original);
        assert_eq!(
            call_tool(
                &hub,
                "report_step",
                json!({"run_id":bot_id,"text":"Reading"})
            )["isError"],
            true
        );
        state.cfg.write().unwrap().coach.agent_mcp_tools = true;
        state
            .cfg
            .write()
            .unwrap()
            .set(&format!("llm.modes.{mode}"), "local")
            .unwrap();
        assert_eq!(rpc(&hub, "tools/list", json!({})), original);
        assert_eq!(
            call_tool(&hub, "reply", json!({"run_id":bot_id,"text":"Late"}))["isError"],
            true
        );
    }
    // Enforce the provider gate inside the hub too, even if it closed after discovery.
    let result = general_request(
        &hub,
        "tools/call",
        json!({"name":"get_agent_request","arguments":{"run_id":bot_id}}),
    )
    .unwrap();
    assert_eq!(result["isError"], true);
}

#[test]
fn general_inbox_instructions_and_prompts_follow_the_gate_without_changing_old_wording() {
    let state = crate::serve::new_state(Config::default());
    let hub = FakeClient(state.clone());
    let instructions = super::super::server_instructions();
    let prompts = rpc(&hub, "prompts/list", json!({}));
    for open in [false, true, false] {
        state.cfg.write().unwrap().llm.modes.review = if open { "bot" } else { "local" }.into();
        let init = rpc(&hub, "initialize", json!({}));
        assert_eq!(
            init["instructions"],
            if open {
                format!("{instructions}\n\n{}", super::super::COACH_WORKFLOW)
            } else {
                instructions.clone()
            }
        );
        let listed = rpc(&hub, "prompts/list", json!({}));
        if open {
            assert_eq!(listed["prompts"].as_array().unwrap().len(), 3);
        } else {
            assert_eq!(listed, prompts);
        }
        for (name, _, _, text) in super::super::PROMPTS {
            let prompt = rpc(&hub, "prompts/get", json!({"name":name}));
            assert_eq!(
                prompt["messages"][0]["content"]["text"],
                if open {
                    format!("{text}\n\n{}", super::super::COACH_WORKFLOW)
                } else {
                    text.to_string()
                }
            );
        }
        let coach = super::super::dispatch(
            &hub,
            &message("prompts/get", json!({"name":"answer_coach_requests"})),
        )
        .unwrap();
        if open {
            let text = coach["result"]["messages"][0]["content"]["text"]
                .as_str()
                .unwrap();
            for word in [
                "once",
                "list_agent_requests",
                "get_agent_request",
                "allowed tools",
                "report_step",
                "reply",
                "full solution",
            ] {
                assert!(text.contains(word), "{word}");
            }
        } else {
            assert_eq!(coach["error"]["code"], -32602);
        }
    }
    let id = create(&state, AgentResponder::Bot, AgentAction::Ask, json!({}));
    state.cfg.write().unwrap().llm.modes.review = "bot".into();
    let request = data(&call_tool(&hub, "get_agent_request", json!({"run_id":id})));
    assert_eq!(
        request["answer_guidance"],
        crate::llm::coach::ASK_SYSTEM_PROMPT
    );
}

#[tokio::test]
async fn general_http_adapter_observes_provider_changes_without_a_listener() {
    use axum::{
        body::{to_bytes, Body},
        http::Request,
    };
    use tower::ServiceExt;
    let state = crate::serve::new_state(Config::default());
    let router = super::super::http_router(
        Arc::new(FakeClient(state.clone())),
        "127.0.0.1:7879".parse().unwrap(),
        "test-token-with-at-least-32-characters".into(),
    );
    let id = create(&state, AgentResponder::Bot, AgentAction::Ask, json!({}));
    for open in [false, true, false] {
        state.cfg.write().unwrap().llm.modes.review = if open { "bot" } else { "local" }.into();
        for (method, params) in [
            ("tools/list", json!({})),
            (
                "tools/call",
                json!({"name":"get_agent_request","arguments":{"run_id":id}}),
            ),
        ] {
            let response = router
                .clone()
                .oneshot(
                    Request::post("/mcp")
                        .header(
                            "authorization",
                            "Bearer test-token-with-at-least-32-characters",
                        )
                        .header("content-type", "application/json")
                        .body(Body::from(message(method, params).to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), 200);
            let body = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
            let result = &serde_json::from_slice::<Value>(&body).unwrap()["result"];
            if method == "tools/list" {
                assert_eq!(
                    result["tools"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|tool| tool["name"] == "list_agent_requests"),
                    open
                );
            } else {
                assert_eq!(result["isError"] == true, !open);
            }
        }
    }
}

#[tokio::test]
async fn socket_bot_deadline_uses_the_setting_and_refuses_late_general_mcp_replies() {
    use crate::serve::ws::{drive_channels, ServerFrame};
    use std::time::Duration;
    use tokio::sync::mpsc;
    let clock = Arc::new(AtomicU64::new(1000));
    let mut cfg = Config::default();
    cfg.llm.modes.review = "bot".into();
    cfg.set("coach.agent_bot_timeout_secs", "60").unwrap();
    let mut state = crate::serve::new_state(cfg);
    Arc::get_mut(&mut state).unwrap().agent_runs = Arc::new(AgentRunRegistry::with_clock({
        let clock = clock.clone();
        move || clock.load(Ordering::SeqCst)
    }));
    let hub = FakeClient(state.clone());
    let (incoming, rx) = mpsc::unbounded_channel();
    let (tx, mut frames) = mpsc::unbounded_channel::<ServerFrame>();
    let driver = tokio::spawn(drive_channels(state.clone(), rx, tx));
    incoming
        .send(
            json!({"type":"run","request_id":"deadline","action":"ask","payload":{
        "surface":"whiteboard","question":"A hint?"}})
            .to_string(),
        )
        .unwrap();
    for stage in ["received", "ask"] {
        let frame = tokio::time::timeout(Duration::from_secs(3), frames.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(serde_json::to_value(frame).unwrap()["stage"], stage);
    }
    let waiting = data(&call_tool(&hub, "list_agent_requests", json!({})));
    let id = waiting[0]["id"].as_str().unwrap();
    assert_eq!(waiting[0]["created_at"], 1000);
    assert_eq!(waiting[0]["deadline"], 61_000);
    state.cfg.write().unwrap().coach.agent_bot_timeout_secs = 600;
    assert_eq!(state.agent_runs.get_request(id).unwrap().deadline, 61_000);
    clock.store(61_000, Ordering::SeqCst);
    // A call observes the deadline itself, even before the socket's timer wakes.
    assert_eq!(
        call_tool(&hub, "reply", json!({"run_id":id,"text":"Late answer"}))["isError"],
        true
    );
    let frame = serde_json::to_value(
        tokio::time::timeout(Duration::from_secs(3), frames.recv())
            .await
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(frame["type"], "error");
    assert_eq!(frame["request_id"], "deadline");
    assert!(frame["message"]
        .as_str()
        .unwrap()
        .contains("deadline expired"));
    assert!(data(&call_tool(&hub, "list_agent_requests", json!({})))
        .as_array()
        .unwrap()
        .is_empty());
    drop(incoming);
    tokio::time::timeout(Duration::from_secs(3), driver)
        .await
        .unwrap()
        .unwrap();
}
