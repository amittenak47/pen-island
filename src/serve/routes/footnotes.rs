//! Footnote inbox routes. The device creates and acks; the MCP client lists and submits.

use axum::extract::Path as UrlPath;
use axum::extract::Query;
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::Value;

use super::{blocking, AppError};
use crate::pads::footnotes::{self, FootnoteFail, FootnoteLink, NewFootnoteRequest};

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    #[serde(default)]
    pub status: Option<String>,
}

pub async fn create_footnote_request(Json(body): Json<Value>) -> Result<Json<footnotes::FootnoteRequest>, AppError> {
    let parsed: NewFootnoteRequest = serde_json::from_value(body)
        .map_err(|err| AppError::bad_request(anyhow::anyhow!("invalid footnote request: {err}")))?;
    let now = now_ms();
    let row = blocking(move || {
        let conn = crate::pads::open(&crate::pads::db_path()?)?;
        create_on(&conn, parsed, now)
    })
    .await
    .map_err(map_store_error)?;
    crate::serve::footnote_answers::schedule(row.clone());
    if row.answer_mode == footnotes::AnswerMode::App && row.status == "pending" {
        crate::serve::assistant_runner::schedule(None);
    }
    Ok(Json(row))
}

pub async fn list_footnote_requests(
    Query(query): Query<ListQuery>,
) -> Result<Json<Vec<footnotes::FootnoteRequestSummary>>, AppError> {
    if query.status.as_deref().is_some_and(|status| status != "pending") {
        return Err(AppError::bad_request(anyhow::anyhow!("status must be pending")));
    }
    let rows = blocking(|| {
        let conn = crate::pads::open(&crate::pads::db_path()?)?;
        footnotes::list_pending(&conn).map_err(into_anyhow)
    })
    .await?;
    Ok(Json(rows))
}

pub async fn get_footnote_request(
    UrlPath(id): UrlPath<String>,
) -> Result<Json<footnotes::FootnoteRequest>, AppError> {
    let row = blocking(move || {
        let conn = crate::pads::open(&crate::pads::db_path()?)?;
        footnotes::get_request(&conn, &id)
            .map_err(into_anyhow)?
            .ok_or_else(|| anyhow::anyhow!("missing:unknown footnote request"))
    })
    .await
    .map_err(map_store_error)?;
    Ok(Json(row))
}

