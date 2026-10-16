//! Coach-only MCP connections. All effects go through the agent-run registry.

use anyhow::{anyhow, bail, ensure, Result};
use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{error_reply, result_reply, tool_text, FootnoteHub};
use crate::llm::agent_runs::{attachment_tools, AgentRequest, AgentResponder, AgentRunStatus};
use crate::llm::{docs::document_tools, viz_tools, ToolCall};
use crate::serve::{blocking, AppError, Shared};

pub const RUN_ENV: &str = "LC_AGENT_RUN_ID";
pub const BOTS_ENV: &str = "LC_AGENT_BOT_INBOX";
pub const BOTS_JOB: &str = "agent-bots";
pub(super) const ROUTE: &str = "/coach/agent-mcp";

/// The fixed boundary shared by general MCP dispatch and the OAuth bridge.
/// Actual schemas (including optional document tools) still come from the hub.
pub const COACH_TOOLS: &[&str] = &[
    "list_agent_requests",
    "get_agent_request",
    "report_step",
    "reply",
    "draw_structure",
    "animate_trace",
    "annotate_region",
    "cite_test_case",
    "highlight_student_work",
    "create_attachment",
    "query_document_vectors",
    "query_library_vectors",
    "get_document_section",
    "lookup_reference",
    "get_current_page",
    "get_highlight",
    "list_document_marks",
    "save_annotation",
    "search_web",
];

pub(super) fn general_tools(hub: &dyn FootnoteHub) -> Vec<Value> {
    general_request(hub, "tools/list", json!({}))
        .ok()
        .and_then(|result| result["tools"].as_array().cloned())
        .unwrap_or_default()
}

