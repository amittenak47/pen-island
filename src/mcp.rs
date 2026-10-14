//! `lc mcp` — stdio MCP server for the footnote inbox.
//!
//! JSON-RPC messages are the only bytes on stdout. The hub is the only writer
//! of the inbox; this process just calls it over HTTP.

use std::io::{BufRead, Write};

use anyhow::{Context, Result};
use serde_json::{json, Value};

use crate::config::Config;
use crate::pads::footnotes::{self, FootnoteLink, FootnoteSubmission};

/// How the inbox works, sent to every assistant when it connects. Assistants
/// only act when prompted or scheduled, so this asks them to offer the watch.
pub const WORKFLOW: &str = "You are connected to a reader's Pen Island footnote inbox. The reader selects text in a document and asks for a footnote; each request waits here until an assistant answers it. To answer: call list_footnote_requests, then for each request call get_footnote_request and submit_footnote. Only answer requests listed here, and never invent request ids. If the inbox is empty, say so. If you can run scheduled or repeating tasks, offer to check the inbox every few minutes and answer new requests as they arrive.";

/// Ready-made prompts: (name, title, description, text sent as the user's message).
pub const PROMPTS: &[(&str, &str, &str, &str)] = &[
    (
        "answer_footnotes",
        "Answer my footnote requests",
        "Answer every pending footnote request once.",
        "Answer my pending Pen Island footnote requests: list them, read each one, and submit a footnote for each. Then tell me how many you answered.",
    ),
    (
        "watch_footnotes",
        "Keep answering footnote requests",
        "Answer pending requests now, then keep checking for new ones.",
        "Answer my pending Pen Island footnote requests now, then keep checking every few minutes and answer new ones as they arrive. If you can't run scheduled or repeating tasks, tell me so, and just answer the current ones.",
    ),
];

pub const INSTRUCTIONS: &str = "Explain the selected words in the context of the surrounding text, for a reader who is in the middle of this document. 1-3 short markdown notes; lead with the direct explanation; add links only to sources you are confident exist. If the request has a prompt, follow it.";

const SUPPORTED_PROTOCOLS: &[&str] = &["2024-11-05", "2025-03-26", "2025-06-18"];
const FALLBACK_PROTOCOL: &str = "2025-06-18";

pub trait FootnoteHub {
    fn list_pending(&self) -> Result<Value, String>;
    fn get(&self, id: &str) -> Result<Value, String>;
    fn submit(&self, id: &str, submission: &FootnoteSubmission) -> Result<Value, String>;
}

pub struct HttpFootnoteHub {
    base: String,
    token: Option<String>,
    client: reqwest::blocking::Client,
}

impl HttpFootnoteHub {
    pub fn new(base: String, token: Option<String>) -> Result<Self> {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .context("cannot build the hub client")?;
        Ok(Self {
            base: base.trim_end_matches('/').to_string(),
            token,
            client,
        })
    }

    fn send(&self, builder: reqwest::blocking::RequestBuilder) -> Result<Value, String> {
        let builder = match &self.token {
            Some(token) => builder.header("x-lc-token", token),
            None => builder,
        };
        let response = builder.send().map_err(|err| format!("hub request failed: {err}"))?;
        let status = response.status();
        let text = response.text().map_err(|err| format!("hub response: {err}"))?;
        if status.is_success() {
            if text.trim().is_empty() {
                return Ok(json!({ "ok": true }));
            }
            return serde_json::from_str(&text).map_err(|err| format!("hub response was not JSON: {err}"));
        }
        let message = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|value| value.get("error").and_then(Value::as_str).map(str::to_string))
            .filter(|message| !message.is_empty())
            .unwrap_or_else(|| {
                if text.trim().is_empty() {
                    format!("hub status {}", status.as_u16())
                } else {
                    text
                }
            });
        Err(message)
    }
}

impl FootnoteHub for HttpFootnoteHub {
    fn list_pending(&self) -> Result<Value, String> {
        self.send(self.client.get(format!("{}/footnote-requests?status=pending", self.base)))
    }