pub async fn submit_footnote_result(
    UrlPath(id): UrlPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, AppError> {
    let (notes, links) = parse_result(&body)?;
    let rich = parse_rich(&body)?;
    let submission = footnotes::FootnoteSubmission { notes, links, ..rich };
    let now = now_ms();
    blocking(move || {
        let conn = crate::pads::open(&crate::pads::db_path()?)?;
        footnotes::submit_answer(&conn, &id, &submission, now).map_err(into_anyhow)
    })
    .await
    .map_err(map_store_error)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn ack_footnote_request(UrlPath(id): UrlPath<String>) -> Result<Json<Value>, AppError> {
    let now = now_ms();
    blocking(move || {
        let conn = crate::pads::open(&crate::pads::db_path()?)?;
        footnotes::ack_request(&conn, &id, now).map_err(into_anyhow)
    })
    .await
    .map_err(map_store_error)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Debug, Deserialize)]
pub struct ResultsQuery {
    #[serde(default)]
    pub device: Option<String>,
}

/// `{ "footnote_results": [...] }` for one device. An empty or oversized device
/// is a 400; `list_results` itself returns nothing for those, which pad sync
/// still relies on.
fn footnote_results_on(conn: &rusqlite::Connection, device: &str) -> Result<Value, AppError> {
    if device.is_empty() || device.chars().count() > 200 {
        return Err(AppError::bad_request(anyhow::anyhow!("device is required")));
    }
    let results = footnotes::list_results(conn, Some(device))
        .map_err(|err| map_store_error(AppError::from(into_anyhow(err))))?;
    Ok(serde_json::json!({ "footnote_results": results }))
}

pub async fn footnote_results(Query(query): Query<ResultsQuery>) -> Result<Json<Value>, AppError> {
    let device = query.device.unwrap_or_default();
    let pending_device = device.clone();
    // `blocking` flattens every failure to 500. A rejected device has to leave
    // the worker still marked 400.
    let value = tokio::task::spawn_blocking(move || -> Result<Value, AppError> {
        let conn = crate::pads::open(&crate::pads::db_path()?)?;
        footnote_results_on(&conn, &device)
    })
    .await
    .map_err(|err| AppError::from(anyhow::anyhow!("a background task panicked: {err}")))??;
    crate::serve::footnote_answers::resume(Some(pending_device));
    Ok(Json(value))
}

fn create_on(
    conn: &rusqlite::Connection,
    body: NewFootnoteRequest,
    now: i64,
) -> anyhow::Result<footnotes::FootnoteRequest> {
    footnotes::create_request(conn, body, now).map_err(into_anyhow)
}

fn parse_result(body: &Value) -> Result<(Vec<String>, Vec<FootnoteLink>), AppError> {
    let notes = body.get("notes").and_then(Value::as_array).ok_or_else(|| {
        AppError::bad_request(anyhow::anyhow!("notes must be an array of strings"))
    })?;
    let mut texts = Vec::with_capacity(notes.len());
    for note in notes {
        let Some(text) = note.as_str() else {
            return Err(AppError::bad_request(anyhow::anyhow!("notes must be an array of strings")));
        };
        texts.push(text.to_string());
    }
    let mut links = Vec::new();
    if let Some(raw) = body.get("links") {
        if raw.is_null() {
            // Absent and null both mean no links.
        } else if let Some(entries) = raw.as_array() {
            for entry in entries {
                let url = entry.get("url").and_then(Value::as_str).unwrap_or("").to_string();
                let title = entry.get("title").and_then(Value::as_str).map(str::to_string);
                if url.is_empty() && title.is_none() && !entry.is_object() {
                    return Err(AppError::bad_request(anyhow::anyhow!("links must be objects")));
                }
                links.push(FootnoteLink { title, url });
            }
        } else {
            return Err(AppError::bad_request(anyhow::anyhow!("links must be an array")));
        }
    }
    Ok((texts, links))
}

/// Title, palette color, marks and workspace links; all optional.
fn parse_rich(body: &Value) -> Result<footnotes::FootnoteSubmission, AppError> {
    #[derive(serde::Deserialize, Default)]
    struct Rich {
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        color: Option<u8>,
        #[serde(default)]
        marks: Vec<footnotes::FootnoteMark>,
        #[serde(default)]
        workspace_links: Vec<String>,
    }
    let pick = |key: &str| body.get(key).filter(|value| !value.is_null()).cloned();
    let rich = Rich {
        title: pick("title").map(serde_json::from_value).transpose()
            .map_err(|_| AppError::bad_request(anyhow::anyhow!("title must be a string")))?,
        color: pick("color").map(serde_json::from_value).transpose()
            .map_err(|_| AppError::bad_request(anyhow::anyhow!("color must be a palette slot number")))?,
        marks: pick("marks").map(serde_json::from_value).transpose()
            .map_err(|_| AppError::bad_request(anyhow::anyhow!("marks must be objects with kind, quote and optional color")))?
            .unwrap_or_default(),
        workspace_links: pick("workspace_links").map(serde_json::from_value).transpose()
            .map_err(|_| AppError::bad_request(anyhow::anyhow!("workspace_links must be an array of ids")))?
            .unwrap_or_default(),
    };
    Ok(footnotes::FootnoteSubmission {
        title: rich.title,
        color: rich.color,
        marks: rich.marks,
        workspace_links: rich.workspace_links,
        ..Default::default()
    })
}

pub(super) fn into_anyhow(err: FootnoteFail) -> anyhow::Error {
    match err {
        FootnoteFail::Invalid(message) => anyhow::anyhow!("invalid:{message}"),
        FootnoteFail::NotFound => anyhow::anyhow!("missing:unknown footnote request"),
        FootnoteFail::Conflict(message) => anyhow::anyhow!("conflict:{message}"),
        FootnoteFail::Other(err) => err,
    }
}

pub(super) fn map_store_error(err: AppError) -> AppError {
    let message = err.message();
    if let Some(text) = message.strip_prefix("invalid:") {
        return AppError::bad_request(anyhow::anyhow!(text.to_string()));
    }
    if let Some(text) = message.strip_prefix("missing:") {
        return AppError::not_found(anyhow::anyhow!(text.to_string()));
    }
    if let Some(text) = message.strip_prefix("conflict:") {
        return AppError::status(StatusCode::CONFLICT, anyhow::anyhow!(text.to_string()));
    }
    err
}

pub(super) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod footnote_tests {
    use super::*;
    use crate::pads::footnotes::{NewFootnoteRequest, FootnoteLink};
    use super::super::pads::pad_sync_inventory;
    use serde_json::json;

    fn open() -> (tempfile::TempDir, rusqlite::Connection) {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::pads::open(&dir.path().join("pads.db")).unwrap();
        (dir, conn)
    }

    fn sample(id: &str, device: &str) -> NewFootnoteRequest {
        NewFootnoteRequest {
            answer_mode: footnotes::AnswerMode::Bot,
            id: id.into(),
            device_id: device.into(),
            doc_id: "mdink-1".into(),
            doc_name: "Notes.md".into(),
            page: Some(3),
            anchor: json!({"kind": "text", "start": 1, "end": 5}),
            excerpt: "lemma".into(),
            context: "a lemma in context".into(),
            wide_context: "a lemma in a wider context".into(),
            page_footnotes: json!([{"excerpt": "other", "notes": ["already"]}]),
            prompt: Some("explain like I'm new".into()),
            extras: Default::default(),
        }
    }

    fn rich_sample(id: &str) -> NewFootnoteRequest {
        let mut body = sample(id, "dev-a");
        body.extras = footnotes::FootnoteExtras {
            palette: vec!["#60a5fa".into(), "#f472b6".into(), "#facc15".into(), "#34d399".into()],
            mark_text: "We now explore  depth-first search\non directed graphs.".into(),
            workspace_items: vec![footnotes::WorkspaceItem {
                id: "whiteboard:wb-dfs".into(), kind: "whiteboard".into(), title: "DFS notes".into(),
            }],
            doc_kind: "web".into(),
            ..Default::default()
        };
        body
    }

    #[test]
    fn rich_answers_keep_title_color_marks_and_resolve_workspace_links() {
        let (_dir, conn) = open();
        footnotes::create_request(&conn, rich_sample("fr-rich"), 1).unwrap();
        let request = footnotes::get_request(&conn, "fr-rich").unwrap().unwrap();
        assert_eq!(request.extras.palette.len(), 4);
        assert_eq!(request.extras.workspace_items[0].title, "DFS notes");
        let submission = footnotes::FootnoteSubmission {
            notes: vec!["Explores as deep as possible before backtracking.".into()],
            title: Some("  DFS  ".into()),
            color: Some(3),
            marks: vec![
                footnotes::FootnoteMark { kind: "highlight".into(), quote: "Depth-First   Search".into(), color: Some(1) },
                footnotes::FootnoteMark { kind: "underline".into(), quote: "directed graphs".into(), color: None },
            ],
            workspace_links: vec!["whiteboard:wb-dfs".into()],
            ..Default::default()
        };
        footnotes::submit_answer(&conn, "fr-rich", &submission, 2).unwrap();
        let result = footnotes::get_request(&conn, "fr-rich").unwrap().unwrap().result.unwrap();
        assert_eq!(result["title"], "DFS");
        assert_eq!(result["color"], 3);
        assert_eq!(result["marks"][0]["kind"], "highlight");
        assert_eq!(result["marks"][1]["quote"], "directed graphs");
        assert_eq!(result["workspace_links"][0]["title"], "DFS notes");
        assert_eq!(result["link_from"], "web");
        // The device gets the same result through its results poll.
        let delivered = footnotes::list_results(&conn, Some("dev-a")).unwrap();
        assert_eq!(delivered[0].result["workspace_links"][0]["id"], "whiteboard:wb-dfs");
    }

    #[test]
    fn rich_answers_are_checked_against_the_request() {
        let (_dir, conn) = open();
        footnotes::create_request(&conn, rich_sample("fr-check"), 1).unwrap();
        let note = || vec!["A note.".to_string()];
        let rejected: Vec<(&str, footnotes::FootnoteSubmission)> = vec![
            ("quote-missing", footnotes::FootnoteSubmission { notes: note(), marks: vec![footnotes::FootnoteMark { kind: "highlight".into(), quote: "breadth-first".into(), color: None }], ..Default::default() }),
            ("bad-kind", footnotes::FootnoteSubmission { notes: note(), marks: vec![footnotes::FootnoteMark { kind: "strike".into(), quote: "depth-first".into(), color: None }], ..Default::default() }),
            ("slot-too-high", footnotes::FootnoteSubmission { notes: note(), color: Some(5), ..Default::default() }),
            ("mark-slot-zero", footnotes::FootnoteSubmission { notes: note(), marks: vec![footnotes::FootnoteMark { kind: "underline".into(), quote: "depth-first".into(), color: Some(0) }], ..Default::default() }),
            ("unknown-item", footnotes::FootnoteSubmission { notes: note(), workspace_links: vec!["annotate:nope".into()], ..Default::default() }),
            ("long-title", footnotes::FootnoteSubmission { notes: note(), title: Some("t".repeat(121)), ..Default::default() }),
        ];
        for (name, submission) in rejected {
            let err = footnotes::submit_answer(&conn, "fr-check", &submission, 2).expect_err(name);
            assert!(matches!(err, FootnoteFail::Invalid(_)), "{name}: {err:?}");
        }
        assert_eq!(footnotes::get_request(&conn, "fr-check").unwrap().unwrap().status, "pending");
    }

    #[test]
    fn extras_are_validated_when_a_request_is_made() {
        let (_dir, conn) = open();
        let mut body = rich_sample("fr-x1");
        body.extras.palette.push("blue".into());
        assert!(matches!(footnotes::create_request(&conn, body, 1), Err(FootnoteFail::Invalid(_))));
        let mut body = rich_sample("fr-x2");
        body.extras.doc_kind = "whiteboard".into();
        assert!(matches!(footnotes::create_request(&conn, body, 1), Err(FootnoteFail::Invalid(_))));
        // Old devices send no extras; requests still work.
        footnotes::create_request(&conn, sample("fr-x3", "dev-a"), 1).unwrap();
        assert_eq!(footnotes::get_request(&conn, "fr-x3").unwrap().unwrap().extras, footnotes::FootnoteExtras::default());
    }

    #[test]
    fn selection_settings_and_many_attachments_are_kept_and_validated() {
        use crate::pads::annotation_jobs::{JobReference, REFERENCES_TOTAL_CAP};
        let (_dir, conn) = open();
        let mut body = rich_sample("fr-attached");
        body.extras.focus = "Graph ideas".into();
        body.extras.per_page = Some(2);
        body.extras.references = (0..20).map(|index| JobReference {
            title: format!("File {index}"), kind: "file".into(), text: "Chapter notes".into(),
        }).collect();
        footnotes::create_request(&conn, body.clone(), 1).unwrap();
        let request = footnotes::get_request(&conn, "fr-attached").unwrap().unwrap();
        assert_eq!(request.extras, body.extras);
        assert_eq!(request.extras.references.len(), 20);
        let mut bad_focus = body.clone();
        bad_focus.extras.focus = "x".repeat(1001);
        let mut bad_density = body.clone();
        bad_density.extras.per_page = Some(9);
        let mut too_large = body.clone();
        too_large.extras.references = vec![JobReference {
            title: "Large file".into(), kind: "file".into(), text: "x".repeat(REFERENCES_TOTAL_CAP + 1),
        }];
        for (name, mut bad) in [("focus", bad_focus), ("density", bad_density), ("attachments", too_large)] {
            bad.id = format!("fr-bad-{name}");
            assert!(matches!(footnotes::create_request(&conn, bad, 2), Err(FootnoteFail::Invalid(_))), "{name}");
        }
    }

    #[test]
    fn http_bodies_carry_the_rich_fields() {
        let rich = parse_rich(&json!({
            "notes": ["n"], "title": "T", "color": 2,
            "marks": [{"kind": "underline", "quote": "q"}], "workspace_links": ["a:b"],
        })).unwrap();
        assert_eq!(rich.title.as_deref(), Some("T"));
        assert_eq!(rich.color, Some(2));
        assert_eq!(rich.marks.len(), 1);
        assert_eq!(rich.workspace_links, ["a:b"]);
        assert!(parse_rich(&json!({ "notes": ["n"], "color": "blue" })).is_err());
        assert!(parse_rich(&json!({ "notes": ["n"], "title": null })).unwrap().title.is_none());
    }

    #[test]
    fn create_is_idempotent_and_lists_pending_oldest_first() {
        let (_dir, conn) = open();
        let mut later = sample("fr-b", "dev-a");
        later.excerpt = "second".into();
        footnotes::create_request(&conn, later, 20).unwrap();
        footnotes::create_request(&conn, sample("fr-a", "dev-a"), 10).unwrap();
        let again = footnotes::create_request(&conn, {
            let mut replay = sample("fr-b", "dev-a");
            replay.excerpt = "overwritten".into();
            replay.context = "x".repeat(9000);
            replay
        }, 99).unwrap();
        assert_eq!(again.excerpt, "second");
        assert_eq!(again.created_at, 20);
        let pending = footnotes::list_pending(&conn).unwrap();
        assert_eq!(pending.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(), ["fr-a", "fr-b"]);
        assert_eq!(pending[0].doc_name, "Notes.md");
        assert_eq!(pending[0].prompt.as_deref(), Some("explain like I'm new"));
        let full = footnotes::get_request(&conn, "fr-a").unwrap().unwrap();
        assert_eq!(full.wide_context, "a lemma in a wider context");
        assert_eq!(full.page_footnotes[0]["excerpt"], "other");
        assert!(footnotes::get_request(&conn, "missing").unwrap().is_none());
    }

    #[test]
    fn llm_requests_keep_their_route_across_reopen_and_do_not_enter_the_bot_inbox() {
        let (dir, conn) = open();
        let mut request = sample("fr-llm", "dev-a");
        request.answer_mode = footnotes::AnswerMode::Llm;
        footnotes::create_request(&conn, request, 10).unwrap();
        footnotes::create_request(&conn, sample("fr-bot", "dev-a"), 20).unwrap();
        let bot_rows = footnotes::list_pending(&conn).unwrap();
        assert_eq!(bot_rows.len(), 1);
        assert_eq!(bot_rows[0].id, "fr-bot");
        assert!(footnotes::list_pending_llm(&conn, Some("dev-b")).unwrap().is_empty());
        drop(conn);
        let conn = crate::pads::open(&dir.path().join("pads.db")).unwrap();
        let jobs = footnotes::list_pending_llm(&conn, Some("dev-a")).unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].answer_mode, footnotes::AnswerMode::Llm);
        // A retried POST must not change the route or overwrite an answer.
        let retried = footnotes::create_request(&conn, sample("fr-llm", "dev-a"), 30).unwrap();
        assert_eq!(retried.answer_mode, footnotes::AnswerMode::Llm);
        footnotes::submit_result(&conn, "fr-llm", &["Saved answer".into()], &[], 40).unwrap();
        assert!(footnotes::list_pending_llm(&conn, None).unwrap().is_empty());
        assert_eq!(footnotes::list_results(&conn, Some("dev-a")).unwrap().len(), 1);
    }

    #[test]
    fn assistant_app_requests_round_trip_and_share_the_mcp_inbox_without_model_work() {
        let (dir, conn) = open();
        for (id, mode, time) in [
            ("fr-bot", footnotes::AnswerMode::Bot, 1),
            ("fr-app", footnotes::AnswerMode::App, 2),
            ("fr-llm", footnotes::AnswerMode::Llm, 3),
        ] {
            let mut body = sample(id, "dev-a");
            body.answer_mode = mode;
            let row = footnotes::create_request(&conn, body, time).unwrap();
            assert_eq!(row.answer_mode, mode);
            assert_eq!(serde_json::from_value::<footnotes::AnswerMode>(serde_json::to_value(mode).unwrap()).unwrap(), mode);
        }
        let inbox = footnotes::list_pending(&conn).unwrap();
        assert_eq!(inbox.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(), ["fr-bot", "fr-app"]);
        assert_eq!(inbox[1].answer_mode, footnotes::AnswerMode::App);
        assert_eq!(footnotes::list_pending_app(&conn).unwrap().iter().map(|row| row.id.as_str()).collect::<Vec<_>>(), ["fr-app"]);
        assert_eq!(footnotes::list_pending_llm(&conn, None).unwrap().iter().map(|row| row.id.as_str()).collect::<Vec<_>>(), ["fr-llm"]);
        drop(conn);
        let conn = crate::pads::open(&dir.path().join("pads.db")).unwrap();
        assert_eq!(footnotes::get_request(&conn, "fr-app").unwrap().unwrap().answer_mode, footnotes::AnswerMode::App);
        let retried = footnotes::create_request(&conn, sample("fr-app", "dev-a"), 9).unwrap();
        assert_eq!(retried.answer_mode, footnotes::AnswerMode::App);
        footnotes::submit_result(&conn, "fr-app", &["Automatic explanation".into()], &[], 10).unwrap();
        assert!(footnotes::list_pending_app(&conn).unwrap().is_empty());
        assert_eq!(footnotes::list_results(&conn, Some("dev-a")).unwrap()[0].id, "fr-app");
        footnotes::ack_request(&conn, "fr-app", 11).unwrap();
        assert!(footnotes::list_results(&conn, Some("dev-a")).unwrap().is_empty());
    }

    #[test]
    fn list_pending_caps_at_fifty_oldest() {
        let (_dir, conn) = open();
        for n in 0..51 {
            let mut body = sample(&format!("fr-{n:02}"), "dev-a");
            body.excerpt = format!("word {n}");
            footnotes::create_request(&conn, body, n).unwrap();
        }
        let pending = footnotes::list_pending(&conn).unwrap();
        assert_eq!(pending.len(), 50);
        assert_eq!(pending[0].id, "fr-00");
        assert_eq!(pending.last().unwrap().id, "fr-49");
    }

    #[test]
    fn request_validation_rejects_each_cap() {
        let (_dir, conn) = open();
        let cases: Vec<(&str, NewFootnoteRequest)> = vec![
            ("id", {
                let mut body = sample(" ", "dev-a");
                body.id = "bad id".into();
                body
            }),
            ("id-long", {
                let mut body = sample("fr-long", "dev-a");
                body.id = "a".repeat(101);
                body
            }),
            ("excerpt-empty", {
                let mut body = sample("fr-e", "dev-a");
                body.excerpt.clear();
                body
            }),
            ("excerpt-long", {
                let mut body = sample("fr-el", "dev-a");
                body.excerpt = "e".repeat(4001);
                body
            }),
            ("context", {
                let mut body = sample("fr-c", "dev-a");
                body.context = "c".repeat(8001);
                body
            }),
            ("wide", {
                let mut body = sample("fr-w", "dev-a");
                body.wide_context = "w".repeat(24001);
                body
            }),
            ("prompt", {
                let mut body = sample("fr-p", "dev-a");
                body.prompt = Some("p".repeat(1001));
                body
            }),
            ("pages-count", {
                let mut body = sample("fr-n", "dev-a");
                body.page_footnotes = json!(vec!["x"; 21]);
                body
            }),
            ("pages-bytes", {
                let mut body = sample("fr-b", "dev-a");
                body.page_footnotes = json!(["x".repeat(16000)]);
                body
            }),
            ("anchor", {
                let mut body = sample("fr-anchor", "dev-a");
                body.anchor = json!(["not", "an", "object"]);
                body
            }),
        ];
        for (name, body) in cases {
            let err = footnotes::create_request(&conn, body, 1).expect_err(name);
            assert!(matches!(err, FootnoteFail::Invalid(_)), "{name}: {err:?}");
        }
        assert!(footnotes::list_pending(&conn).unwrap().is_empty());
    }

    #[test]
    fn submit_validation_and_second_submit_conflicts() {
        let (_dir, conn) = open();
        footnotes::create_request(&conn, sample("fr-1", "dev-a"), 1).unwrap();
        let long_note = "n".repeat(4001);
        let long_url = format!("https://{}", "a".repeat(1993));
        let long_title = "t".repeat(201);
        let rejected: Vec<(&str, Vec<String>, Vec<FootnoteLink>)> = vec![
            ("no-notes", vec![], vec![]),
            ("nine-notes", vec!["a".into(); 9], vec![]),
            ("blank", vec!["  ".into()], vec![]),
            ("long-note", vec![long_note], vec![]),
            ("nine-links", vec!["ok".into()], (0..9).map(|n| FootnoteLink { title: None, url: format!("https://example.com/{n}") }).collect()),
            ("bad-url", vec!["ok".into()], vec![FootnoteLink { title: None, url: "ftp://example.com".into() }]),
            ("long-url", vec!["ok".into()], vec![FootnoteLink { title: None, url: long_url }]),
            ("long-title", vec!["ok".into()], vec![FootnoteLink { title: Some(long_title), url: "https://example.com".into() }]),
        ];
        for (name, notes, links) in rejected {
            let err = footnotes::submit_result(&conn, "fr-1", &notes, &links, 2).expect_err(name);
            assert!(matches!(err, FootnoteFail::Invalid(_)), "{name}: {err:?}");
        }
        assert!(matches!(
            footnotes::submit_result(&conn, "missing", &["ok".into()], &[], 2).unwrap_err(),
            FootnoteFail::NotFound
        ));
        footnotes::submit_result(
            &conn,
            "fr-1",
            &["  A lemma is a small theorem.  ".into()],
            &[FootnoteLink { title: Some("  ".into()), url: " https://example.com/a ".into() }],
            5,
        )
        .unwrap();
        let stored = footnotes::get_request(&conn, "fr-1").unwrap().unwrap();
        assert_eq!(stored.status, "done");
        let result = stored.result.expect("stored result");
        assert_eq!(result["notes"][0], "A lemma is a small theorem.");
        assert_eq!(result["links"][0]["url"], "https://example.com/a");
        assert!(result["links"][0].get("title").is_none());
        let err = footnotes::submit_result(&conn, "fr-1", &["nope".into()], &[], 6).unwrap_err();
        assert!(matches!(err, FootnoteFail::Conflict(_)));
        assert!(footnotes::list_pending(&conn).unwrap().is_empty());
    }

    #[test]
    fn ping_returns_a_result_only_for_the_asking_device_until_ack() {
        let (_dir, conn) = open();
        footnotes::create_request(&conn, sample("fr-a", "dev-a"), 1).unwrap();
        footnotes::create_request(&conn, sample("fr-b", "dev-b"), 2).unwrap();
        footnotes::submit_result(&conn, "fr-a", &["for a".into()], &[], 10).unwrap();
        footnotes::submit_result(&conn, "fr-b", &["for b".into()], &[], 11).unwrap();
        let for_a = pad_sync_inventory(&conn, i64::MAX, 100, Some("dev-a")).unwrap();
        assert_eq!(for_a.footnote_results.len(), 1);
        assert_eq!(for_a.footnote_results[0].id, "fr-a");
        assert_eq!(for_a.footnote_results[0].doc_id, "mdink-1");
        assert_eq!(for_a.footnote_results[0].result["notes"][0], "for a");
        let for_b = pad_sync_inventory(&conn, 0, 100, Some("dev-b")).unwrap();
        assert_eq!(for_b.footnote_results[0].id, "fr-b");
        assert!(pad_sync_inventory(&conn, 0, 100, None).unwrap().footnote_results.is_empty());
        assert!(pad_sync_inventory(&conn, 0, 100, Some("")).unwrap().footnote_results.is_empty());
        footnotes::ack_request(&conn, "fr-a", 20).unwrap();
        footnotes::ack_request(&conn, "fr-a", 21).unwrap();
        assert!(pad_sync_inventory(&conn, 0, 100, Some("dev-a")).unwrap().footnote_results.is_empty());
        assert!(matches!(footnotes::ack_request(&conn, "missing", 1).unwrap_err(), FootnoteFail::NotFound));
    }

    #[test]
    fn ping_caps_unacked_results_at_twenty() {
        let (_dir, conn) = open();
        for n in 0..21 {
            footnotes::create_request(&conn, sample(&format!("fr-{n:02}"), "dev-a"), n).unwrap();
            footnotes::submit_result(&conn, &format!("fr-{n:02}"), &["n".into()], &[], 100 + n).unwrap();
        }
        let ping = pad_sync_inventory(&conn, 0, 100, Some("dev-a")).unwrap();
        assert_eq!(ping.footnote_results.len(), 20);
        assert_eq!(ping.footnote_results[0].id, "fr-00");
    }

    #[test]
    fn store_errors_map_to_status_codes() {
        assert_eq!(status_of(&FootnoteFail::Invalid("no".into())), StatusCode::BAD_REQUEST);
        assert_eq!(status_of(&FootnoteFail::NotFound), StatusCode::NOT_FOUND);
        assert_eq!(status_of(&FootnoteFail::Conflict("busy".into())), StatusCode::CONFLICT);
    }

    fn status_of(err: &FootnoteFail) -> StatusCode {
        map_store_error(AppError::from(into_anyhow_ref(err))).status_code()
    }

    fn into_anyhow_ref(err: &FootnoteFail) -> anyhow::Error {
        match err {
            FootnoteFail::Invalid(message) => anyhow::anyhow!("invalid:{message}"),
            FootnoteFail::NotFound => anyhow::anyhow!("missing:unknown footnote request"),
            FootnoteFail::Conflict(message) => anyhow::anyhow!("conflict:{message}"),
            FootnoteFail::Other(err) => anyhow::anyhow!("{err:#}"),
        }
    }

    #[test]
    fn results_stay_on_the_asking_device_until_a_successful_ack() {
        let (_dir, conn) = open();
        footnotes::create_request(&conn, sample("fr-a", "dev-a"), 1).unwrap();
        footnotes::create_request(&conn, sample("fr-b", "dev-b"), 2).unwrap();
        footnotes::submit_result(&conn, "fr-a", &["for a".into()], &[], 10).unwrap();
        footnotes::submit_result(&conn, "fr-b", &["for b".into()], &[], 11).unwrap();

        let for_a = footnote_results_on(&conn, "dev-a").unwrap();
        assert_eq!(for_a["footnote_results"].as_array().unwrap().len(), 1);
        assert_eq!(for_a["footnote_results"][0]["id"], "fr-a");
        assert_eq!(for_a["footnote_results"][0]["doc_id"], "mdink-1");
        assert_eq!(for_a["footnote_results"][0]["result"]["notes"][0], "for a");
        let for_b = footnote_results_on(&conn, "dev-b").unwrap();
        assert_eq!(for_b["footnote_results"][0]["id"], "fr-b");
        assert!(for_b["footnote_results"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["id"] != "fr-a"));

        let missing = None::<String>;
        let oversized = "d".repeat(201);
        for device in ["", missing.as_deref().unwrap_or(""), oversized.as_str()] {
            let err = footnote_results_on(&conn, device).unwrap_err();
            assert_eq!(err.status_code(), StatusCode::BAD_REQUEST, "{device:?}");
        }
        let accepted = footnote_results_on(&conn, &"d".repeat(200)).unwrap();
        assert!(accepted["footnote_results"].as_array().unwrap().is_empty());

        // A poll that never lands an ack delivers the same result again.
        assert_eq!(footnote_results_on(&conn, "dev-a").unwrap(), for_a);
        footnotes::ack_request(&conn, "fr-a", 20).unwrap();
        assert!(footnote_results_on(&conn, "dev-a").unwrap()["footnote_results"]
            .as_array()
            .unwrap()
            .is_empty());
        assert_eq!(footnote_results_on(&conn, "dev-b").unwrap()["footnote_results"][0]["id"], "fr-b");
    }

    #[test]
    fn results_response_is_only_the_footnote_envelope() {
        let (_dir, conn) = open();
        let whiteboard: crate::pads::WhiteboardPad = serde_json::from_value(json!({
            "id": "book", "title": "Notebook", "updated_at": 10,
            "page_count": 1, "board": {"v": 1, "elements": []}, "agent": []
        }))
        .unwrap();
        crate::pads::put_whiteboard(&conn, &whiteboard).unwrap();
        let annotate: crate::pads::AnnotatePad = serde_json::from_value(json!({
            "id": "doc", "name": "Notes.md", "hash": "abc", "updated_at": 10,
            "source": "hello", "board": {"v": 1, "elements": []},
            "footnotes": [], "agent": []
        }))
        .unwrap();
        crate::pads::put_annotate(&conn, &annotate).unwrap();
        footnotes::create_request(&conn, sample("fr-a", "dev-a"), 1).unwrap();
        footnotes::submit_result(&conn, "fr-a", &["for a".into()], &[], 10).unwrap();

        let value = footnote_results_on(&conn, "dev-a").unwrap();
        let json = serde_json::to_value(&value).unwrap();
        let keys: Vec<_> = json.as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys, vec!["footnote_results".to_string()]);
        assert_eq!(json["footnote_results"][0]["id"], "fr-a");
    }
}
