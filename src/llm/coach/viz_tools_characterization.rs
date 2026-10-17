use serde_json::json;

use super::*;
use crate::llm::tool_characterization::{assert_snapshot, recorder, script};
use crate::problem::IoCase;

#[test]
fn viz_tool_characterization() {
    let board = BoardSnapshot {
        scene_structure: Some(json!([{"id":"student"}])),
        ..Default::default()
    };
    let cases = vec![IoCase {
        input: "[2,7], 9".into(),
        output: "[0,1]".into(),
    }];
    let reply = ChatReply {
        content: "Drawing.".into(),
        tool_calls: script(),
        ..Default::default()
    };
    let (events, log) = recorder();
    let envelope = collect_envelope(
        "sample",
        "characterization".into(),
        &reply,
        &cases,
        &board,
        &events,
    );
    assert_snapshot(
        "viz",
        json!({"envelope":envelope, "events":*log.lock().unwrap()}),
        include_str!("tool_snapshots/viz.json"),
    );
}