pub(super) fn general_request(
    hub: &dyn FootnoteHub,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    hub.call("POST", ROUTE, Some(json!({
        "scope": AgentScope::BotInbox, "require_bot_provider": true, "method": method, "params": params,
    })))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AgentScope {
    AppRun { run_id: String },
    BotInbox,
}

impl AgentScope {
    pub fn app(run_id: String) -> Result<Self> {
        ensure!(valid_run_id(&run_id), "invalid agent run id");
        Ok(Self::AppRun { run_id })
    }

    pub(super) fn from_job(job_id: Option<&str>) -> Result<Option<Self>> {
        match job_id {
            Some(BOTS_JOB) => Ok(Some(Self::BotInbox)),
            Some(id) if id.starts_with("agent-") => Self::app(id.to_owned()).map(Some),
            _ => Ok(None),
        }
    }

    fn run_id(&self, arguments: &mut Value) -> Result<String> {
        let supplied = arguments
            .as_object_mut()
            .ok_or_else(|| anyhow!("arguments must be an object"))?
            .remove("run_id");
        let supplied = supplied
            .as_ref()
            .map(|value| {
                value
                    .as_str()
                    .ok_or_else(|| anyhow!("run_id must be a string"))
            })
            .transpose()?;
        let id = match self {
            Self::AppRun { run_id } => {
                ensure!(
                    supplied.is_none_or(|id| id == run_id),
                    "this run is not assigned to this process"
                );
                run_id.as_str()
            }
            Self::BotInbox => {
                supplied.ok_or_else(|| anyhow!("run_id is required for bot tools"))?
            }
        };
        ensure!(valid_run_id(id), "invalid agent run id");
        Ok(id.to_owned())
    }

    fn check(&self, request: &AgentRequest) -> Result<()> {
        match self {
            Self::AppRun { run_id } => {
                ensure!(
                    request.id == *run_id,
                    "this run is not assigned to this process"
                );
                ensure!(
                    request.responder == AgentResponder::App,
                    "this run is not assigned to the app"
                );
            }
            Self::BotInbox => ensure!(
                request.responder == AgentResponder::Bot,
                "this run is not assigned to a bot"
            ),
        }
        ensure!(
            matches!(
                request.status,
                AgentRunStatus::Waiting | AgentRunStatus::Working
            ),
            "agent run is {:?}",
            request.status
        );
        Ok(())
    }
}

fn valid_run_id(id: &str) -> bool {
    id.strip_prefix("agent-").is_some_and(|suffix| {
        suffix.len() == 32 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}

/// An explicitly scoped connection exposes no footnote, handoff or hub tools.
pub struct AgentHub<H> {
    hub: H,
    scope: AgentScope,
}

impl<H: FootnoteHub> AgentHub<H> {
    pub fn new(hub: H, scope: AgentScope) -> Result<Self> {
        if let AgentScope::AppRun { run_id } = &scope {
            ensure!(valid_run_id(run_id), "invalid agent run id");
        }
        Ok(Self { hub, scope })
    }
}

impl<H: FootnoteHub> FootnoteHub for AgentHub<H> {
    fn agent_scope(&self) -> Option<AgentScope> {
        Some(self.scope.clone())
    }
    fn list_pending(&self) -> Result<Value, String> {
        Err("coach-only connection".into())
    }
    fn get(&self, _: &str) -> Result<Value, String> {
        Err("coach-only connection".into())
    }
    fn submit(
        &self,
        _: &str,
        _: &crate::pads::footnotes::FootnoteSubmission,
    ) -> Result<Value, String> {
        Err("coach-only connection".into())
    }
    fn call(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
        check_transport_scope(&self.scope, method, path, body.as_ref())?;
        self.hub.call(method, path, body)
    }
}

pub(super) fn check_transport_scope(
    scope: &AgentScope,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Result<(), String> {
    if method != "POST" || path != ROUTE {
        return Err("coach-only connection".into());
    }
    let supplied = body
        .and_then(|body| body.get("scope"))
        .and_then(|value| serde_json::from_value::<AgentScope>(value.clone()).ok());
    if supplied.as_ref() != Some(scope) {
        return Err("the agent scope is fixed for this connection".into());
    }
    Ok(())
}

pub(super) fn scope_from_values(
    run: Option<String>,
    bots: Option<String>,
) -> Result<Option<AgentScope>> {
    let bots = match bots.as_deref() {
        None | Some("0" | "false") => false,
        Some("1" | "true") => true,
        _ => bail!("LC_AGENT_BOT_INBOX must be true/false or 1/0"),
    };
    ensure!(run.is_none() || !bots, "choose one agent MCP scope");
    if let Some(id) = run {
        return AgentScope::app(id).map(Some);
    }
    Ok(bots.then_some(AgentScope::BotInbox))
}

pub(super) fn dispatch(hub: &dyn FootnoteHub, scope: AgentScope, message: &Value) -> Option<Value> {
    let id = message.get("id").filter(|id| !id.is_null())?;
    let method = message["method"].as_str().unwrap_or("");
    let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
    let result = match method {
        "initialize" => {
            let mut result = super::initialize_result(&params);
            result["serverInfo"]["name"] = json!("lc-coach");
            result["instructions"] = json!(match &scope {
                AgentScope::AppRun { run_id } => format!("Answer only agent run {run_id}. Call get_agent_request, use only its allowed tools, optionally report_step with short status text, then reply with the final answer. Keep reasoning private. Review, Lazy and DrawReview replies must use their existing JSON reply format."),
                AgentScope::BotInbox => "Call list_agent_requests for waiting bot runs. Fetch each with get_agent_request; use only its allowed tools, optionally report_step, then reply. Pass run_id on every per-run call. Keep reasoning private. Review, Lazy and DrawReview replies must use their existing JSON reply format.".into(),
            });
            result
        }
        "ping" => json!({}),
        "prompts/list" => json!({"prompts":[]}),
        "tools/list" | "tools/call" => match hub.call(
            "POST",
            ROUTE,
            Some(json!({"scope":scope,"method":method,"params":params})),
        ) {
            Ok(result) => result,
            Err(error) if method == "tools/call" => tool_text(&error, true),
            Err(error) => return Some(error_reply(id, -32603, &error)),
        },
        _ => return Some(error_reply(id, -32601, "Method not found")),
    };
    Some(result_reply(id, result))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AgentMcpRequest {
    scope: AgentScope,
    /// General MCP connections must also have a coach mode assigned to bot.
    #[serde(default)]
    require_bot_provider: bool,
    method: String,
    #[serde(default)]
    params: Value,
}

pub(crate) async fn route(
    State(state): State<Shared>,
    Json(request): Json<AgentMcpRequest>,
) -> Result<Json<Value>, AppError> {
    blocking(move || handle(&state, request)).await.map(Json)
}

/// Also used by the in-process fake transport; this never starts a CLI/listener.
pub(crate) fn handle(state: &Shared, request: AgentMcpRequest) -> Result<Value> {
    let cfg = state.cfg_snapshot();
    let bot_provider = crate::config::COACH_MODES.iter().any(|mode| {
        cfg.llm
            .modes
            .get(mode)
            .is_ok_and(|provider| provider == "bot")
    });
    if !cfg.coach.agent_mcp_tools || (request.require_bot_provider && !bot_provider) {
        return if request.method == "tools/list" {
            Ok(json!({"tools":[]}))
        } else {
            let message = if request.require_bot_provider {
                "coach bot inbox is disabled: enable coach MCP tools and choose AI assistant for a coach mode"
            } else {
                "coach MCP tools are disabled"
            };
            Ok(tool_text(message, true))
        };
    }
    ensure!(
        !request.require_bot_provider || request.scope == AgentScope::BotInbox,
        "general coach MCP connections are bot-only"
    );
    match request.method.as_str() {
        "tools/list" => {
            let schemas = match &request.scope {
                AgentScope::AppRun { run_id } => {
                    ensure!(valid_run_id(run_id), "invalid agent run id");
                    let run = state.agent_runs.get_request(run_id)?;
                    request.scope.check(&run)?;
                    run.tool_schemas
                }
                AgentScope::BotInbox => {
                    let mut tools = viz_tools();
                    tools.extend(document_tools(&cfg));
                    tools.extend(attachment_tools());
                    tools
                }
            };
            Ok(json!({"tools": tool_list(&request.scope, schemas)}))
        }
        "tools/call" => Ok(
            match call(
                state,
                &request.scope,
                &request.params,
                cfg.coach.agent_send_board_image,
            ) {
                Ok(value) => value,
                Err(error) => tool_text(&error.to_string(), true),
            },
        ),
        _ => bail!("unsupported agent MCP method"),
    }
}

fn tool_list(scope: &AgentScope, schemas: Vec<Value>) -> Vec<Value> {
    let mut tools = vec![
        basic_tool("get_agent_request", "Read the question, action, problem/document, board elements, optional board image and sample test cases.", json!({"type":"object","properties":{},"additionalProperties":false})),
        basic_tool("report_step", "Show a short status step. Do not send private reasoning.", json!({"type":"object","properties":{"text":{"type":"string","minLength":1,"maxLength":1000}},"required":["text"],"additionalProperties":false})),
        basic_tool("reply", "Finish this run with the final answer. Ask/Draw take prose; Review/Lazy/DrawReview take their JSON reply format.", json!({"type":"object","properties":{"text":{"type":"string","minLength":1}},"required":["text"],"additionalProperties":false})),
    ];
    tools.extend(schemas.into_iter().map(|schema| {
        basic_tool(
            schema["function"]["name"].as_str().unwrap_or(""),
            schema["function"]["description"].as_str().unwrap_or(""),
            schema["function"]["parameters"].clone(),
        )
    }));
    for tool in &mut tools {
        if *scope == AgentScope::BotInbox {
            let schema = &mut tool["inputSchema"];
            schema["properties"]["run_id"] =
                json!({"type":"string","description":"An id from list_agent_requests."});
            if schema["required"].is_null() {
                schema["required"] = json!([]);
            }
            schema["required"]
                .as_array_mut()
                .unwrap()
                .push(json!("run_id"));
        }
    }
    if *scope == AgentScope::BotInbox {
        tools.insert(
            0,
            basic_tool(
                "list_agent_requests",
                "List waiting bot runs, oldest first. App runs and claimed work are excluded.",
                json!({"type":"object","properties":{},"additionalProperties":false}),
            ),
        );
    }
    tools
}

fn basic_tool(name: &str, description: &str, parameters: Value) -> Value {
    json!({"name":name,"description":description,"inputSchema":parameters,
        "annotations":{"readOnlyHint":matches!(name,"get_agent_request"|"list_agent_requests"),"destructiveHint":false,"openWorldHint":false}})
}

fn call(state: &Shared, scope: &AgentScope, params: &Value, send_image: bool) -> Result<Value> {
    let name = params["name"]
        .as_str()
        .ok_or_else(|| anyhow!("name must be a string"))?;
    let mut arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    ensure!(arguments.is_object(), "arguments must be an object");
    if name == "list_agent_requests" {
        ensure!(
            *scope == AgentScope::BotInbox,
            "only bot connections can list agent requests"
        );
        ensure!(
            arguments.as_object().unwrap().is_empty(),
            "list_agent_requests takes no arguments"
        );
        // No payloads or images in the inbox; fetch a single scoped request.
        return text_json(json!(state.agent_runs.list_waiting_bots().into_iter().map(|run|
            json!({"id":run.id,"request_id":run.request_id,"action":run.action,"created_at":run.created_at,"deadline":run.deadline})
        ).collect::<Vec<_>>()));
    }
    let id = scope.run_id(&mut arguments)?;
    let run = state.agent_runs.get_request(&id)?;
    scope.check(&run)?;
    match name {
        "get_agent_request" => {
            ensure!(
                arguments.as_object().unwrap().is_empty(),
                "get_agent_request takes only run_id"
            );
            let mut value = serde_json::to_value(&run)?;
            // Reuse the API action prompts, including their practice-solution
            // rules and structured reply formats, rather than a new bot policy.
            use crate::llm::coach::*;
            value["answer_guidance"] = json!(match run.action {
                crate::llm::agent_runs::AgentAction::Ask => {
                    let surface = crate::pad::parse_surface(
                        run.payload["surface"].as_str(),
                        run.payload["dataset"].as_str(),
                        run.payload["task_id"].as_str().unwrap_or(""),
                    );
                    match surface {
                        crate::pad::AgentSurface::Annotate => {
                            crate::llm::docs::preset_system(run.payload["preset"].as_str())
                        }
                        crate::pad::AgentSurface::Whiteboard => PAD_ASK_SYSTEM_PROMPT,
                        _ => ASK_SYSTEM_PROMPT,
                    }
                }
                crate::llm::agent_runs::AgentAction::Review => REVIEW_SYSTEM_PROMPT,
                crate::llm::agent_runs::AgentAction::Viz => VIZ_SYSTEM_PROMPT,
                crate::llm::agent_runs::AgentAction::Lazy => LAZY_FILL_SYSTEM_PROMPT,
                crate::llm::agent_runs::AgentAction::DrawReview => DRAW_REVIEW_SYSTEM_PROMPT,
            });
            // Images are MCP image content, never duplicated inside text JSON.
            let image = run
                .context
                .board
                .png
                .as_deref()
                .or_else(|| run.payload["board"]["png"].as_str())
                .or_else(|| run.payload["png"].as_str());
            strip_board_images(&mut value);
            let mut result = text_json(value)?;
            if let Some(image) = image.filter(|image| send_image && !image.is_empty()) {
                let (mime, data) = image
                    .strip_prefix("data:")
                    .and_then(|image| image.split_once(";base64,"))
                    .unwrap_or(("image/png", image));
                ensure!(
                    matches!(mime, "image/png" | "image/jpeg" | "image/webp"),
                    "unsupported board image type"
                );
                result["content"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"type":"image","mimeType":mime,"data":data}));
            }
            Ok(result)
        }
        "report_step" | "reply" => {
            ensure!(
                arguments.as_object().unwrap().len() == 1,
                "expected only text and optional run_id"
            );
            let text = arguments["text"]
                .as_str()
                .ok_or_else(|| anyhow!("text must be a string"))?;
            ensure!(!text.trim().is_empty(), "text is empty");
            if name == "report_step" {
                state.agent_runs.report_step(&id, text)?;
                text_json(json!({"ok":true}))
            } else {
                text_json(state.agent_runs.reply(&id, text)?)
            }
        }
        _ => {
            let schema = run
                .tool_schemas
                .iter()
                .find(|schema| schema["function"]["name"] == name)
                .ok_or_else(|| {
                    anyhow!(
                        "tool {name:?} is not allowed for this {} run",
                        run.action.as_str()
                    )
                })?;
            // Retrieval tools historically default malformed fields. MCP checks
            // those typed arguments before they could trigger disk/network I/O.
            // Draw/attachment validation stays with the executor so its rejected
            // calls emit exactly the same live frames as the API path.
            if !matches!(
                name,
                "draw_structure"
                    | "animate_trace"
                    | "annotate_region"
                    | "cite_test_case"
                    | "highlight_student_work"
                    | "create_attachment"
            ) {
                validate_arguments(&arguments, &schema["function"]["parameters"])?;
            }
            let outcome = state.agent_runs.apply_tool_outcome(
                &id,
                &ToolCall {
                    name: name.into(),
                    arguments,
                },
            )?;
            match outcome.rejection {
                Some(reason) => Ok(tool_text(&reason, true)),
                None => text_json(json!({"ok":true,"feedback":outcome.feedback})),
            }
        }
    }
}

fn strip_board_images(value: &mut Value) {
    // Review flattens BoardSnapshot; Ask/Viz/Lazy nest it; DrawReview has png.
    for pointer in ["/payload", "/payload/board", "/context/board"] {
        if let Some(object) = value.pointer_mut(pointer).and_then(Value::as_object_mut) {
            object.remove("png");
        }
    }
}

fn text_json(value: Value) -> Result<Value> {
    Ok(tool_text(&serde_json::to_string(&value)?, false))
}

fn validate_arguments(value: &Value, schema: &Value) -> Result<()> {
    if let Some(kind) = schema["type"].as_str() {
        ensure!(
            match kind {
                "object" => value.is_object(),
                "array" => value.is_array(),
                "string" => value.is_string(),
                "integer" => value.is_i64() || value.is_u64(),
                _ => true,
            },
            "invalid argument type: expected {kind}"
        );
    }
    if let Some(required) = schema["required"].as_array() {
        for key in required.iter().filter_map(Value::as_str) {
            ensure!(value.get(key).is_some(), "missing argument {key}");
        }
    }
    if let Some(object) = value.as_object() {
        for (key, value) in object {
            if let Some(property) = schema["properties"].get(key) {
                validate_arguments(value, property)?;
            }
        }
    }
    if let Some(items) = value.as_array() {
        for item in items {
            validate_arguments(item, &schema["items"])?;
        }
    }
    if let Some(number) = value.as_f64() {
        ensure!(
            schema["minimum"].as_f64().is_none_or(|min| number >= min),
            "argument is below minimum"
        );
        ensure!(
            schema["maximum"].as_f64().is_none_or(|max| number <= max),
            "argument is above maximum"
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests;