    fn get(&self, id: &str) -> Result<Value, String> {
        self.send(self.client.get(format!("{}/footnote-requests/{id}", self.base)))
    }

    fn submit(&self, id: &str, submission: &FootnoteSubmission) -> Result<Value, String> {
        let body = serde_json::to_value(submission).map_err(|err| format!("answer could not be encoded: {err}"))?;
        self.send(
            self.client
                .post(format!("{}/footnote-requests/{id}/result", self.base))
                .json(&body),
        )
    }
}

pub fn serve_from_config(hub: Option<String>) -> Result<()> {
    let cfg = Config::load()?;
    let base = hub.unwrap_or_else(|| format!("http://127.0.0.1:{}", cfg.serve.port));
    let client = HttpFootnoteHub::new(base, cfg.serve.token)?;
    serve(&client)
}

/// A private HTTP adapter for clients/tunnels that do not launch stdio servers.
/// Only footnote tools are exposed; the LAN hub's other routes stay private.
pub fn serve_http_from_config(hub: Option<String>, address: std::net::SocketAddr, token_file: Option<&std::path::Path>) -> Result<()> {
    anyhow::ensure!(address.ip().is_loopback(), "MCP HTTP must listen on a loopback address; use an authenticated private tunnel for cloud assistants");
    let token_file = token_file.context("MCP HTTP requires --auth-token-file with a separate strong bearer token; do not use the LAN pairing code")?;
    let token = std::fs::read_to_string(token_file).context("cannot read the MCP bearer token file")?;
    let token = token.trim();
    anyhow::ensure!(valid_http_token(token), "MCP bearer token must contain 32 to 256 ASCII letters, digits, '-' or '_'");
    let token = token.to_owned();
    let cfg = Config::load()?;
    let base = hub.unwrap_or_else(|| format!("http://127.0.0.1:{}", cfg.serve.port));
    // Construct/drop reqwest's blocking client outside the async runtime.
    let client = std::sync::Arc::new(HttpFootnoteHub::new(base, cfg.serve.token)?);
    tokio::runtime::Runtime::new()?.block_on(async {
        let listener = tokio::net::TcpListener::bind(address).await?;
        eprintln!("ChatBot MCP: http://{}/mcp", listener.local_addr()?);
        axum::serve(listener, http_router(client.clone(), address, token)).await?;
        Ok(())
    })
}

fn valid_http_token(token: &str) -> bool {
    (32..=256).contains(&token.len()) && token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[derive(Clone)]
struct HttpGuard {
    address: std::net::SocketAddr,
    token: String,
}

fn http_router(hub: std::sync::Arc<dyn FootnoteHub + Send + Sync>, address: std::net::SocketAddr, token: String) -> axum::Router {
    use axum::{extract::{DefaultBodyLimit, Request, State}, http::StatusCode, middleware::{self, Next}, response::{IntoResponse, Response}, routing::post, Json};
    async fn guard(State(guard): State<HttpGuard>, request: Request, next: Next) -> Response {
        let mut headers = request.headers().get_all("authorization").iter();
        let supplied = headers.next().and_then(|header| header.to_str().ok())
            .and_then(|header| header.split_once(' '))
            .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("Bearer"))
            .map(|(_, value)| value);
        if headers.next().is_some() || !supplied.is_some_and(|token| crate::serve::constant_time_eq(token.as_bytes(), guard.token.as_bytes())) {
            return (StatusCode::UNAUTHORIZED, [("www-authenticate", "Bearer realm=\"Pen Island MCP\"")]).into_response();
        }
        let address = guard.address;
        if let Some(origin) = request.headers().get("origin") {
            // Compare the complete origin, never prefixes (localhost.evil etc.).
            let allowed = [format!("http://{address}"), format!("http://localhost:{}", address.port())];
            if !origin.to_str().ok().is_some_and(|origin| allowed.iter().any(|value| value == origin)) {
                return StatusCode::FORBIDDEN.into_response();
            }
        }
        if let Some(version) = request.headers().get("mcp-protocol-version") {
            if !version.to_str().ok().is_some_and(|version| SUPPORTED_PROTOCOLS.contains(&version)) {
                return StatusCode::BAD_REQUEST.into_response();
            }
        }
        next.run(request).await
    }
    async fn handle(State(hub): State<std::sync::Arc<dyn FootnoteHub + Send + Sync>>, Json(message): Json<Value>) -> Response {
        if !message.is_object() || message.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
            return (StatusCode::BAD_REQUEST, Json(error_reply(&Value::Null, -32600, "Invalid Request"))).into_response();
        }
        match tokio::task::spawn_blocking(move || dispatch(hub.as_ref(), &message)).await {
            Ok(Some(reply)) => Json(reply).into_response(),
            Ok(None) => StatusCode::ACCEPTED.into_response(),
            Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        }
    }
    axum::Router::new()
        .route("/mcp", post(handle).get(|| async { StatusCode::METHOD_NOT_ALLOWED }))
        .route_layer(middleware::from_fn_with_state(HttpGuard { address, token }, guard))
        .layer(DefaultBodyLimit::max(1024 * 1024))
        .with_state(hub)
}

