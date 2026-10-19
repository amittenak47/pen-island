//! Inbox of "ask for a footnote" requests.
//!
//! The device is the only writer of the document. A model leaves its answer
//! here, and the next sync ping hands that answer back to the device that asked.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::write_transaction;

pub const LIST_CAP: i64 = 50;
pub const PING_CAP: i64 = 20;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AnswerMode {
    #[default]
    Bot,
    Llm,
    App,
}

impl AnswerMode {
    pub(crate) fn as_str(self) -> &'static str { match self { Self::Bot => "bot", Self::Llm => "llm", Self::App => "app" } }

    pub(crate) fn from_str(value: &str) -> Self {
        match value { "llm" => Self::Llm, "app" => Self::App, _ => Self::Bot }
    }
}

#[derive(Debug)]
pub enum FootnoteFail {
    Invalid(String),
    NotFound,
    Conflict(String),
    Other(anyhow::Error),
}

impl From<rusqlite::Error> for FootnoteFail {
    fn from(err: rusqlite::Error) -> Self {
        Self::Other(err.into())
    }
}

impl From<serde_json::Error> for FootnoteFail {
    fn from(err: serde_json::Error) -> Self {
        Self::Other(err.into())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FootnoteLink {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub url: String,
}

/// One item from the reader's library the answer may link to.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct WorkspaceItem {
    pub id: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub title: String,
}

/// What the device sends beyond the text: the mark's palette, the exact text
/// under it, the library items it may link, and the kind of document asking.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct FootnoteExtras {
    #[serde(default)]
    pub palette: Vec<String>,
    #[serde(default)]
    pub mark_text: String,
    #[serde(default)]
    pub workspace_items: Vec<WorkspaceItem>,
    #[serde(default)]
    pub doc_kind: String,
    #[serde(default)]
    pub focus: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub per_page: Option<u8>,
    #[serde(default)]
    pub references: Vec<super::annotation_jobs::JobReference>,
    /// What the reader is reading and how they want the notes shaped.
    #[serde(default)]
    pub reading: super::reading::ReadingStyle,
}

/// An underline or highlight on words inside the marked text.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FootnoteMark {
    pub kind: String,
    pub quote: String,
    /// 1-based slot in the mark's palette.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<u8>,
}

