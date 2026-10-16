//! In-memory coach jobs shared by sockets, scoped MCP clients and the bot inbox.
//!
//! Each job has its own lock: a document lookup on one board does not serialize
//! another socket. Terminal transitions and their event ordering use that lock.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, bail, ensure, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::watch;

use crate::config::Config;
use crate::llm::coach::{
    parse_draw_review, parse_lazy_fill, parse_review, BoardSnapshot, EventSink, ToolStatus,
};
use crate::llm::coach_tools::{execute_tool, ToolContext, ToolEnvelope};
use crate::llm::docs::{document_tools, AskContext};
use crate::llm::{ask_draw_tools, viz_tools, ToolCall};
use crate::pad::{parse_surface, AgentSurface};
use crate::problem::IoCase;

// The footnote runner has inline per-job limits, but no shared timeout constant.
pub const APP_RUN_TIMEOUT: Duration = Duration::from_secs(5 * 60);
pub const BOT_RUN_TIMEOUT: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentAction {
    Ask,
    Review,
    Viz,
    Lazy,
    DrawReview,
}

impl AgentAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ask => "ask",
            Self::Review => "review",
            Self::Viz => "viz",
            Self::Lazy => "lazy",
            Self::DrawReview => "draw_review",
        }
    }

    /// Match the providers used by the HTTP handlers, including Lazy's claim.
    pub fn provider_mode(self) -> &'static str {
        match self {
            Self::Ask | Self::Review | Self::Lazy => "review",
            Self::Viz | Self::DrawReview => "viz",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentResponder {
    App,
    Bot,
}

impl AgentResponder {
    pub fn from_provider(provider: &str) -> Option<Self> {
        match provider {
            "app" => Some(Self::App),
            "bot" => Some(Self::Bot),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::App => "app",
            Self::Bot => "bot",
        }
    }

    fn timeout(self) -> Duration {
        match self {
            Self::App => APP_RUN_TIMEOUT,
            Self::Bot => BOT_RUN_TIMEOUT,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRunStatus {
    Waiting,
    Working,
    Done,
    Failed,
    Cancelled,
}

impl AgentRunStatus {
    fn active(self) -> bool {
        matches!(self, Self::Waiting | Self::Working)
    }
}

/// Only the redacted problem data and resolved board the API path can use.
#[derive(Debug, Clone, Default, Serialize)]
pub struct AgentTaskContext {
    pub task_id: String,
    pub description: Option<String>,
    pub cases: Vec<IoCase>,
    pub board: BoardSnapshot,
}

/// Prepared by the socket's request validation, without calling a provider.
pub struct AgentRunInput {
    pub action: AgentAction,
    pub payload: Value,
    pub context: AgentTaskContext,
    pub cfg: Config,
}

impl AgentRunInput {
    fn document(&self) -> Option<AskContext> {
        let text = |key| self.payload[key].as_str().unwrap_or("").to_string();
        let hash = text("document_hash").trim().to_string();
        let surface = parse_surface(
            self.payload["surface"].as_str(),
            self.payload["dataset"].as_str(),
            self.payload["task_id"].as_str().unwrap_or(""),
        );
        (self.action == AgentAction::Ask
            && matches!(surface, AgentSurface::Annotate)
            && !hash.is_empty())
        .then(|| AskContext {
            document_hash: Some(hash),
            page: self.payload["page"].as_u64().map(|page| page as u32),
            highlight: text("highlight"),
            page_text: text("page_text"),
            marks_prose: text("marks_prose"),
            retrieved: String::new(),
        })
    }

    fn allowed_tools(&self) -> Vec<String> {
        let schemas = match self.action {
            AgentAction::Ask => {
                let surface = parse_surface(
                    self.payload["surface"].as_str(),
                    self.payload["dataset"].as_str(),
                    self.payload["task_id"].as_str().unwrap_or(""),
                );
                let mut tools = if self.document().is_some() {
                    document_tools(&self.cfg)
                } else {
                    Vec::new()
                };
                if surface.is_pad() && self.payload["draw"] == true {
                    tools.extend(ask_draw_tools());
                }
                tools
            }
            AgentAction::Viz => viz_tools(),
            // The post-render API only consumes draw/animate calls for its one fix.
            AgentAction::DrawReview => viz_tools()
                .into_iter()
                .filter(|tool| {
                    matches!(
                        tool["function"]["name"].as_str(),
                        Some("draw_structure" | "animate_trace")
                    )
                })
                .collect(),
            AgentAction::Review | AgentAction::Lazy => Vec::new(),
        };
        let mut names: Vec<_> = schemas
            .into_iter()
            .filter_map(|tool| tool["function"]["name"].as_str().map(str::to_owned))
            .collect();
        // Every Ask path appends the private document runner attachment schema.
        if self.action == AgentAction::Ask {
            names.push("create_attachment".into());
        }
        names
    }
}

/// What `get_agent_request` returns. Times are Unix milliseconds. The raw
/// payload preserves elements, rendered images and document text without loss.
#[derive(Debug, Clone, Serialize)]
pub struct AgentRequest {
    pub id: String,
    pub request_id: String,
    pub action: AgentAction,
    pub responder: AgentResponder,
    pub payload: Value,
    pub context: AgentTaskContext,
    pub allowed_tools: Vec<String>,
    pub envelope: ToolEnvelope,
    pub status: AgentRunStatus,
    pub created_at: u64,
    pub updated_at: u64,
    pub started_at: Option<u64>,
    pub finished_at: Option<u64>,
    pub deadline: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub enum AgentCompletion {
    Done(Value),
    Failed(String),
    Cancelled,
}

pub struct AgentRunHandle {
    pub id: String,
    pub completion: watch::Receiver<Option<AgentCompletion>>,
}

/// Step 4 installs this hook to launch a scoped CLI and stop its process tree.
/// No hook is installed by default: app runs wait without starting anything.
pub trait AppAgentHook: Send + Sync {
    fn start(&self, run_id: &str, runs: Arc<AgentRunRegistry>) -> Result<()>;
    fn cancel(&self, run_id: &str);
}

struct AgentRun {
    request: AgentRequest,
    cfg: Config,
    document: Option<AskContext>,
    events: EventSink,
    completion: watch::Sender<Option<AgentCompletion>>,
}

type Clock = dyn Fn() -> u64 + Send + Sync;

pub struct AgentRunRegistry {
    runs: Mutex<HashMap<String, Arc<Mutex<AgentRun>>>>,
    clock: Arc<Clock>,
    app_hook: RwLock<Option<Arc<dyn AppAgentHook>>>,
}

impl Default for AgentRunRegistry {
    fn default() -> Self {
        Self::with_clock(|| {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64
        })
    }
}

impl AgentRunRegistry {
    /// Injectable clock for deterministic deadline tests; no sleeping required.
    pub fn with_clock(clock: impl Fn() -> u64 + Send + Sync + 'static) -> Self {
        Self {
            runs: Mutex::new(HashMap::new()),
            clock: Arc::new(clock),
            app_hook: RwLock::new(None),
        }
    }

    pub fn now(&self) -> u64 {
        (self.clock)()
    }

    pub fn set_app_hook(&self, hook: Arc<dyn AppAgentHook>) {
        *self.app_hook.write().unwrap_or_else(|e| e.into_inner()) = Some(hook);
    }

    pub fn create(
        &self,
        request_id: String,
        responder: AgentResponder,
        input: AgentRunInput,
        events: EventSink,
        timeout: Option<Duration>,
    ) -> AgentRunHandle {
        let now = (self.clock)();
        let id = format!("agent-{:032x}", rand::random::<u128>());
        let (completion, receiver) = watch::channel(None);
        let allowed_tools = input.allowed_tools();
        let document = input.document();
        let request = AgentRequest {
            id: id.clone(),
            request_id,
            action: input.action,
            responder,
            payload: input.payload,
            context: input.context,
            allowed_tools,
            envelope: ToolEnvelope::default(),
            status: AgentRunStatus::Waiting,
            created_at: now,
            updated_at: now,
            started_at: None,
            finished_at: None,
            deadline: now.saturating_add(timeout.unwrap_or(responder.timeout()).as_millis() as u64),
            error: None,
        };
        self.runs.lock().unwrap_or_else(|e| e.into_inner()).insert(
            id.clone(),
            Arc::new(Mutex::new(AgentRun {
                request,
                cfg: input.cfg,
                document,
                events,
                completion,
            })),
        );
        AgentRunHandle {
            id,
            completion: receiver,
        }
    }

    pub fn start_app(self: &Arc<Self>, id: &str) -> Result<()> {
        let request = self.get_request(id)?;
        ensure!(
            request.responder == AgentResponder::App,
            "only app runs use the application hook"
        );
        ensure!(request.status.active(), "agent run is {:?}", request.status);
        let hook = self
            .app_hook
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if let Some(hook) = hook {
            hook.start(id, self.clone())?;
        }
        Ok(())
    }

    fn find(&self, id: &str) -> Result<Arc<Mutex<AgentRun>>> {
        self.runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow!("unknown agent run {id:?}"))
    }

    pub fn get_request(&self, id: &str) -> Result<AgentRequest> {
        self.expire(id)?;
        let run = self.find(id)?;
        let request = run
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .request
            .clone();
        Ok(request)
    }

    /// Bot inbox: app runs, claimed work and terminal runs are never returned.
    pub fn list_waiting_bots(&self) -> Vec<AgentRequest> {
        let ids: Vec<_> = self
            .runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .keys()
            .cloned()
            .collect();
        let mut waiting: Vec<_> = ids
            .into_iter()
            .filter_map(|id| self.get_request(&id).ok())
            .filter(|run| {
                run.responder == AgentResponder::Bot && run.status == AgentRunStatus::Waiting
            })
            .collect();
        waiting.sort_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)));
        waiting
    }

    fn active(&self, id: &str) -> Result<Arc<Mutex<AgentRun>>> {
        self.expire(id)?;
        self.find(id)
    }

    pub fn apply_tool(&self, id: &str, call: &ToolCall) -> Result<Option<String>> {
        let run = self.active(id)?;
        let mut run = run.lock().unwrap_or_else(|e| e.into_inner());
        run.ensure_active((self.clock)())?;
        run.working((self.clock)());
        if !run
            .request
            .allowed_tools
            .iter()
            .any(|tool| tool == &call.name)
        {
            let reason = format!(
                "tool {:?} is not allowed for this {} run",
                call.name,
                run.request.action.as_str()
            );
            run.events
                .tool(&call.name, ToolStatus::Proposed, &call.name, None);
            run.events.tool(
                &call.name,
                ToolStatus::Rejected,
                &call.name,
                Some(reason.clone()),
            );
            bail!("{reason}");
        }
        let mut call = call.clone();
        if run.request.action == AgentAction::DrawReview {
            ensure!(
                run.request.envelope.programs.is_empty(),
                "draw review allows one replacement"
            );
            if let Some(arguments) = call.arguments.as_object_mut() {
                arguments.insert("id".into(), run.request.payload["program"]["id"].clone());
            }
        }
        // The socket can cancel while an I/O tool is blocked. Drop its late
        // accepted/rejected events, just as the task boundary drops late results.
        let parent = run.events.clone();
        let filtered_events = EventSink::new(move |event| {
            if !parent.is_cancelled() {
                parent.emit(event);
            }
        });
        let AgentRun {
            request,
            cfg,
            document,
            ..
        } = &mut *run;
        if request.action == AgentAction::Ask {
            let empty = AskContext {
                document_hash: None,
                page: None,
                highlight: String::new(),
                page_text: String::new(),
                marks_prose: String::new(),
                retrieved: String::new(),
            };
            execute_tool(
                &call,
                &ToolContext::Ask {
                    cfg,
                    document: document.as_ref().unwrap_or(&empty),
                    max_attachments: 8,
                },
                &mut request.envelope,
                &filtered_events,
            )
        } else {
            execute_tool(
                &call,
                &ToolContext::ProblemViz {
                    cases: &request.context.cases,
                    board: &request.context.board,
                },
                &mut request.envelope,
                &filtered_events,
            )
        }
    }

    /// Agent reasoning stays private. The existing stage frame accepts custom
    /// names: `agent_step` uses the panel's detail fallback and remains visible
    /// as a step after tool calls (unlike the `ask` waiting header).
    pub fn report_step(&self, id: &str, detail: &str) -> Result<()> {
        ensure!(
            !detail.trim().is_empty() && detail.len() <= 1000,
            "step must be 1–1000 bytes"
        );
        let run = self.active(id)?;
        let mut run = run.lock().unwrap_or_else(|e| e.into_inner());
        run.ensure_active((self.clock)())?;
        run.working((self.clock)());
        run.events.stage("agent_step", detail.trim());
        Ok(())
    }

    /// Ask/Draw take prose; Review/Lazy/DrawReview take their existing JSON reply
    /// schemas. Parse errors leave the job open so the agent can correct them.
    pub fn reply(&self, id: &str, reply: &str) -> Result<Value> {
        let run = self.active(id)?;
        let mut run = run.lock().unwrap_or_else(|e| e.into_inner());
        let now = (self.clock)();
        run.ensure_active(now)?;
        let body = run.result_body(reply)?;
        run.working(now);
        run.events.stage("done", "");
        run.finish(
            AgentRunStatus::Done,
            AgentCompletion::Done(body.clone()),
            now,
        );
        Ok(body)
    }

    pub fn cancel(&self, id: &str) -> Result<()> {
        self.terminate(id, AgentRunStatus::Cancelled, AgentCompletion::Cancelled)
    }

    pub fn fail(&self, id: &str, message: String) -> Result<()> {
        self.terminate(id, AgentRunStatus::Failed, AgentCompletion::Failed(message))
    }

    fn terminate(
        &self,
        id: &str,
        status: AgentRunStatus,
        completion: AgentCompletion,
    ) -> Result<()> {
        let run = self.find(id)?;
        let app = {
            let mut run = run.lock().unwrap_or_else(|e| e.into_inner());
            if !run.request.status.active() {
                return Ok(());
            }
            run.finish(status, completion, (self.clock)());
            run.request.responder == AgentResponder::App
        };
        if app {
            let hook = self
                .app_hook
                .read()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            if let Some(hook) = hook {
                hook.cancel(id);
            }
        }
        Ok(())
    }

    /// Called by the socket timer and every read/mutation, so a late bot cannot
    /// win a race with the timer. Returns whether the deadline has elapsed.
    pub fn expire(&self, id: &str) -> Result<bool> {
        let run = self.find(id)?;
        let expired = {
            let run = run.lock().unwrap_or_else(|e| e.into_inner());
            run.request.status.active() && (self.clock)() >= run.request.deadline
        };
        if expired {
            let message =
                "agent run deadline expired — no reply arrived in time; please ask again".into();
            self.fail(id, message)?;
        }
        Ok(expired)
    }
}

impl AgentRun {
    fn ensure_active(&self, now: u64) -> Result<()> {
        ensure!(
            self.request.status.active(),
            "agent run is {:?}",
            self.request.status
        );
        ensure!(now < self.request.deadline, "agent run deadline expired");
        ensure!(!self.events.is_cancelled(), "agent run is cancelled");
        Ok(())
    }

    fn working(&mut self, now: u64) {
        self.request.status = AgentRunStatus::Working;
        self.request.started_at.get_or_insert(now);
        self.request.updated_at = now;
    }

    fn finish(&mut self, status: AgentRunStatus, completion: AgentCompletion, now: u64) {
        self.request.status = status;
        self.request.updated_at = now;
        self.request.finished_at = Some(now);
        if let AgentCompletion::Failed(message) = &completion {
            self.request.error = Some(message.clone());
        }
        // A finished entry must not retain the socket sender and keep its
        // writer alive after disconnect. Socket cancellation owns the flag;
        // registry cancellation instead wakes the task to send its error frame.
        self.events = EventSink::none();
        self.completion.send_replace(Some(completion));
    }

    fn result_body(&self, reply: &str) -> Result<Value> {
        let request = &self.request;
        let envelope = &request.envelope;
        let mut body =
            json!({"task_id": request.context.task_id, "provider": request.responder.as_str()});
        match request.action {
            AgentAction::Ask => {
                ensure!(!reply.trim().is_empty(), "reply is empty");
                body["reply"] = json!(reply.trim());
                for (key, value) in [
                    ("programs", serde_json::to_value(&envelope.programs)?),
                    ("artifacts", serde_json::to_value(&envelope.artifacts)?),
                    (
                        "proposed_annotations",
                        serde_json::to_value(&envelope.proposed)?,
                    ),
                ] {
                    if value.as_array().is_some_and(|items| !items.is_empty()) {
                        body[key] = value;
                    }
                }
            }
            AgentAction::Viz => {
                body["programs"] = serde_json::to_value(&envelope.programs)?;
                body["annotations"] = serde_json::to_value(&envelope.annotations)?;
                body["citations"] = serde_json::to_value(&envelope.citations)?;
                body["highlights"] = serde_json::to_value(&envelope.highlights)?;
                body["rejected"] = json!(envelope.rejected);
                body["message"] = json!(reply.trim());
            }
            AgentAction::Review => {
                let review = parse_review(reply, &request.context.cases)?;
                body.as_object_mut()
                    .unwrap()
                    .extend(serde_json::to_value(review)?.as_object().unwrap().clone());
            }
            AgentAction::Lazy => {
                let fill = parse_lazy_fill(reply)?;
                body.as_object_mut()
                    .unwrap()
                    .extend(serde_json::to_value(fill)?.as_object().unwrap().clone());
            }
            AgentAction::DrawReview => {
                let review = parse_draw_review(reply)?;
                if !review.ok {
                    if let Some(program) = envelope.programs.first() {
                        body["program"] = serde_json::to_value(program)?;
                    }
                }
                body.as_object_mut()
                    .unwrap()
                    .extend(serde_json::to_value(review)?.as_object().unwrap().clone());
            }
        }
        Ok(body)
    }
}

#[cfg(test)]
#[path = "agent_runs_tests.rs"]
mod tests;