/// Newline-delimited JSON-RPC on stdin/stdout. Notifications get no reply.
pub fn serve(hub: &dyn FootnoteHub) -> Result<()> {
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    let mut stdout = std::io::stdout().lock();
    let mut line = String::new();
    loop {
        line.clear();
        let read = input.read_line(&mut line).context("reading mcp stdin")?;
        if read == 0 {
            return Ok(());
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(trimmed) {
            Ok(message) => dispatch(hub, &message),
            Err(_) => Some(error_reply(&Value::Null, -32700, "Parse error")),
        };
        if let Some(reply) = reply {
            writeln!(stdout, "{}", serde_json::to_string(&reply)?)?;
            stdout.flush()?;
        }
    }
}

/// `None` when the message is a notification and must not be answered.
pub fn dispatch(hub: &dyn FootnoteHub, message: &Value) -> Option<Value> {
    let id = message.get("id").filter(|id| !id.is_null());
    let method = message.get("method").and_then(Value::as_str);
    let Some(method) = method else {
        return id.map(|id| error_reply(id, -32600, "Invalid Request"));
    };
    let Some(id) = id else {
        return None;
    };
    let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
    Some(match method {
        "initialize" => result_reply(id, initialize_result(&params)),
        "ping" => result_reply(id, json!({})),
        "tools/list" => result_reply(id, json!({ "tools": tool_list() })),
        "prompts/list" => result_reply(id, json!({ "prompts": prompt_list() })),
        "prompts/get" => match get_prompt(&params) {
            Some(prompt) => result_reply(id, prompt),
            None => error_reply(id, -32602, "Unknown prompt"),
        },
        "tools/call" => result_reply(id, call_tool(hub, &params)),
        _ => error_reply(id, -32601, "Method not found"),
    })
}

fn initialize_result(params: &Value) -> Value {
    let requested = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
    let protocol = if SUPPORTED_PROTOCOLS.contains(&requested) {
        requested
    } else {
        FALLBACK_PROTOCOL
    };
    json!({
        "protocolVersion": protocol,
        "capabilities": { "tools": {}, "prompts": {} },
        "serverInfo": { "name": "lc-footnotes", "version": env!("CARGO_PKG_VERSION") },
        "instructions": server_instructions(),
    })
}

/// The inbox workflow, then the house style for each footnote.
pub fn server_instructions() -> String {
    format!("{WORKFLOW}\n\nHow to write each footnote: {INSTRUCTIONS}")
}

fn prompt_list() -> Vec<Value> {
    PROMPTS
        .iter()
        .map(|(name, title, description, _)| json!({
            "name": name,
            "title": title,
            "description": description,
            "arguments": [],
        }))
        .collect()
}

fn get_prompt(params: &Value) -> Option<Value> {
    let name = params.get("name").and_then(Value::as_str)?;
    let (_, _, description, text) = PROMPTS.iter().find(|(candidate, ..)| *candidate == name)?;
    Some(json!({
        "description": description,
        "messages": [{ "role": "user", "content": { "type": "text", "text": text } }],
    }))
}

fn tool_list() -> Vec<Value> {
    vec![
        json!({
            "name": "list_footnote_requests",
            "annotations": { "readOnlyHint": true, "openWorldHint": false },
            "description": "List pending footnote requests, oldest first. Each item has id, doc_name, page, excerpt, context, prompt, and created_at.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
        }),
        json!({
            "name": "get_footnote_request",
            "annotations": { "readOnlyHint": true, "openWorldHint": false },
            "description": "Fetch one footnote request, including wide_context, page_footnotes (other footnotes already on that page) and extras: palette (the mark's colors; refer to them by slot number, 1 = first), mark_text (the exact marked text; quote from it for marks) and workspace_items (the reader's library items you may link by id).",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"],
                "additionalProperties": false,
            },
        }),
        json!({
            "name": "submit_footnote",
            "annotations": { "readOnlyHint": false, "destructiveHint": false, "openWorldHint": false },
            "description": format!("Store the footnote for a pending request. Everything you send is added to the reader's footnote; nothing of theirs is replaced. {INSTRUCTIONS} Optionally give it a short title and a palette color, highlight or underline key words by quoting them exactly from mark_text, and link relevant library items from workspace_items."),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "notes": { "type": "array", "items": { "type": "string" }, "minItems": 1, "maxItems": 8 },
                    "links": {
                        "type": "array",
                        "description": "Web pages that help (http or https), up to 8.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "title": { "type": "string" },
                                "url": { "type": "string" },
                            },
                            "required": ["url"],
                        },
                    },
                    "title": { "type": "string", "maxLength": 120, "description": "A short label for the footnote. Used only if the reader hasn't titled it." },
                    "color": { "type": "integer", "minimum": 1, "maximum": 8, "description": "Palette slot for the footnote's color (1 = first color in extras.palette). Used only if the reader hasn't colored it." },
                    "marks": {
                        "type": "array",
                        "maxItems": 12,
                        "description": "Highlight or underline words inside the marked text.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "kind": { "type": "string", "enum": ["highlight", "underline"] },
                                "quote": { "type": "string", "description": "Exact words copied from extras.mark_text." },
                                "color": { "type": "integer", "minimum": 1, "maximum": 8, "description": "Optional palette slot." },
                            },
                            "required": ["kind", "quote"],
                        },
                    },
                    "workspace_links": {
                        "type": "array",
                        "maxItems": 8,
                        "items": { "type": "string" },
                        "description": "Ids from extras.workspace_items to link, such as a related notebook or document.",
                    },
                },
                "required": ["id", "notes"],
                "additionalProperties": false,
            },
        }),
    ]
}

