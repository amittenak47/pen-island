use std::cell::{Cell, RefCell};

use serde_json::{json, Value};

use super::*;
use crate::llm::tool_characterization::{assert_snapshot, recorder, script};
use crate::llm::ChatReply;

#[derive(Default)]
struct Scripted {
    turn: Cell<usize>,
    feedback: RefCell<Vec<String>>,
    offered: RefCell<Vec<Vec<Value>>>,
}

impl LlmProvider for Scripted {
    fn label(&self) -> String {
        "characterization".into()
    }
    fn chat(&self, _: &str, _: &str) -> Result<String> {
        unreachable!()
    }
    fn chat_ex(&self, request: &ChatRequest) -> Result<ChatReply> {
        self.offered.borrow_mut().push(
            request
                .tools
                .iter()
                .map(|tool| tool["function"]["name"].clone())
                .collect(),
        );
        let turn = self.turn.get();
        self.turn.set(turn + 1);
        if turn > 0 {
            self.feedback
                .borrow_mut()
                .push(request.messages.last().unwrap().content.clone());
        }
        let calls = script();
        Ok(match turn {
            0 => ChatReply {
                tool_calls: calls[..38].to_vec(),
                ..Default::default()
            },
            1 => ChatReply {
                tool_calls: calls[38..].to_vec(),
                ..Default::default()
            },
            2 => ChatReply {
                content: "  Finished.  ".into(),
                ..Default::default()
            },
            _ => panic!("unexpected model turn"),
        })
    }
}

#[test]
fn document_tool_characterization() {
    let ctx = AskContext {
        document_hash: None,
        page: Some(3),
        highlight: "  pair  ".into(),
        page_text: "  Page text  ".into(),
        marks_prose: "ink and notes".into(),
        retrieved: String::new(),
    };
    let mut runs = Vec::new();
    for draw in [true, false] {
        let provider = Scripted::default();
        let (events, log) = recorder();
        let out = run_document_ask(
            &provider,
            &Config::default(),
            "Tutor",
            "Question".into(),
            vec![],
            &ctx,
            &events,
            false,
            None,
            draw,
        )
        .unwrap();
        runs.push(json!({"draw":draw, "envelope":{
            "artifacts":out.artifacts, "reasoning":out.reasoning, "reply":out.reply,
            "proposed":out.proposed, "programs":out.programs
        }, "events":*log.lock().unwrap(), "feedback":*provider.feedback.borrow(),
            "offered":*provider.offered.borrow()}));
    }
    assert_snapshot(
        "document",
        json!(runs),
        include_str!("tool_snapshots/document.json"),
    );
}
