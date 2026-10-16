//! Execution and progress reporting for the existing Ask and problem Draw tools.
//!
//! Context variants encode the two existing tool sets. Ask historically handles
//! unsolicited calls too (including draws when they were not advertised), and
//! reports unknown names as text; problem Draw rejects names outside its set.
//! Keep those rules and each path's wording here rather than strengthening them.

use anyhow::Result;

use crate::config::Config;
use crate::docs_index;
use crate::llm::coach::{
    validate_citation, validate_highlight, Annotation, BoardSnapshot, Citation, EventSink,
    Highlight, ToolStatus,
};
use crate::llm::docs::{ArtifactProposal, AskContext, ProposedAnnotation};
use crate::llm::viz::VizProgram;
use crate::llm::ToolCall;
use crate::problem::IoCase;

/// The allowed tool handling and validation data for one run.
pub enum ToolContext<'a> {
    Ask {
        cfg: &'a Config,
        document: &'a AskContext,
        max_attachments: usize,
    },
    ProblemViz {
        cases: &'a [IoCase],
        board: &'a BoardSnapshot,
    },
}

/// Accepted proposals and rejection reasons, adapted into the caller's envelope.
#[derive(Default)]
pub struct ToolEnvelope {
    pub programs: Vec<VizProgram>,
    pub annotations: Vec<Annotation>,
    pub citations: Vec<Citation>,
    pub highlights: Vec<Highlight>,
    pub rejected: Vec<String>,
    pub artifacts: Vec<ArtifactProposal>,
    pub proposed: Vec<ProposedAnnotation>,
}

/// Validate and record one proposed call, emitting its ordered tool events.
///
/// Ask returns feedback for the next model turn and propagates retrieval/search
/// errors. ProblemViz does no I/O and always returns `Ok(None)`.
pub fn execute_tool(
    call: &ToolCall,
    context: &ToolContext<'_>,
    envelope: &mut ToolEnvelope,
    events: &EventSink,
) -> Result<Option<String>> {
    let ask = matches!(context, ToolContext::Ask { .. });
    events.tool(
        &call.name,
        ToolStatus::Proposed,
        if ask {
            tool_summary(&call.name)
        } else {
            &call.name
        },
        None,
    );

    let feedback = match call.name.as_str() {
        "draw_structure" | "animate_trace" => {
            match serde_json::from_value::<VizProgram>(call.arguments.clone()) {
                Ok(program) => match program.rejection() {
                    None => {
                        let detail = if program.title.trim().is_empty() {
                            program.id.clone()
                        } else if ask {
                            program.title.clone()
                        } else {
                            program.title.trim().to_string()
                        };
                        events.tool(&call.name, ToolStatus::Accepted, &detail, None);
                        let feedback =
                            format!("{}: queued a diagram ({detail}) for the board", call.name);
                        envelope.programs.push(program);
                        feedback
                    }
                    Some(why) => {
                        let dropped = format!("dropped a diagram: {why}");
                        reject(
                            call,
                            envelope,
                            events,
                            if ask { why } else { dropped.clone() },
                            ask,
                        );
                        format!("{}: {dropped}", call.name)
                    }
                },
                Err(err) => {
                    let why = format!("unreadable {} call: {err}", call.name);
                    reject(call, envelope, events, why.clone(), ask);
                    format!("{}: {why}", call.name)
                }
            }
        }
        "create_attachment" if ask => {
            let ToolContext::Ask {
                max_attachments, ..
            } = context
            else {
                unreachable!()
            };
            let result = serde_json::from_value::<ArtifactProposal>(call.arguments.clone())
                .map_err(anyhow::Error::from)
                .and_then(|proposal| {
                    proposal.validate()?;
                    anyhow::ensure!(
                        envelope.artifacts.len() < *max_attachments,
                        "too many attachments in one answer"
                    );
                    Ok(proposal)
                });
            match result {
                Ok(proposal) => {
                    events.tool(
                        &call.name,
                        ToolStatus::Accepted,
                        format!("Preparing {}", proposal.title),
                        None,
                    );
                    envelope.artifacts.push(proposal);
                    format!("{}: prepared attachment content for the client to save; persistence is not yet confirmed", call.name)
                }
                Err(error) => {
                    events.tool(
                        &call.name,
                        ToolStatus::Rejected,
                        "Invalid attachment",
                        Some(error.to_string()),
                    );
                    format!("{}: rejected: {error}", call.name)
                }
            }
        }
        "annotate_region" => match context {
            ToolContext::Ask { .. } => accepted_text(
                call,
                events,
                "this pad has no named regions (approach/walkthrough/…). \
                 skip annotate_region rather than inventing Practice board pages.",
            ),
            ToolContext::ProblemViz { .. } => {
                match serde_json::from_value::<Annotation>(call.arguments.clone()) {
                    Ok(annotation) if !annotation.text.trim().is_empty() => {
                        events.tool(
                            &call.name,
                            ToolStatus::Accepted,
                            format!("note on {}", annotation.region),
                            None,
                        );
                        envelope.annotations.push(annotation);
                    }
                    _ => reject(
                        call,
                        envelope,
                        events,
                        "dropped an empty annotation".into(),
                        false,
                    ),
                }
                String::new()
            }
        },
        "cite_test_case" => match context {
            ToolContext::Ask { .. } => accepted_text(
                call,
                events,
                "cite_test_case is only for corpus problems with sample cases.",
            ),
            ToolContext::ProblemViz { cases, .. } => {
                match validate_citation(&call.arguments, cases) {
                    Some(citation) => {
                        events.tool(
                            &call.name,
                            ToolStatus::Accepted,
                            format!("case {}", citation.case_number),
                            None,
                        );
                        envelope.citations.push(citation);
                    }
                    None => reject(
                        call,
                        envelope,
                        events,
                        format!(
                            "dropped a citation: no such case (this problem has {} sample cases)",
                            cases.len()
                        ),
                        false,
                    ),
                }
                String::new()
            }
        },
        _ => match context {
            ToolContext::Ask { cfg, document, .. } => {
                let (text, annotation) = dispatch_tool(cfg, document, &call.name, &call.arguments)?;
                let feedback = accepted_text(call, events, &text);
                if let Some(annotation) = annotation {
                    envelope.proposed.push(annotation);
                }
                feedback
            }
            ToolContext::ProblemViz { board, .. } if call.name == "highlight_student_work" => {
                match validate_highlight(&call.arguments, board) {
                    Some(highlight) => {
                        events.tool(
                            &call.name,
                            ToolStatus::Accepted,
                            format!("{} element(s)", highlight.ids.len()),
                            None,
                        );
                        envelope.highlights.push(highlight);
                    }
                    None => reject(
                        call,
                        envelope,
                        events,
                        "dropped a highlight: no matching element ids on the board".into(),
                        false,
                    ),
                }
                String::new()
            }
            ToolContext::ProblemViz { .. } => {
                reject(
                    call,
                    envelope,
                    events,
                    format!("ignored an unknown tool call {:?}", call.name),
                    false,
                );
                String::new()
            }
        },
    };
    Ok(ask.then_some(feedback))
}