/// What an assistant submits. Only `notes` is required.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct FootnoteSubmission {
    #[serde(default)]
    pub notes: Vec<String>,
    #[serde(default)]
    pub links: Vec<FootnoteLink>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub color: Option<u8>,
    #[serde(default)]
    pub marks: Vec<FootnoteMark>,
    /// Ids from the request's `extras.workspace_items`.
    #[serde(default)]
    pub workspace_links: Vec<String>,
    /// The body as labelled fields, when the request names a preset.
    #[serde(default)]
    pub fields: Vec<super::reading::NoteField>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct FootnoteResult {
    pub notes: Vec<String>,
    #[serde(default)]
    pub links: Vec<FootnoteLink>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<u8>,
    #[serde(default)]
    pub marks: Vec<FootnoteMark>,
    /// Resolved from the request, so the device needs nothing else to link them.
    #[serde(default)]
    pub workspace_links: Vec<WorkspaceItem>,
    /// The asking document's kind ("annotate" or "web"), the link's other end.
    #[serde(default)]
    pub link_from: String,
    /// Preset field labels the notes use, in order; each such note opens "**Label:**".
    #[serde(default)]
    pub fields: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FootnoteRequest {
    #[serde(default)]
    pub answer_mode: AnswerMode,
    pub id: String,
    pub device_id: String,
    pub doc_id: String,
    pub doc_name: String,
    pub page: Option<i64>,
    pub anchor: Value,
    pub excerpt: String,
    pub context: String,
    pub wide_context: String,
    pub page_footnotes: Value,
    pub prompt: Option<String>,
    #[serde(default)]
    pub extras: FootnoteExtras,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub done_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acked_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FootnoteRequestSummary {
    pub id: String,
    #[serde(default)]
    pub answer_mode: AnswerMode,
    pub doc_name: String,
    pub page: Option<i64>,
    pub excerpt: String,
    pub context: String,
    pub prompt: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FootnotePingResult {
    pub id: String,
    pub doc_id: String,
    pub result: Value,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NewFootnoteRequest {
    #[serde(default)]
    pub answer_mode: AnswerMode,
    pub id: String,
    pub device_id: String,
    pub doc_id: String,
    pub doc_name: String,
    #[serde(default)]
    pub page: Option<i64>,
    pub anchor: Value,
    pub excerpt: String,
    #[serde(default)]
    pub context: String,
    #[serde(default)]
    pub wide_context: String,
    #[serde(default)]
    pub page_footnotes: Value,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub extras: FootnoteExtras,
}

fn valid_hex(color: &str) -> bool {
    color.len() == 7 && color.starts_with('#') && color[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

pub use super::reading::NoteField;

pub fn validate_extras(extras: &FootnoteExtras) -> Result<(), String> {
    if extras.focus.chars().count() > 1000 {
        return Err("extras.focus must be at most 1000 characters".into());
    }
    if extras.per_page.is_some_and(|per_page| !matches!(per_page, 1..=8)) {
        return Err("extras.per_page must be 1..=8".into());
    }
    super::annotation_jobs::validate_references(&extras.references)?;
    extras.reading.validate()?;
    if extras.palette.len() > 8 || !extras.palette.iter().all(|color| valid_hex(color)) {
        return Err("extras.palette must be at most 8 #rrggbb colors".into());
    }
    if extras.mark_text.chars().count() > 8000 {
        return Err("extras.mark_text must be at most 8000 characters".into());
    }
    if extras.workspace_items.len() > 60 {
        return Err("extras.workspace_items must have at most 60 entries".into());
    }
    for item in &extras.workspace_items {
        let id = item.id.chars().count();
        if !(1..=300).contains(&id) || item.kind.chars().count() > 20 || item.title.chars().count() > 300 {
            return Err("each workspace item needs an id (1..=300 characters), a short kind and a title".into());
        }
    }
    if !matches!(extras.doc_kind.as_str(), "" | "annotate" | "web") {
        return Err("extras.doc_kind must be annotate or web".into());
    }
    Ok(())
}

pub fn validate_request(body: &NewFootnoteRequest) -> Result<Value, String> {
    if !valid_id(&body.id) {
        return Err("id must be 1..=100 characters of [A-Za-z0-9_-]".into());
    }
    if body.device_id.is_empty() || body.device_id.chars().count() > 200 {
        return Err("device_id is required".into());
    }
    if body.doc_id.is_empty() || body.doc_id.chars().count() > 200 {
        return Err("doc_id is required".into());
    }
    let excerpt = body.excerpt.chars().count();
    if !(1..=4000).contains(&excerpt) {
        return Err("excerpt must be 1..=4000 characters".into());
    }
    if body.context.chars().count() > 8000 {
        return Err("context must be at most 8000 characters".into());
    }
    if body.wide_context.chars().count() > 24000 {
        return Err("wide_context must be at most 24000 characters".into());
    }
    if body.prompt.as_ref().map(|text| text.chars().count()).unwrap_or(0) > 1000 {
        return Err("prompt must be at most 1000 characters".into());
    }
    if !body.anchor.is_object() {
        return Err("anchor must be a JSON object".into());
    }
    validate_extras(&body.extras)?;
    let pages = if body.page_footnotes.is_null() {
        Value::Array(Vec::new())
    } else {
        body.page_footnotes.clone()
    };
    let Some(entries) = pages.as_array() else {
        return Err("page_footnotes must be a JSON array".into());
    };
    if entries.len() > 20 {
        return Err("page_footnotes must have at most 20 entries".into());
    }
    let bytes = serde_json::to_vec(&pages).map_err(|_| "page_footnotes must be JSON".to_string())?;
    if bytes.len() > 16000 {
        return Err("page_footnotes must be at most 16000 bytes".into());
    }
    Ok(pages)
}

/// Trim notes and links. The hub and the MCP server both call this before a result is stored.
pub fn validate_result(notes: &[String], links: &[FootnoteLink]) -> Result<FootnoteResult, String> {
    validate_submission(
        &FootnoteSubmission { notes: notes.to_vec(), links: links.to_vec(), ..Default::default() },
        None,
    )
}

/// Words compared the way a reader would: case and runs of whitespace ignored.
fn loose(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

/// Check a whole answer. With the request's `extras`, also check that quotes,
/// palette slots and workspace ids refer to things the request actually had.
pub fn validate_submission(
    submission: &FootnoteSubmission,
    extras: Option<&FootnoteExtras>,
) -> Result<FootnoteResult, String> {
    // Fields become labelled notes, ahead of any free notes, once checked
    // against the request's preset. Without the request (an early check)
    // they pass through untouched; the hub checks them when it stores them.
    let (notes, used) = match extras {
        Some(extras) => {
            let mut notes = extras.reading.fold_fields(&submission.fields, &extras.mark_text)?;
            notes.extend(submission.notes.iter().cloned());
            (notes, extras.reading.used_labels(&submission.fields))
        }
        None => {
            if submission.fields.iter().any(|field| field.label.trim().is_empty() || field.text.trim().is_empty()) {
                return Err("each field needs a label and text".into());
            }
            (submission.notes.clone(), Vec::new())
        }
    };
    let early_fields_only = extras.is_none() && notes.is_empty() && !submission.fields.is_empty();
    let placeholder = [String::from("fields")];
    let mut base = validate_notes_and_links(if early_fields_only { &placeholder } else { &notes }, &submission.links)?;
    if early_fields_only {
        base.notes.clear();
    }
    base.fields = used;
    let slots = extras.map(|extras| extras.palette.len()).filter(|count| *count > 0).unwrap_or(8);
    let slot_ok = |slot: u8| (1..=slots).contains(&(slot as usize));
    let title = match submission.title.as_deref().map(str::trim) {
        Some("") | None => None,
        Some(text) if text.chars().count() > 120 => return Err("title must be at most 120 characters".into()),
        Some(text) => Some(text.to_string()),
    };
    if let Some(slot) = submission.color {
        if !slot_ok(slot) {
            return Err(format!("color must be a palette slot from 1 to {slots}"));
        }
    }
    if submission.marks.len() > 12 {
        return Err("marks must have at most 12 entries".into());
    }
    let text = extras.map(|extras| loose(&extras.mark_text)).unwrap_or_default();
    let mut marks = Vec::with_capacity(submission.marks.len());
    for mark in &submission.marks {
        if mark.kind != "highlight" && mark.kind != "underline" {
            return Err("each mark kind must be highlight or underline".into());
        }
        let quote = mark.quote.trim();
        if !(1..=500).contains(&quote.chars().count()) {
            return Err("each mark quote must be 1..=500 characters".into());
        }
        if !text.is_empty() && !text.contains(&loose(quote)) {
            return Err(format!("mark quote is not in the marked text: \"{quote}\""));
        }
        if let Some(slot) = mark.color {
            if !slot_ok(slot) {
                return Err(format!("mark color must be a palette slot from 1 to {slots}"));
            }
        }
        marks.push(FootnoteMark { kind: mark.kind.clone(), quote: quote.to_string(), color: mark.color });
    }
    if submission.workspace_links.len() > 8 {
        return Err("workspace_links must have at most 8 entries".into());
    }
    let mut workspace_links = Vec::with_capacity(submission.workspace_links.len());
    for id in &submission.workspace_links {
        let id = id.trim();
        match extras {
            Some(extras) => match extras.workspace_items.iter().find(|item| item.id == id) {
                Some(item) => workspace_links.push(item.clone()),
                None => return Err(format!("workspace link {id:?} is not one of the request's workspace_items")),
            },
            None if !id.is_empty() => workspace_links.push(WorkspaceItem { id: id.to_string(), ..Default::default() }),
            None => return Err("workspace link ids must be non-empty".into()),
        }
    }
    let link_from = if workspace_links.is_empty() {
        String::new()
    } else {
        extras.map(|extras| extras.doc_kind.clone()).filter(|kind| !kind.is_empty()).unwrap_or_else(|| "annotate".into())
    };
    Ok(FootnoteResult { title, color: submission.color, marks, workspace_links, link_from, ..base })
}

fn validate_notes_and_links(notes: &[String], links: &[FootnoteLink]) -> Result<FootnoteResult, String> {
    if !(1..=12).contains(&notes.len()) {
        return Err("write 1 to 12 notes or fields".into());
    }
    let mut cleaned_notes = Vec::with_capacity(notes.len());
    for note in notes {
        let text = note.trim();
        if text.is_empty() {
            return Err("each note must be non-empty".into());
        }
        if text.chars().count() > 4000 {
            return Err("each note must be at most 4000 characters".into());
        }
        cleaned_notes.push(text.to_string());
    }
    if links.len() > 8 {
        return Err("links must have at most 8 entries".into());
    }
    let mut cleaned_links = Vec::with_capacity(links.len());
    for link in links {
        let url = link.url.trim();
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return Err("link url must start with http:// or https://".into());
        }
        if url.chars().count() > 2000 {
            return Err("link url must be at most 2000 characters".into());
        }
        let title = match link.title.as_deref() {
            Some(raw) => {
                let text = raw.trim();
                if text.is_empty() {
                    None
                } else if text.chars().count() > 200 {
                    return Err("link title must be at most 200 characters".into());
                } else {
                    Some(text.to_string())
                }
            }
            None => None,
        };
        cleaned_links.push(FootnoteLink { title, url: url.to_string() });
    }
    Ok(FootnoteResult { notes: cleaned_notes, links: cleaned_links, ..Default::default() })
}

pub fn valid_id(id: &str) -> bool {
    let count = id.chars().count();
    (1..=100).contains(&count)
        && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn transact<T>(conn: &Connection, body: impl FnOnce() -> Result<T, FootnoteFail>) -> Result<T, FootnoteFail> {
    match write_transaction(conn, || match body() {
        Ok(value) => Ok(Ok(value)),
        Err(FootnoteFail::Other(err)) => Err(err),
        Err(err) => Ok(Err(err)),
    }) {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(err)) => Err(err),
        Err(err) => Err(FootnoteFail::Other(err)),
    }
}

pub fn create_request(
    conn: &Connection,
    body: NewFootnoteRequest,
    now: i64,
) -> Result<FootnoteRequest, FootnoteFail> {
    transact(conn, || {
        if let Some(existing) = get_request(conn, &body.id)? {
            return Ok(existing);
        }
        let pages = validate_request(&body).map_err(FootnoteFail::Invalid)?;
        conn.execute(
            "INSERT INTO footnote_requests (
                id, device_id, doc_id, doc_name, page, anchor, excerpt, context, wide_context,
                page_footnotes, prompt, status, result, created_at, done_at, acked_at, answer_mode, extras
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'pending', NULL, ?12, NULL, NULL, ?13, ?14)",
            params![
                body.id,
                body.device_id,
                body.doc_id,
                body.doc_name,
                body.page,
                serde_json::to_string(&body.anchor)?,
                body.excerpt,
                body.context,
                body.wide_context,
                serde_json::to_string(&pages)?,
                body.prompt,
                now,
                body.answer_mode.as_str(),
                serde_json::to_string(&body.extras)?,
            ],
        )?;
        get_request(conn, &body.id)?.ok_or(FootnoteFail::NotFound)
    })
}

pub fn get_request(conn: &Connection, id: &str) -> Result<Option<FootnoteRequest>, FootnoteFail> {
    let row = conn
        .query_row(
            "SELECT id, device_id, doc_id, doc_name, page, anchor, excerpt, context, wide_context,
                    page_footnotes, prompt, status, result, created_at, done_at, acked_at, answer_mode, extras
             FROM footnote_requests WHERE id = ?1",
            params![id],
            map_request,
        )
        .optional()?;
    match row {
        Some(packed) => Ok(Some(unpack(packed)?)),
        None => Ok(None),
    }
}

pub fn list_pending(conn: &Connection) -> Result<Vec<FootnoteRequestSummary>, FootnoteFail> {
    let mut stmt = conn.prepare(
        "SELECT id, doc_name, page, excerpt, context, prompt, created_at, answer_mode
         FROM footnote_requests WHERE status = 'pending' AND answer_mode IN ('bot', 'app')
         ORDER BY created_at ASC, id ASC LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![LIST_CAP], |row| {
        Ok(FootnoteRequestSummary {
            id: row.get(0)?,
            answer_mode: AnswerMode::from_str(&row.get::<_, String>(7)?),
            doc_name: row.get(1)?,
            page: row.get(2)?,
            excerpt: row.get(3)?,
            context: row.get(4)?,
            prompt: row.get(5)?,
            created_at: row.get(6)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(FootnoteFail::from)
}

/// LLM jobs are durable and separate from the external assistant's inbox.
pub fn list_pending_llm(conn: &Connection, device: Option<&str>) -> Result<Vec<FootnoteRequest>, FootnoteFail> {
    let mut stmt = conn.prepare("SELECT id FROM footnote_requests WHERE status='pending' AND answer_mode='llm'
        AND (?1 IS NULL OR device_id=?1) ORDER BY created_at, id LIMIT ?2")?;
    let ids = stmt.query_map(params![device, LIST_CAP], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    ids.into_iter().map(|id| get_request(conn, &id)?.ok_or(FootnoteFail::NotFound)).collect()
}

/// Automatic assistant runs never claim requests waiting for a bot or model.
/// An assistant bot asked the app on this PC to write its pending requests.
pub fn hand_over_pending_to_app(conn: &Connection) -> Result<usize, FootnoteFail> {
    Ok(conn.execute(
        "UPDATE footnote_requests SET answer_mode = 'app' WHERE status = 'pending' AND answer_mode = 'bot'",
        [],
    )?)
}

pub fn list_pending_app(conn: &Connection) -> Result<Vec<FootnoteRequest>, FootnoteFail> {
    let mut stmt = conn.prepare("SELECT id FROM footnote_requests WHERE status='pending' AND answer_mode='app'
        ORDER BY created_at, id LIMIT ?1")?;
    let ids = stmt.query_map(params![LIST_CAP], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    ids.into_iter().map(|id| get_request(conn, &id)?.ok_or(FootnoteFail::NotFound)).collect()
}

pub fn submit_result(
    conn: &Connection,
    id: &str,
    notes: &[String],
    links: &[FootnoteLink],
    now: i64,
) -> Result<(), FootnoteFail> {
    let submission = FootnoteSubmission { notes: notes.to_vec(), links: links.to_vec(), ..Default::default() };
    submit_answer(conn, id, &submission, now)
}

/// Store an answer after checking it against the request it answers.
pub fn submit_answer(
    conn: &Connection,
    id: &str,
    submission: &FootnoteSubmission,
    now: i64,
) -> Result<(), FootnoteFail> {
    transact(conn, || {
        // Fields are checked against the marked text, or the excerpt when a
        // client sent none, so an answer can't just repeat the passage.
        let extras = get_request(conn, id)?.map(|request| {
            let mut extras = request.extras;
            if extras.mark_text.is_empty() { extras.mark_text = request.excerpt; }
            extras
        });
        let result = validate_submission(submission, extras.as_ref()).map_err(FootnoteFail::Invalid)?;
        let stored = serde_json::to_string(&result)?;
        let status: Option<String> = conn
            .query_row(
                "SELECT status FROM footnote_requests WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()?;
        match status.as_deref() {
            None => return Err(FootnoteFail::NotFound),
            Some("pending") => {}
            Some(_) => {
                return Err(FootnoteFail::Conflict("footnote request is not pending".into()));
            }
        }
        let changed = conn.execute(
            "UPDATE footnote_requests
             SET status = 'done', result = ?2, done_at = ?3
             WHERE id = ?1 AND status = 'pending'",
            params![id, stored, now],
        )?;
        if changed == 0 {
            return Err(FootnoteFail::Conflict("footnote request is not pending".into()));
        }
        Ok(())
    })
}

pub fn ack_request(conn: &Connection, id: &str, now: i64) -> Result<(), FootnoteFail> {
    transact(conn, || {
        let found: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM footnote_requests WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()?;
        if found.is_none() {
            return Err(FootnoteFail::NotFound);
        }
        conn.execute(
            "UPDATE footnote_requests
             SET status = 'acked', acked_at = COALESCE(acked_at, ?2)
             WHERE id = ?1",
            params![id, now],
        )?;
        Ok(())
    })
}

/// Answers still waiting on the device that asked. Empty when `device` is absent.
pub fn list_results(
    conn: &Connection,
    device: Option<&str>,
) -> Result<Vec<FootnotePingResult>, FootnoteFail> {
    let Some(device) = device.filter(|value| !value.is_empty()) else {
        return Ok(Vec::new());
    };
    let mut stmt = conn.prepare(
        "SELECT id, doc_id, result FROM footnote_requests
         WHERE status = 'done' AND device_id = ?1
         ORDER BY done_at ASC, id ASC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![device, PING_CAP], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (id, doc_id, result) = row?;
        out.push(FootnotePingResult {
            id,
            doc_id,
            result: serde_json::from_str(&result)?,
        });
    }
    Ok(out)
}

struct PackedRequest {
    request: FootnoteRequest,
    anchor: String,
    page_footnotes: String,
    result: Option<String>,
    extras: String,
}

fn map_request(row: &rusqlite::Row<'_>) -> rusqlite::Result<PackedRequest> {
    Ok(PackedRequest {
        request: FootnoteRequest {
            answer_mode: AnswerMode::from_str(&row.get::<_, String>(16)?),
            id: row.get(0)?,
            device_id: row.get(1)?,
            doc_id: row.get(2)?,
            doc_name: row.get(3)?,
            page: row.get(4)?,
            anchor: Value::Null,
            excerpt: row.get(6)?,
            context: row.get(7)?,
            wide_context: row.get(8)?,
            page_footnotes: Value::Null,
            prompt: row.get(10)?,
            extras: FootnoteExtras::default(),
            status: row.get(11)?,
            result: None,
            created_at: row.get(13)?,
            done_at: row.get(14)?,
            acked_at: row.get(15)?,
        },
        anchor: row.get(5)?,
        page_footnotes: row.get(9)?,
        result: row.get(12)?,
        extras: row.get(17)?,
    })
}

fn unpack(packed: PackedRequest) -> Result<FootnoteRequest, FootnoteFail> {
    let mut request = packed.request;
    request.anchor = serde_json::from_str(&packed.anchor)?;
    request.page_footnotes = serde_json::from_str(&packed.page_footnotes)?;
    request.result = packed.result.as_deref().map(serde_json::from_str).transpose()?;
    // Unreadable extras only lose the optional context, never the request.
    request.extras = serde_json::from_str(&packed.extras).unwrap_or_default();
    Ok(request)
}

#[cfg(test)]
mod reading_tests {
    use super::*;
    use crate::pads::reading::ReadingStyle;

    fn field(label: &str, text: &str) -> NoteField { NoteField { label: label.into(), text: text.into() } }

    #[test]
    fn persisted_empty_request_extras_and_results_are_explicit() {
        let extras = serde_json::to_value(FootnoteExtras::default()).unwrap();
        assert_eq!(extras, serde_json::json!({"palette":[], "mark_text":"", "workspace_items":[],
            "doc_kind":"", "focus":"", "references":[], "reading":{"kind":"", "fields":[], "fill":"", "preset":""}}));
        assert_eq!(serde_json::to_value(FootnoteResult::default()).unwrap(),
            serde_json::json!({"notes":[], "links":[], "marks":[], "workspace_links":[], "link_from":"", "fields":[]}));
        assert_eq!(serde_json::from_value::<FootnoteExtras>(serde_json::json!({})).unwrap(), FootnoteExtras::default());
        assert_eq!(serde_json::to_value(FootnoteSubmission::default()).unwrap()["fields"], serde_json::json!([]));
    }

    #[test]
    fn a_selection_answer_in_fields_is_folded_against_its_preset() {
        let extras = FootnoteExtras {
            mark_text: "Mr. Darcy bowed coldly".into(),
            reading: ReadingStyle { kind: "story".into(), fields: vec!["Context".into(), "Character".into()], fill: "best".into(), preset: String::new() },
            ..Default::default()
        };
        let submission = FootnoteSubmission {
            fields: vec![field("Character", "His stiffness reads as pride, though it may be shyness.")],
            ..Default::default()
        };
        let result = validate_submission(&submission, Some(&extras)).unwrap();
        assert_eq!(result.notes, ["**Character:** His stiffness reads as pride, though it may be shyness."]);
        assert_eq!(result.fields, ["Character"]);
        // Before the request is known, a fields-only answer passes the early check untouched.
        let early = validate_submission(&submission, None).unwrap();
        assert!(early.notes.is_empty());
        // A free-form request refuses fields.
        let free = FootnoteExtras { reading: ReadingStyle { kind: "story".into(), ..Default::default() }, ..extras.clone() };
        assert!(validate_submission(&submission, Some(&free)).is_err());
    }
}
