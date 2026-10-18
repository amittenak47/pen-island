//! Fixed inputs and literal snapshots captured before the executor extraction.

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::llm::coach::{CoachEvent, EventSink};
use crate::llm::ToolCall;

pub fn call(name: &str, arguments: Value) -> ToolCall {
    ToolCall {
        name: name.into(),
        arguments,
    }
}

pub fn script() -> Vec<ToolCall> {
    let diagram = json!({"viz":"array", "id":"nums", "title":"  Numbers  ",
        "frames":[{"label":"start", "cells":[2,7], "entries":[]}]});
    let trace = json!({"viz":"array", "id":"walk", "frames":[
        {"label":"first", "cells":[2,7], "pointers":{"i":0}},
        {"label":"next", "cells":[2,7], "pointers":{"i":1}}]});
    let mut calls = vec![
        call("draw_structure", diagram.clone()),
        call("animate_trace", trace),
        call(
            "annotate_region",
            json!({"region":"approach", "text":"Check the pair", "tone":"hint"}),
        ),
        call(
            "cite_test_case",
            json!({"case_index":0, "why":"Uses the real sample"}),
        ),
        call(
            "highlight_student_work",
            json!({"ids":["student", "missing"], "note":"Check this step"}),
        ),
        call("draw_structure", json!({"frames":"bad"})),
        call("draw_structure", json!({"viz":"hypercube"})),
        call("draw_structure", json!({"viz":"array", "frames":[]})),
        call(
            "animate_trace",
            json!({"viz":"array", "frames":vec![json!({"cells":[1]});41]}),
        ),
        call(
            "animate_trace",
            json!({"viz":"hashmap", "frames":[{"pointers":{"i":0}, "cells":[{},null,[]]}]}),
        ),
        call("annotate_region", json!({"text":"  "})),
        call("annotate_region", json!({"text":7})),
        call("cite_test_case", json!({"case_index":99})),
        call("cite_test_case", json!({"case_index":-1})),
        call("cite_test_case", json!({})),
        call(
            "highlight_student_work",
            json!({"ids":["missing"], "note":"Unverifiable"}),
        ),
        call(
            "highlight_student_work",
            json!({"ids":["student"], "note":"  "}),
        ),
        call("highlight_student_work", json!({"ids":"bad"})),
        call(
            "highlight_student_work",
            json!({"ids":[1,"student", "student-longer", "stud", "student", "student", "student", "missing"], "note":"é".repeat(241)}),
        ),
        call("teleport", json!({})),
        call("get_current_page", json!({})),
        call("get_highlight", json!({})),
        call("list_document_marks", json!({})),
        call(
            "save_annotation",
            json!({"excerpt":"pair", "note":"Check both", "tags":["test",1], "page":3, "links":["local",false]}),
        ),
        call("save_annotation", json!({"note":1})),
        call(
            "search_web",
            json!({"query":"unused: search is not configured"}),
        ),
        call(
            "create_attachment",
            json!({"kind":"filesystem", "title":"bad"}),
        ),
        call("create_attachment", json!({"kind":"code", "title":" "})),
        call(
            "create_attachment",
            json!({"kind":"code", "title":"é".repeat(129)}),
        ),
        call(
            "create_attachment",
            json!({"kind":"code", "title":"large", "source":"x".repeat(512_001)}),
        ),
        call(
            "create_attachment",
            json!({"kind":"whiteboard", "title":"large", "programs":vec![diagram.clone();9]}),
        ),
        call(
            "create_attachment",
            json!({"kind":"code", "title":"mixed", "programs":[diagram.clone()]}),
        ),
        call(
            "create_attachment",
            json!({"kind":"whiteboard", "title":"mixed", "source":"text"}),
        ),
        call(
            "create_attachment",
            json!({"kind":"whiteboard", "title":"dupes", "programs":[diagram.clone(),diagram.clone()]}),
        ),
        call(
            "create_attachment",
            json!({"kind":"whiteboard", "title":"invalid", "programs":[{"viz":"array"}]}),
        ),
        call(
            "create_attachment",
            json!({"kind":"code", "title":"extra", "path":"forbidden"}),
        ),
        call("create_attachment", json!({"kind":"code"})),
        call(
            "create_attachment",
            json!({"kind":"code", "title":"answer.py", "source":"print(1)"}),
        ),
        call(
            "create_attachment",
            json!({"kind":"markdown", "title":"Note", "source":"# Pair"}),
        ),
        call(
            "create_attachment",
            json!({"kind":"whiteboard", "title":"Board", "programs":[diagram]}),
        ),
    ];
    for i in 0..6 {
        calls.push(call(
            "create_attachment",
            json!({"kind":"code", "title":format!("extra-{i}")}),
        ));
    }
    // Validation precedes the run limit, even once eight attachments are queued.
    calls.push(call(
        "create_attachment",
        json!({"kind":"code", "title":""}),
    ));
    calls
}

pub fn recorder() -> (EventSink, Arc<Mutex<Vec<Value>>>) {
    let log = Arc::new(Mutex::new(Vec::new()));
    let captured = Arc::clone(&log);
    let events = EventSink::new(move |event| {
        let value = match event {
            CoachEvent::Tool {
                name,
                status,
                summary,
                reason,
            } => json!({
                "type":"tool_event", "name":name, "status":status.as_str(), "summary":summary, "reason":reason
            }),
            CoachEvent::Stage {
                stage,
                detail,
                update_id,
            } => json!({"stage":stage,"detail":detail,"update_id":update_id}),
            CoachEvent::Reasoning { text } => json!({"reasoning":text}),
        };
        captured.lock().unwrap().push(value);
    });
    (events, log)
}

pub fn assert_snapshot(name: &str, actual: Value, expected: &str) {
    let expected: Value = serde_json::from_str(expected).unwrap();
    assert_eq!(actual, expected, "{name}");
}