fn call_tool(hub: &dyn FootnoteHub, params: &Value) -> Value {
    let name = params.get("name").and_then(Value::as_str).unwrap_or("");
    let arguments = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
    let outcome = match name {
        "list_footnote_requests" => hub.list_pending(),
        "get_footnote_request" => match arguments.get("id").and_then(Value::as_str) {
            Some(id) if footnotes::valid_id(id) => hub.get(id),
            _ => Err("id must be a request id from list_footnote_requests".into()),
        },
        "submit_footnote" => submit_tool(hub, &arguments),
        _ => Err(format!("unknown tool {name}")),
    };
    match outcome {
        Ok(value) => tool_text(&serde_json::to_string(&value).unwrap_or_else(|_| "null".into()), false),
        Err(message) => tool_text(&message, true),
    }
}

fn submit_tool(hub: &dyn FootnoteHub, arguments: &Value) -> Result<Value, String> {
    let id = arguments.get("id").and_then(Value::as_str).unwrap_or("");
    if !footnotes::valid_id(id) {
        return Err("id must be a request id from list_footnote_requests".into());
    }
    let Some(raw_notes) = arguments.get("notes").and_then(Value::as_array) else {
        return Err("notes must be an array of strings".into());
    };
    let mut notes = Vec::with_capacity(raw_notes.len());
    for note in raw_notes {
        let Some(text) = note.as_str() else {
            return Err("notes must be an array of strings".into());
        };
        notes.push(text.to_string());
    }
    let mut links = Vec::new();
    if let Some(raw_links) = arguments.get("links").and_then(Value::as_array) {
        for link in raw_links {
            let url = link.get("url").and_then(Value::as_str).unwrap_or("").to_string();
            let title = link.get("title").and_then(Value::as_str).map(str::to_string);
            links.push(FootnoteLink { title, url });
        }
    } else if arguments.get("links").is_some() && !arguments.get("links").is_some_and(Value::is_null) {
        return Err("links must be an array".into());
    }
    let rich = |key: &str| arguments.get(key).filter(|value| !value.is_null()).cloned();
    let title: Option<String> = rich("title").map(serde_json::from_value).transpose()
        .map_err(|_| "title must be a string".to_string())?;
    let color: Option<u8> = rich("color").map(serde_json::from_value).transpose()
        .map_err(|_| "color must be a palette slot number".to_string())?;
    let marks: Vec<footnotes::FootnoteMark> = rich("marks").map(serde_json::from_value).transpose()
        .map_err(|_| "marks must be objects with kind, quote and optional color".to_string())?
        .unwrap_or_default();
    let workspace_links: Vec<String> = rich("workspace_links").map(serde_json::from_value).transpose()
        .map_err(|_| "workspace_links must be an array of ids".to_string())?
        .unwrap_or_default();
    let submission = FootnoteSubmission { notes, links, title, color, marks, workspace_links };
    // Early, context-free checks; the hub checks quotes, slots and ids against the request.
    let cleaned = footnotes::validate_submission(&submission, None)?;
    hub.submit(id, &FootnoteSubmission {
        notes: cleaned.notes,
        links: cleaned.links,
        title: cleaned.title,
        color: cleaned.color,
        marks: cleaned.marks,
        workspace_links: submission.workspace_links,
    })
}

