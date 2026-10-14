//! Page-range annotation jobs.
//!
//! The device sends the text of a run of pages (a chapter, say). An assistant
//! reads them a few at a time and sends back footnote *data* per page: the
//! words a footnote is about, plus its title, color, notes, links, marks and
//! library links. The hub only stores and checks that data; the device that
//! asked places each footnote on its page.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::footnotes::{
    self, FootnoteExtras, FootnoteFail, FootnoteLink, FootnoteMark, FootnoteResult, FootnoteSubmission,
    WorkspaceItem,
};
use super::write_transaction;

pub const MAX_PAGES: usize = 40;
/// Pages handed to an assistant per read, so a chapter fits in its context.
pub const PAGES_PER_READ: i64 = 5;
const PAGE_TEXT_CAP: usize = 12_000;
const DELIVERY_CAP: i64 = 100;

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS annotation_jobs (
            id TEXT PRIMARY KEY,
            device_id TEXT NOT NULL,
            doc_id TEXT NOT NULL,
            doc_name TEXT NOT NULL,
            doc_kind TEXT NOT NULL DEFAULT 'annotate',
            focus TEXT NOT NULL DEFAULT '',
            per_page INTEGER NOT NULL,
            pages TEXT NOT NULL,
            palette TEXT NOT NULL DEFAULT '[]',
            workspace_items TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL,
            summary TEXT,
            created_at INTEGER NOT NULL,
            finished_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_annotation_jobs_status ON annotation_jobs(status, created_at);
        CREATE TABLE IF NOT EXISTS annotation_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id TEXT NOT NULL,
            device_id TEXT NOT NULL,
            doc_id TEXT NOT NULL,
            page INTEGER NOT NULL,
            scope TEXT NOT NULL,
            item TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            acked_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_annotation_items_device ON annotation_items(device_id, acked_at);",
    )
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct JobPage {
    pub page: i64,
    #[serde(default)]
    pub scope: String,
    pub text: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NewJob {
    pub id: String,
    pub device_id: String,
    pub doc_id: String,
    pub doc_name: String,
    #[serde(default)]
    pub doc_kind: String,
    #[serde(default)]
    pub focus: String,
    /// Most footnotes an assistant may add to one page (2, 4 or 8).
    pub per_page: u8,
    pub pages: Vec<JobPage>,
    #[serde(default)]
    pub palette: Vec<String>,
    #[serde(default)]
    pub workspace_items: Vec<WorkspaceItem>,
}

/// One footnote as an assistant describes it for a page.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Annotation {
    /// Exact words on the page the footnote is about; the device places it there.
    pub quote: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub color: Option<u8>,
    #[serde(default)]
    pub notes: Vec<String>,
    #[serde(default)]
    pub links: Vec<FootnoteLink>,
    /// Highlights/underlines quoting words inside `quote`.
    #[serde(default)]
    pub marks: Vec<FootnoteMark>,
    #[serde(default)]
    pub workspace_links: Vec<String>,
}