fn accepted_text(call: &ToolCall, events: &EventSink, text: &str) -> String {
    events.tool(
        &call.name,
        ToolStatus::Accepted,
        clip_tool_detail(text),
        None,
    );
    format!("{}: {text}", call.name)
}

fn reject(
    call: &ToolCall,
    envelope: &mut ToolEnvelope,
    events: &EventSink,
    why: String,
    ask: bool,
) {
    events.tool(
        &call.name,
        ToolStatus::Rejected,
        &call.name,
        Some(why.clone()),
    );
    if !ask {
        envelope.rejected.push(why);
    }
}

impl ArtifactProposal {
    pub(crate) fn validate(&self) -> Result<()> {
        anyhow::ensure!(
            matches!(self.kind.as_str(), "whiteboard" | "code" | "markdown"),
            "unsupported attachment kind"
        );
        anyhow::ensure!(
            !self.title.trim().is_empty() && self.title.len() <= 256,
            "attachment title must be 1–256 bytes"
        );
        anyhow::ensure!(
            self.source.len() <= 512_000 && self.programs.len() <= 8,
            "attachment is too large"
        );
        anyhow::ensure!(
            self.kind == "whiteboard" || self.programs.is_empty(),
            "document attachments use source, not diagram programs"
        );
        anyhow::ensure!(
            self.kind != "whiteboard" || self.source.is_empty(),
            "whiteboard attachments use programs, not source"
        );
        let mut ids = std::collections::HashSet::new();
        for program in &self.programs {
            anyhow::ensure!(ids.insert(&program.id), "duplicate diagram ID");
            if let Some(why) = program.rejection() {
                anyhow::bail!("{why}");
            }
        }
        Ok(())
    }
}

fn tool_summary(name: &str) -> &'static str {
    match name {
        "query_document_vectors" => "searching the book",
        "query_library_vectors" => "searching your library",
        "get_document_section" => "opening a section",
        "lookup_reference" => "checking a citation",
        "get_current_page" => "reading this page",
        "get_highlight" => "re-reading the highlight",
        "list_document_marks" => "listing annotations",
        "save_annotation" => "pinning a tab",
        "search_web" => "searching the web",
        "draw_structure" => "drawing a structure",
        "animate_trace" => "animating a trace",
        "annotate_region" => "annotating a region",
        _ => "calling a tool",
    }
}

fn clip_tool_detail(text: &str) -> String {
    let t = text.trim();
    let mut out: String = t.chars().take(280).collect();
    if t.chars().count() > 280 {
        out.push('…');
    }
    out
}