fn tool_text(text: &str, is_error: bool) -> Value {
    let mut result = json!({
        "content": [{ "type": "text", "text": text }],
    });
    if is_error {
        result["isError"] = Value::Bool(true);
    }
    result
}

fn result_reply(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error_reply(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct FakeHub {
        pending: Value,
        full: Mutex<Value>,
        submits: Mutex<Vec<(String, Vec<String>)>>,
        rich: Mutex<Vec<FootnoteSubmission>>,
        fail_submit: Mutex<Option<String>>,
    }

    impl FootnoteHub for FakeHub {
        fn list_pending(&self) -> Result<Value, String> {
            Ok(self.pending.clone())
        }
        fn get(&self, id: &str) -> Result<Value, String> {
            let full = self.full.lock().unwrap();
            if full.get("id").and_then(Value::as_str) == Some(id) {
                Ok(full.clone())
            } else {
                Err("unknown footnote request".into())
            }
        }
        fn submit(&self, id: &str, submission: &FootnoteSubmission) -> Result<Value, String> {
            if let Some(message) = self.fail_submit.lock().unwrap().clone() {
                return Err(message);
            }
            assert!(submission.links.is_empty() || submission.links.iter().all(|link| link.url.starts_with("https://")));
            self.submits.lock().unwrap().push((id.to_string(), submission.notes.clone()));
            self.rich.lock().unwrap().push(submission.clone());
            Ok(json!({ "ok": true }))
        }
    }

    fn fake() -> FakeHub {
        FakeHub {
            pending: json!([{
                "id": "fr-1",
                "doc_name": "Notes.md",
                "page": 2,
                "excerpt": "lemma",
                "context": "a lemma",
                "prompt": null,
                "created_at": 1
            }]),
            full: Mutex::new(json!({
                "id": "fr-1",
                "doc_name": "Notes.md",
                "page": 2,
                "excerpt": "lemma",
                "context": "a lemma",
                "wide_context": "a longer lemma",
                "page_footnotes": [],
                "prompt": null,
                "created_at": 1
            })),
            submits: Mutex::new(Vec::new()),
            rich: Mutex::new(Vec::new()),
            fail_submit: Mutex::new(None),
        }
    }

    fn request(id: i64, method: &str, params: Value) -> Value {
        json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
    }

    #[tokio::test]
    async fn http_adapter_negotiates_and_rejects_foreign_origins_and_protocols() {
        use axum::{body::Body, http::{Request, StatusCode}};
        use tower::ServiceExt;
        let app = http_router(std::sync::Arc::new(fake()), "127.0.0.1:7879".parse().unwrap(), "test-token-with-at-least-32-characters".into());
        let post = || Request::post("/mcp").header("content-type", "application/json")
            .header("authorization", "Bearer test-token-with-at-least-32-characters")
            .body(Body::from(request(1, "initialize", json!({"protocolVersion":"2025-06-18"})).to_string())).unwrap();
        let response = app.clone().oneshot(post()).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), 16_384).await.unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["result"]["protocolVersion"], "2025-06-18");
        for origin in ["https://evil.example", "http://localhost.evil:7879", "null"] {
            let mut request = post(); request.headers_mut().insert("origin", origin.parse().unwrap());
            assert_eq!(app.clone().oneshot(request).await.unwrap().status(), StatusCode::FORBIDDEN);
        }
        let mut request = post(); request.headers_mut().insert("mcp-protocol-version", "unsupported".parse().unwrap());
        assert_eq!(app.clone().oneshot(request).await.unwrap().status(), StatusCode::BAD_REQUEST);
        let notification = Request::post("/mcp").header("content-type", "application/json")
            .header("authorization", "Bearer test-token-with-at-least-32-characters")
            .body(Body::from(json!({"jsonrpc":"2.0","method":"notifications/initialized"}).to_string())).unwrap();
        assert_eq!(app.clone().oneshot(notification).await.unwrap().status(), StatusCode::ACCEPTED);
        assert_eq!(app.oneshot(Request::get("/mcp").header("authorization", "Bearer test-token-with-at-least-32-characters").body(Body::empty()).unwrap()).await.unwrap().status(), StatusCode::METHOD_NOT_ALLOWED);
    }

    #[tokio::test]
    async fn http_adapter_requires_bearer_auth_before_tools_or_notifications() {
        use axum::{body::Body, http::{Request, StatusCode}};
        use tower::ServiceExt;
        let token = "test-token-with-at-least-32-characters";
        let app = http_router(std::sync::Arc::new(fake()), "127.0.0.1:7879".parse().unwrap(), token.into());
        for method in ["initialize", "tools/list", "tools/call", "notifications/initialized"] {
            for supplied in [None, Some("Bearer wrong-token"), Some("Basic test-token-with-at-least-32-characters")] {
                let mut request = Request::post("/mcp").header("content-type", "application/json");
                if let Some(value) = supplied { request = request.header("authorization", value); }
                let response = app.clone().oneshot(request.body(Body::from(request_body(method))).unwrap()).await.unwrap();
                assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
                assert_eq!(response.headers()["www-authenticate"], "Bearer realm=\"Pen Island MCP\"");
            }
        }
        let duplicate = Request::post("/mcp").header("content-type", "application/json")
            .header("authorization", format!("Bearer {token}"))
            .header("authorization", format!("Bearer {token}"))
            .body(Body::from(request_body("tools/list"))).unwrap();
        assert_eq!(app.clone().oneshot(duplicate).await.unwrap().status(), StatusCode::UNAUTHORIZED);
        let valid = Request::post("/mcp").header("content-type", "application/json")
            .header("authorization", format!("bearer {token}"))
            .body(Body::from(request_body("tools/list"))).unwrap();
        assert_eq!(app.oneshot(valid).await.unwrap().status(), StatusCode::OK);
    }

    fn request_body(method: &str) -> String {
        json!({"jsonrpc":"2.0","id":1,"method":method}).to_string()
    }

    #[test]
    fn http_tokens_reject_pairing_codes_empty_or_header_unsafe_values() {
        for invalid in ["", "123456", "short-token", " spaces-are-not-allowed-in-a-token ", "unicode-not-allowed-in-a-token-é"] {
            assert!(!valid_http_token(invalid));
        }
        assert!(!valid_http_token(&"a".repeat(257)));
        assert!(valid_http_token("test-token-with-at-least-32-characters"));
    }

    #[test]
    fn initialize_echoes_a_supported_protocol_and_carries_the_style() {
        let hub = fake();
        let reply = dispatch(&hub, &request(1, "initialize", json!({
            "protocolVersion": "2025-03-26",
        }))).unwrap();
        assert_eq!(reply["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(reply["result"]["capabilities"]["tools"], json!({}));
        assert_eq!(reply["result"]["capabilities"]["prompts"], json!({}));
        assert_eq!(reply["result"]["serverInfo"]["name"], "lc-footnotes");
        let instructions = reply["result"]["instructions"].as_str().unwrap();
        assert!(instructions.starts_with(WORKFLOW));
        assert!(instructions.ends_with(INSTRUCTIONS));
    }

    #[test]
    fn submit_footnote_forwards_title_color_marks_and_workspace_links() {
        let hub = fake();
        let ok = dispatch(&hub, &request(1, "tools/call", json!({
            "name": "submit_footnote",
            "arguments": {
                "id": "fr-1",
                "notes": ["A lemma is a stepping stone."],
                "title": " Lemma ",
                "color": 2,
                "marks": [{ "kind": "highlight", "quote": "lemma", "color": 1 }],
                "workspace_links": ["whiteboard:wb-1"],
            },
        }))).unwrap();
        assert_eq!(ok["result"]["isError"], json!(null));
        let sent = hub.rich.lock().unwrap().last().cloned().unwrap();
        assert_eq!(sent.title.as_deref(), Some("Lemma"));
        assert_eq!(sent.color, Some(2));
        assert_eq!(sent.marks[0].kind, "highlight");
        assert_eq!(sent.workspace_links, ["whiteboard:wb-1"]);

        for (id, arguments) in [
            (2, json!({ "id": "fr-1", "notes": ["n"], "marks": [{ "kind": "strike", "quote": "x" }] })),
            (3, json!({ "id": "fr-1", "notes": ["n"], "color": "blue" })),
            (4, json!({ "id": "fr-1", "notes": ["n"], "color": 9 })),
        ] {
            let bad = dispatch(&hub, &request(id, "tools/call", json!({ "name": "submit_footnote", "arguments": arguments }))).unwrap();
            assert!(bad.get("error").is_none());
            assert_eq!(bad["result"]["isError"], true, "{id}");
        }
        assert_eq!(hub.rich.lock().unwrap().len(), 1);
    }

    #[test]
    fn lists_and_serves_the_ready_made_prompts() {
        let hub = fake();
        let listed = dispatch(&hub, &request(1, "prompts/list", json!({}))).unwrap();
        let names: Vec<&str> = listed["result"]["prompts"].as_array().unwrap().iter()
            .map(|prompt| prompt["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["answer_footnotes", "watch_footnotes"]);
        assert_eq!(listed["result"]["prompts"][0]["title"], "Answer my footnote requests");
        assert_eq!(listed["result"]["prompts"][0]["arguments"], json!([]));

        let prompt = dispatch(&hub, &request(2, "prompts/get", json!({ "name": "watch_footnotes" }))).unwrap();
        let message = &prompt["result"]["messages"][0];
        assert_eq!(message["role"], "user");
        assert_eq!(message["content"]["type"], "text");
        assert!(message["content"]["text"].as_str().unwrap().contains("keep checking every few minutes"));

        let unknown = dispatch(&hub, &request(3, "prompts/get", json!({ "name": "nope" }))).unwrap();
        assert_eq!(unknown["error"]["code"], -32602);
        let missing = dispatch(&hub, &request(4, "prompts/get", json!({}))).unwrap();
        assert_eq!(missing["error"]["code"], -32602);
    }

    #[test]
    fn initialize_falls_back_when_the_protocol_is_unknown() {
        let hub = fake();
        let reply = dispatch(&hub, &request(1, "initialize", json!({
            "protocolVersion": "1999-01-01",
        }))).unwrap();
        assert_eq!(reply["result"]["protocolVersion"], FALLBACK_PROTOCOL);
    }

    #[test]
    fn notifications_and_initialized_get_no_reply() {
        let hub = fake();
        assert!(dispatch(&hub, &json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
        })).is_none());
        assert!(dispatch(&hub, &json!({
            "jsonrpc": "2.0",
            "method": "notifications/cancelled",
        })).is_none());
    }

    #[test]
    fn unknown_method_is_method_not_found() {
        let hub = fake();
        let reply = dispatch(&hub, &request(7, "tools/nope", json!({}))).unwrap();
        assert_eq!(reply["error"]["code"], -32601);
        assert!(reply.get("result").is_none());
    }

    #[test]
    fn ping_and_tools_list_name_the_three_tools() {
        let hub = fake();
        let ping = dispatch(&hub, &request(1, "ping", json!({}))).unwrap();
        assert_eq!(ping["result"], json!({}));
        let listed = dispatch(&hub, &request(2, "tools/list", json!({}))).unwrap();
        let names: Vec<_> = listed["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["list_footnote_requests", "get_footnote_request", "submit_footnote"]);
        let description = listed["result"]["tools"][2]["description"].as_str().unwrap();
        assert!(description.contains(INSTRUCTIONS));
    }

    #[test]
    fn tools_call_returns_json_text_and_tool_failures_are_not_rpc_errors() {
        let hub = fake();
        let listed = dispatch(&hub, &request(1, "tools/call", json!({
            "name": "list_footnote_requests",
        }))).unwrap();
        assert!(listed.get("error").is_none());
        let text = listed["result"]["content"][0]["text"].as_str().unwrap();
        let parsed: Value = serde_json::from_str(text).unwrap();
        assert_eq!(parsed[0]["excerpt"], "lemma");

        let missing = dispatch(&hub, &request(2, "tools/call", json!({
            "name": "get_footnote_request",
            "arguments": { "id": "missing" },
        }))).unwrap();
        assert!(missing.get("error").is_none());
        assert_eq!(missing["result"]["isError"], true);
        assert_eq!(missing["result"]["content"][0]["text"], "unknown footnote request");

        let bad = dispatch(&hub, &request(3, "tools/call", json!({
            "name": "submit_footnote",
            "arguments": { "id": "fr-1", "notes": ["  "] },
        }))).unwrap();
        assert_eq!(bad["result"]["isError"], true);
        assert!(hub.submits.lock().unwrap().is_empty());

        let ok = dispatch(&hub, &request(4, "tools/call", json!({
            "name": "submit_footnote",
            "arguments": {
                "id": "fr-1",
                "notes": ["  A lemma is a stepping stone.  "],
                "links": [{ "title": "Source", "url": "https://example.com/a" }],
            },
        }))).unwrap();
        assert!(ok["result"].get("isError").is_none());
        let stored = hub.submits.lock().unwrap();
        assert_eq!(stored[0].0, "fr-1");
        assert_eq!(stored[0].1, ["A lemma is a stepping stone."]);
    }
}