/// What the device receives: the quote and a checked footnote result.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PlacedAnnotation {
    pub quote: String,
    pub result: FootnoteResult,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct JobSummary {
    pub id: String,
    pub doc_id: String,
    pub doc_name: String,
    pub page_from: i64,
    pub page_to: i64,
    pub focus: String,
    pub per_page: u8,
    pub pages_total: usize,
    pub pages_done: usize,
    pub footnotes: usize,
    pub status: String,
    pub created_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

fn invalid(message: impl Into<String>) -> FootnoteFail {
    FootnoteFail::Invalid(message.into())
}

/// Letters only, lowercased: the assistant reads the extracted text, which
/// spaces words differently from the page the reader sees.
fn squeezed(text: &str) -> String {
    text.chars().filter(|ch| !ch.is_whitespace()).flat_map(char::to_lowercase).collect()
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

fn validate_job(job: &NewJob) -> Result<(), FootnoteFail> {
    if !footnotes::valid_id(&job.id) {
        return Err(invalid("id must be 1..=100 characters of [A-Za-z0-9_-]"));
    }
    if job.device_id.is_empty() || job.doc_id.is_empty() || job.doc_id.chars().count() > 200 {
        return Err(invalid("device_id and doc_id are required"));
    }
    if !matches!(job.per_page, 1..=8) {
        return Err(invalid("per_page must be 1..=8"));
    }
    if job.pages.is_empty() || job.pages.len() > MAX_PAGES {
        return Err(invalid(format!("pages must have 1..={MAX_PAGES} entries")));
    }
    for page in &job.pages {
        if page.page < 1 || page.text.trim().is_empty() || page.text.chars().count() > PAGE_TEXT_CAP {
            return Err(invalid(format!("each page needs a number and 1..={PAGE_TEXT_CAP} characters of text")));
        }
    }
    if job.focus.chars().count() > 1000 {
        return Err(invalid("focus must be at most 1000 characters"));
    }
    footnotes::validate_extras(&FootnoteExtras {
        palette: job.palette.clone(),
        workspace_items: job.workspace_items.clone(),
        doc_kind: job.doc_kind.clone(),
        ..Default::default()
    })
    .map_err(FootnoteFail::Invalid)
}

pub fn create_job(conn: &Connection, job: NewJob, now: i64) -> Result<JobSummary, FootnoteFail> {
    validate_job(&job)?;
    transact(conn, || {
        let exists: Option<String> = conn
            .query_row("SELECT id FROM annotation_jobs WHERE id = ?1", params![job.id], |row| row.get(0))
            .optional()?;
        if exists.is_none() {
            conn.execute(
                "INSERT INTO annotation_jobs (id, device_id, doc_id, doc_name, doc_kind, focus, per_page,
                    pages, palette, workspace_items, status, summary, created_at, finished_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'open', NULL, ?11, NULL)",
                params![
                    job.id,
                    job.device_id,
                    job.doc_id,
                    job.doc_name,
                    if job.doc_kind.is_empty() { "annotate" } else { job.doc_kind.as_str() },
                    job.focus.trim(),
                    job.per_page,
                    serde_json::to_string(&job.pages)?,
                    serde_json::to_string(&job.palette)?,
                    serde_json::to_string(&job.workspace_items)?,
                    now,
                ],
            )?;
        }
        summary_of(conn, &job.id)?.ok_or(FootnoteFail::NotFound)
    })
}

struct JobRow {
    id: String,
    device_id: String,
    doc_id: String,
    doc_name: String,
    doc_kind: String,
    focus: String,
    per_page: u8,
    pages: Vec<JobPage>,
    palette: Vec<String>,
    workspace_items: Vec<WorkspaceItem>,
    status: String,
    summary: Option<String>,
    created_at: i64,
}

fn job_row(conn: &Connection, id: &str) -> Result<Option<JobRow>, FootnoteFail> {
    let raw = conn
        .query_row(
            "SELECT id, device_id, doc_id, doc_name, doc_kind, focus, per_page, pages, palette,
                    workspace_items, status, summary, created_at
             FROM annotation_jobs WHERE id = ?1",
            params![id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?,
                    row.get::<_, u8>(6)?, row.get::<_, String>(7)?, row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?, row.get::<_, String>(10)?, row.get::<_, Option<String>>(11)?,
                    row.get::<_, i64>(12)?,
                ))
            },
        )
        .optional()?;
    let Some((id, device_id, doc_id, doc_name, doc_kind, focus, per_page, pages, palette, items, status, summary, created_at)) = raw else {
        return Ok(None);
    };
    Ok(Some(JobRow {
        id,
        device_id,
        doc_id,
        doc_name,
        doc_kind,
        focus,
        per_page,
        pages: serde_json::from_str(&pages)?,
        palette: serde_json::from_str(&palette).unwrap_or_default(),
        workspace_items: serde_json::from_str(&items).unwrap_or_default(),
        status,
        summary,
        created_at,
    }))
}