pub(crate) fn dispatch_tool(
    cfg: &Config,
    ctx: &AskContext,
    name: &str,
    args: &serde_json::Value,
) -> Result<(String, Option<ProposedAnnotation>)> {
    match name {
        "query_document_vectors" => {
            let Some(hash) = ctx.document_hash.as_deref() else {
                return Ok(("no document index on this Ask".into(), None));
            };
            let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
            let k = args.get("k").and_then(|v| v.as_u64()).unwrap_or(4) as usize;
            let path = docs_index::db_path()?;
            let conn = docs_index::open(&path)?;
            let hits = docs_index::retrieve(&conn, hash, query, k, cfg)?;
            Ok((docs_index::format_retrieval(&hits), None))
        }
        /*
         * The library, not the open book.
         *
         * Deliberately a separate tool rather than a flag on the first one. The
         * model picks by what the question is about, and the two have different
         * costs: this scans every eligible document, and its answer has to name
         * which book each passage came from or it is no use in a library.
         *
         * The scope line comes back with the passages, so an answer built from
         * a partial library says so instead of sounding complete.
         */
        "query_library_vectors" => {
            let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
            let k = args.get("k").and_then(|v| v.as_u64()).unwrap_or(4) as usize;
            let path = docs_index::db_path()?;
            let conn = docs_index::open(&path)?;
            let (hits, scope) = docs_index::retrieve_library(&conn, query, k, cfg)?;
            if hits.is_empty() {
                return Ok((docs_index::library_scope_line(&scope), None));
            }
            Ok((docs_index::format_library_retrieval(&hits, &scope), None))
        }
        "get_document_section" => {
            let Some(hash) = ctx.document_hash.as_deref() else {
                return Ok(("no document index on this Ask".into(), None));
            };
            let name = args
                .get("section_name")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let path = docs_index::db_path()?;
            let conn = docs_index::open(&path)?;
            match docs_index::section_text(&conn, hash, name) {
                Ok(text) => Ok((text, None)),
                Err(err) => Ok((err.to_string(), None)),
            }
        }
        "lookup_reference" => {
            let Some(hash) = ctx.document_hash.as_deref() else {
                return Ok(("no document index on this Ask".into(), None));
            };
            let n = args.get("n").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let path = docs_index::db_path()?;
            let conn = docs_index::open(&path)?;
            match docs_index::lookup_reference(&conn, hash, n) {
                Ok(text) => Ok((text, None)),
                Err(err) => Ok((err.to_string(), None)),
            }
        }
        "get_current_page" => {
            let text = ctx.page_text.trim();
            if text.is_empty() {
                Ok(("no page text was sent with this Ask".into(), None))
            } else {
                let clipped: String = text.chars().take(4000).collect();
                Ok((clipped, None))
            }
        }
        "get_highlight" => {
            if ctx.highlight.trim().is_empty() {
                Ok(("no highlight was sent".into(), None))
            } else {
                Ok((ctx.highlight.clone(), None))
            }
        }
        "list_document_marks" => {
            if ctx.marks_prose.trim().is_empty() {
                Ok(("no annotations packed into this Ask".into(), None))
            } else {
                Ok((ctx.marks_prose.clone(), None))
            }
        }
        "save_annotation" => {
            let ann = ProposedAnnotation {
                excerpt: args
                    .get("excerpt")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                note: args
                    .get("note")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                tags: args
                    .get("tags")
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default(),
                page: args.get("page").and_then(|v| v.as_u64()).map(|n| n as u32),
                links: args
                    .get("links")
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default(),
            };
            Ok((
                "queued an AI book-tab; the tablet will place it".into(),
                Some(ann),
            ))
        }
        "search_web" => {
            let Some(base) = cfg.searxng_url() else {
                return Ok(("web search is not configured".into(), None));
            };
            let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
            let n = args
                .get("num_results")
                .and_then(|v| v.as_u64())
                .unwrap_or(3) as usize;
            Ok((search_web_snippets(base, query, n)?, None))
        }
        other => Ok((format!("unknown tool {other}"), None)),
    }
}

fn search_web_snippets(base: &str, query: &str, n: usize) -> Result<String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()?;
    let url = format!("{}/search", base.trim_end_matches('/'));
    let value: serde_json::Value = client
        .get(&url)
        .query(&[("q", query), ("format", "json")])
        .send()?
        .json()?;
    let results = value
        .get("results")
        .and_then(|r| r.as_array())
        .cloned()
        .unwrap_or_default();
    let mut lines = Vec::new();
    for item in results.iter().take(n.max(1).min(5)) {
        let title = item.get("title").and_then(|v| v.as_str()).unwrap_or("");
        let content = item
            .get("content")
            .or_else(|| item.get("snippet"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let href = item.get("url").and_then(|v| v.as_str()).unwrap_or("");
        if title.is_empty() && content.is_empty() {
            continue;
        }
        lines.push(format!("{title} — {href}\n{content}"));
    }
    if lines.is_empty() {
        Ok("no snippets".into())
    } else {
        Ok(lines.join("\n\n"))
    }
}