fn counts(conn: &Connection, id: &str) -> Result<(usize, usize), FootnoteFail> {
    let (pages, items): (i64, i64) = conn.query_row(
        "SELECT COUNT(DISTINCT page), COUNT(*) FROM annotation_items WHERE job_id = ?1",
        params![id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    Ok((pages as usize, items as usize))
}

fn summary_of(conn: &Connection, id: &str) -> Result<Option<JobSummary>, FootnoteFail> {
    let Some(job) = job_row(conn, id)? else { return Ok(None) };
    let (pages_done, footnotes) = counts(conn, id)?;
    Ok(Some(JobSummary {
        page_from: job.pages.iter().map(|page| page.page).min().unwrap_or(0),
        page_to: job.pages.iter().map(|page| page.page).max().unwrap_or(0),
        pages_total: job.pages.len(),
        id: job.id,
        doc_id: job.doc_id,
        doc_name: job.doc_name,
        focus: job.focus,
        per_page: job.per_page,
        pages_done,
        footnotes,
        status: job.status,
        created_at: job.created_at,
        summary: job.summary,
    }))
}

fn summaries(conn: &Connection, sql: &str, args: &[&dyn rusqlite::ToSql]) -> Result<Vec<JobSummary>, FootnoteFail> {
    let mut stmt = conn.prepare(sql)?;
    let ids = stmt
        .query_map(args, |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    ids.iter().filter_map(|id| summary_of(conn, id).transpose()).collect()
}

/// Jobs waiting for an assistant, oldest first.
pub fn list_open(conn: &Connection) -> Result<Vec<JobSummary>, FootnoteFail> {
    summaries(conn, "SELECT id FROM annotation_jobs WHERE status = 'open' ORDER BY created_at ASC, id ASC LIMIT 20", &[])
}

/// A device's jobs on one document, newest first, for its progress list.
pub fn list_for_doc(conn: &Connection, device: &str, doc: &str) -> Result<Vec<JobSummary>, FootnoteFail> {
    summaries(
        conn,
        "SELECT id FROM annotation_jobs WHERE device_id = ?1 AND doc_id = ?2 ORDER BY created_at DESC, id DESC LIMIT 20",
        &[&device, &doc],
    )
}

/// The job's instructions plus the text of pages `from..=to` (at most five).
pub fn read_pages(conn: &Connection, id: &str, from: i64, to: i64) -> Result<Value, FootnoteFail> {
    let job = job_row(conn, id)?.ok_or(FootnoteFail::NotFound)?;
    let last = to.min(from + PAGES_PER_READ - 1);
    let mut done = conn.prepare("SELECT DISTINCT page FROM annotation_items WHERE job_id = ?1")?;
    let done: Vec<i64> = done.query_map(params![id], |row| row.get(0))?.collect::<Result<_, _>>()?;
    let pages: Vec<&JobPage> = job.pages.iter().filter(|page| page.page >= from && page.page <= last).collect();
    let all: Vec<i64> = job.pages.iter().map(|page| page.page).collect();
    Ok(json!({
        "id": job.id,
        "doc_name": job.doc_name,
        "status": job.status,
        "focus": job.focus,
        "per_page": job.per_page,
        "palette": job.palette,
        "workspace_items": job.workspace_items,
        "all_pages": all,
        "pages_done": done,
        "pages": pages.iter().map(|page| json!({ "page": page.page, "text": page.text })).collect::<Vec<_>>(),
        "next_from": job.pages.iter().map(|page| page.page).filter(|page| *page > last).min(),
    }))
}

/// Store one page's footnotes after checking each against the page and job.
pub fn submit_page(
    conn: &Connection,
    id: &str,
    page: i64,
    annotations: &[Annotation],
    now: i64,
) -> Result<usize, FootnoteFail> {
    transact(conn, || {
        let job = job_row(conn, id)?.ok_or(FootnoteFail::NotFound)?;
        if job.status != "open" {
            return Err(FootnoteFail::Conflict(format!("annotation job is {}", job.status)));
        }
        let Some(entry) = job.pages.iter().find(|candidate| candidate.page == page) else {
            return Err(invalid(format!("page {page} is not part of this job")));
        };
        let existing: i64 = conn.query_row(
            "SELECT COUNT(*) FROM annotation_items WHERE job_id = ?1 AND page = ?2",
            params![id, page],
            |row| row.get(0),
        )?;
        if annotations.is_empty() {
            return Err(invalid("annotations must have at least one entry"));
        }
        if existing as usize + annotations.len() > job.per_page as usize {
            return Err(invalid(format!(
                "at most {} footnotes per page for this job; page {page} already has {existing}",
                job.per_page
            )));
        }
        let page_text = squeezed(&entry.text);
        let mut placed = Vec::with_capacity(annotations.len());
        for annotation in annotations {
            let quote = annotation.quote.trim();
            if !(1..=1000).contains(&quote.chars().count()) {
                return Err(invalid("each quote must be 1..=1000 characters"));
            }
            if !page_text.contains(&squeezed(quote)) {
                return Err(invalid(format!("quote is not on page {page}: \"{quote}\"")));
            }
            let extras = FootnoteExtras {
                palette: job.palette.clone(),
                mark_text: quote.to_string(),
                workspace_items: job.workspace_items.clone(),
                doc_kind: job.doc_kind.clone(),
            };
            let submission = FootnoteSubmission {
                notes: annotation.notes.clone(),
                links: annotation.links.clone(),
                title: annotation.title.clone(),
                color: annotation.color,
                marks: annotation.marks.clone(),
                workspace_links: annotation.workspace_links.clone(),
            };
            let result = footnotes::validate_submission(&submission, Some(&extras))
                .map_err(|message| invalid(format!("page {page}, \"{quote}\": {message}")))?;
            placed.push(PlacedAnnotation { quote: quote.to_string(), result });
        }
        let scope = if entry.scope.is_empty() { format!("p{page}") } else { entry.scope.clone() };
        for item in &placed {
            conn.execute(
                "INSERT INTO annotation_items (job_id, device_id, doc_id, page, scope, item, created_at, acked_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)",
                params![id, job.device_id, job.doc_id, page, scope, serde_json::to_string(item)?, now],
            )?;
        }
        Ok(placed.len())
    })
}

pub fn finish_job(conn: &Connection, id: &str, summary: &str, now: i64) -> Result<(), FootnoteFail> {
    set_status(conn, id, "done", Some(summary.trim().chars().take(2000).collect()), now)
}

pub fn cancel_job(conn: &Connection, id: &str, now: i64) -> Result<(), FootnoteFail> {
    set_status(conn, id, "cancelled", None, now)
}

fn set_status(conn: &Connection, id: &str, status: &str, summary: Option<String>, now: i64) -> Result<(), FootnoteFail> {
    transact(conn, || {
        let job = job_row(conn, id)?.ok_or(FootnoteFail::NotFound)?;
        if job.status != "open" {
            return Err(FootnoteFail::Conflict(format!("annotation job is {}", job.status)));
        }
        conn.execute(
            "UPDATE annotation_jobs SET status = ?2, summary = COALESCE(?3, summary), finished_at = ?4 WHERE id = ?1",
            params![id, status, summary, now],
        )?;
        Ok(())
    })
}

/// Footnotes waiting for the device that asked, oldest first.
pub fn items_for_device(conn: &Connection, device: &str) -> Result<Vec<Value>, FootnoteFail> {
    if device.is_empty() {
        return Ok(Vec::new());
    }
    let mut stmt = conn.prepare(
        "SELECT i.id, i.job_id, i.doc_id, i.page, i.scope, i.item, j.palette, j.doc_kind
         FROM annotation_items i JOIN annotation_jobs j ON j.id = i.job_id
         WHERE i.device_id = ?1 AND i.acked_at IS NULL AND j.status != 'cancelled'
         ORDER BY i.id ASC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![device, DELIVERY_CAP], |row| {
        Ok((
            row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?,
            row.get::<_, String>(6)?, row.get::<_, String>(7)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (item_id, job_id, doc_id, page, scope, item, palette, doc_kind) = row?;
        let item: PlacedAnnotation = serde_json::from_str(&item)?;
        let palette: Vec<String> = serde_json::from_str(&palette).unwrap_or_default();
        out.push(json!({
            "item_id": item_id, "job_id": job_id, "doc_id": doc_id, "page": page, "scope": scope,
            "palette": palette, "doc_kind": doc_kind, "quote": item.quote, "result": item.result,
        }));
    }
    Ok(out)
}

pub fn ack_items(conn: &Connection, ids: &[i64], now: i64) -> Result<usize, FootnoteFail> {
    transact(conn, || {
        let mut changed = 0;
        for id in ids.iter().take(200) {
            changed += conn.execute(
                "UPDATE annotation_items SET acked_at = COALESCE(acked_at, ?2) WHERE id = ?1",
                params![id, now],
            )?;
        }
        Ok(changed)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open() -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::pads::open(&dir.path().join("pads.db")).unwrap();
        (dir, conn)
    }

    fn job(id: &str) -> NewJob {
        NewJob {
            id: id.into(),
            device_id: "tablet".into(),
            doc_id: "algo".into(),
            doc_name: "Algorithms".into(),
            doc_kind: "annotate".into(),
            focus: "key definitions".into(),
            per_page: 2,
            pages: vec![
                JobPage { page: 91, scope: "p91".into(), text: "Chapter 3 Decompositions of graphs. Depth-first search is a surprisingly versatile procedure.".into() },
                JobPage { page: 92, scope: "p92".into(), text: "A graph is specified by a set of vertices and edges.".into() },
            ],
            palette: vec!["#60a5fa".into(), "#f472b6".into(), "#facc15".into(), "#34d399".into()],
            workspace_items: vec![WorkspaceItem { id: "whiteboard:wb-1".into(), kind: "whiteboard".into(), title: "Graph notes".into() }],
        }
    }

    fn note(quote: &str) -> Annotation {
        Annotation { quote: quote.into(), notes: vec!["A note.".into()], ..Default::default() }
    }

    #[test]
    fn a_job_is_read_in_pages_and_its_footnotes_reach_the_device() {
        let (_dir, conn) = open();
        let created = create_job(&conn, job("aj-1"), 1).unwrap();
        assert_eq!((created.page_from, created.page_to, created.pages_total), (91, 92, 2));
        assert_eq!(list_open(&conn).unwrap().len(), 1);
        let read = read_pages(&conn, "aj-1", 91, 200).unwrap();
        assert_eq!(read["pages"].as_array().unwrap().len(), 2);
        assert_eq!(read["focus"], "key definitions");
        let annotation = Annotation {
            quote: "Depth-first  search is a surprisingly versatile procedure".into(),
            title: Some("DFS".into()),
            color: Some(2),
            notes: vec!["Explores as far as possible before backtracking.".into()],
            marks: vec![FootnoteMark { kind: "highlight".into(), quote: "depth-first search".into(), color: Some(3) }],
            workspace_links: vec!["whiteboard:wb-1".into()],
            ..Default::default()
        };
        assert_eq!(submit_page(&conn, "aj-1", 91, &[annotation], 2).unwrap(), 1);
        let items = items_for_device(&conn, "tablet").unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["scope"], "p91");
        assert_eq!(items[0]["result"]["title"], "DFS");
        assert_eq!(items[0]["result"]["workspace_links"][0]["title"], "Graph notes");
        assert_eq!(items[0]["palette"][1], "#f472b6");
        let id = items[0]["item_id"].as_i64().unwrap();
        ack_items(&conn, &[id], 3).unwrap();
        assert!(items_for_device(&conn, "tablet").unwrap().is_empty());
        finish_job(&conn, "aj-1", "Annotated 1 page.", 4).unwrap();
        assert!(list_open(&conn).unwrap().is_empty());
        let mine = list_for_doc(&conn, "tablet", "algo").unwrap();
        assert_eq!((mine[0].status.as_str(), mine[0].footnotes, mine[0].pages_done), ("done", 1, 1));
    }

    #[test]
    fn page_answers_are_checked_against_the_page_and_job() {
        let (_dir, conn) = open();
        create_job(&conn, job("aj-2"), 1).unwrap();
        for (name, page, annotations) in [
            ("not-in-job", 93, vec![note("graph")]),
            ("not-on-page", 92, vec![note("depth-first search")]),
            ("too-many", 92, vec![note("graph"), note("vertices"), note("edges")]),
            ("mark-outside-quote", 92, vec![Annotation { marks: vec![FootnoteMark { kind: "underline".into(), quote: "edges".into(), color: None }], ..note("set of vertices") }]),
            ("bad-slot", 92, vec![Annotation { color: Some(7), ..note("graph") }]),
            ("no-notes", 92, vec![Annotation { notes: vec![], ..note("graph") }]),
        ] {
            let err = submit_page(&conn, "aj-2", page, &annotations, 2).expect_err(name);
            assert!(matches!(err, FootnoteFail::Invalid(_)), "{name}: {err:?}");
        }
        submit_page(&conn, "aj-2", 92, &[note("graph"), note("vertices")], 2).unwrap();
        assert!(matches!(submit_page(&conn, "aj-2", 92, &[note("edges")], 3), Err(FootnoteFail::Invalid(_))));
    }

    #[test]
    fn cancelled_jobs_take_no_more_answers_and_deliver_nothing() {
        let (_dir, conn) = open();
        create_job(&conn, job("aj-3"), 1).unwrap();
        submit_page(&conn, "aj-3", 91, &[note("Depth-first search")], 2).unwrap();
        cancel_job(&conn, "aj-3", 3).unwrap();
        assert!(items_for_device(&conn, "tablet").unwrap().is_empty());
        assert!(matches!(submit_page(&conn, "aj-3", 92, &[note("graph")], 4), Err(FootnoteFail::Conflict(_))));
        assert!(matches!(cancel_job(&conn, "aj-3", 5), Err(FootnoteFail::Conflict(_))));
    }

    #[test]
    fn jobs_are_validated_when_they_are_made() {
        let (_dir, conn) = open();
        let mut too_many = job("aj-4");
        too_many.pages = (1..=41).map(|page| JobPage { page, scope: String::new(), text: "x".into() }).collect();
        let mut empty_page = job("aj-5");
        empty_page.pages[0].text = "  ".into();
        let mut density = job("aj-6");
        density.per_page = 9;
        for (name, bad) in [("pages", too_many), ("empty", empty_page), ("density", density)] {
            assert!(matches!(create_job(&conn, bad, 1), Err(FootnoteFail::Invalid(_))), "{name}");
        }
        // Creating the same job twice is a no-op, so a retried request is safe.
        create_job(&conn, job("aj-7"), 1).unwrap();
        create_job(&conn, job("aj-7"), 2).unwrap();
        assert_eq!(list_open(&conn).unwrap().len(), 1);
    }
}
