//! Subscription-backed assistants run in an empty directory with a bounded MCP inbox.

use std::collections::VecDeque;
use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use serde_json::Value;
#[cfg(test)]
use serde_json::json;
#[cfg(test)]
use tokio::process::Command;

use crate::config::{AssistantAppConfig, Config};
use crate::pads::{self, annotation_jobs, footnotes};

#[path = "agent_cli.rs"]
pub mod agent_cli;
use agent_cli::kill_tree;
#[cfg(test)]
use agent_cli::{hide, restricted_catalog, CommandSpec};

pub const MCP_TOOLS: &[&str] = &[
    "list_footnote_requests", "get_footnote_request", "submit_footnote",
    "list_annotation_jobs", "get_annotation_pages", "get_annotation_reference",
    "submit_page_annotations", "finish_annotation_job",
];
const MCP_FLAG: &str = "--pen-island-assistant-mcp";
const DRY_PROMPT: &str = "Check the Pen Island connection. Call list_footnote_requests and list_annotation_jobs once each. Do not fetch, answer, submit, finish, or change any request or job. Report whether the two tools worked. Don't do anything else.";

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AssistantRunnerStatus {
    pub state: String,
    pub app: String,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub job_id: Option<String>,
    pub requests_answered: Option<usize>,
    pub error: Option<String>,
}

impl Default for AssistantRunnerStatus {
    fn default() -> Self {
        Self { state: "idle".into(), app: "codex".into(), started_at: None, finished_at: None,
            job_id: None, requests_answered: None, error: None }
    }
}

#[derive(Default)]
struct Runner {
    status: AssistantRunnerStatus,
    queue: VecDeque<Option<String>>,
    running: bool,
    stopped: bool,
    pid: Option<u32>,
}

impl Runner {
    fn enqueue(&mut self, job: Option<String>) -> bool {
        if self.stopped { return false; }
        if !self.queue.contains(&job) && !(job.is_some() && self.running && self.status.job_id == job) {
            self.queue.push_back(job);
        }
        if self.running { return false; }
        self.running = true;
        true
    }
}

static RUNNER: OnceLock<Mutex<Runner>> = OnceLock::new();
fn runner() -> &'static Mutex<Runner> { RUNNER.get_or_init(Default::default) }
fn now() -> i64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64 }

pub fn status() -> AssistantRunnerStatus {
    runner().lock().unwrap_or_else(|error| error.into_inner()).status.clone()
}

pub fn schedule(job_id: Option<&str>) {
    if cfg!(target_os = "android") || job_id.is_some_and(|id| !footnotes::valid_id(id)) { return; }
    let start = runner().lock().unwrap_or_else(|error| error.into_inner()).enqueue(job_id.map(str::to_owned));
    if start { tokio::spawn(work_queue()); }
}

/// Queued work stays in SQLite when the PC closes and is resumed on its next start.
pub fn resume() {
    if cfg!(target_os = "android") { return; }
    tokio::spawn(async {
        if let Ok((requests, jobs)) = pending().await {
            if !requests.is_empty() { schedule(None); }
            for id in jobs { schedule(Some(&id)); }
        }
    });
}

/// The desktop calls this before exiting; no child or queued follow-up survives it.
pub fn shutdown() {
    let pid = {
        let mut inner = runner().lock().unwrap_or_else(|error| error.into_inner());
        inner.stopped = true;
        inner.queue.clear();
        inner.pid.take()
    };
    if let Some(pid) = pid { kill_tree(pid); }
}

async fn pending() -> Result<(Vec<String>, Vec<String>)> {
    tokio::task::spawn_blocking(|| {
        let conn = pads::open(&pads::db_path()?)?;
        let requests = footnotes::list_pending_app(&conn).map_err(|_| anyhow!("Could not read pending requests."))?
            .into_iter().map(|request| request.id).collect();
        let jobs = annotation_jobs::list_open_app(&conn).map_err(|_| anyhow!("Could not read pending page runs."))?
            .into_iter().map(|job| job.id).collect();
        Ok((requests, jobs))
    }).await?
}

async fn work_queue() {
    loop {
        let work = {
            let mut inner = runner().lock().unwrap_or_else(|error| error.into_inner());
            if inner.stopped || inner.queue.is_empty() { inner.running = false; return; }
            inner.queue.pop_front().unwrap()
        };
        let Ok((requests, jobs)) = pending().await else {
            record_failure("Could not read pending ChatBot work."); continue;
        };
        if work.as_ref().is_some_and(|id| !jobs.contains(id)) || (work.is_none() && requests.is_empty()) { continue; }
        let cfg = match Config::load() { Ok(cfg) => cfg, Err(_) => { record_failure("Could not read the assistant app settings."); continue; } };
        begin_status(&cfg.assistant_app, work.clone());
        let outcome = run(&cfg.assistant_app, &cfg, work.as_deref(), false).await;
        let validation = match outcome {
            Ok(()) => validate_completion(&requests, work.as_deref()).await,
            Err(error) => Err(error),
        };
        finish_status(validation);
    }
}

fn begin_status(settings: &AssistantAppConfig, job_id: Option<String>) {
    let mut inner = runner().lock().unwrap_or_else(|error| error.into_inner());
    inner.status = AssistantRunnerStatus { state: "running".into(), app: settings.app.clone(),
        started_at: Some(now()), finished_at: None, job_id, requests_answered: None, error: None };
}

fn record_failure(message: &str) { finish_status(Err(anyhow!(message.to_owned()))); }
fn finish_status(result: Result<usize>) {
    let mut inner = runner().lock().unwrap_or_else(|error| error.into_inner());
    inner.pid = None;
    inner.status.finished_at = Some(now());
    match result {
        Ok(count) => { inner.status.state = "done".into(); inner.status.requests_answered = Some(count); inner.status.error = None; }
        Err(error) => { inner.status.state = "failed".into(); inner.status.error = Some(error.to_string()); }
    }
}

async fn validate_completion(requests: &[String], job_id: Option<&str>) -> Result<usize> {
    let requests = requests.to_vec();
    let job_id = job_id.map(str::to_owned);
    tokio::task::spawn_blocking(move || {
        let conn = pads::open(&pads::db_path()?)?;
        let mut answered = 0;
        for id in requests {
            let request = footnotes::get_request(&conn, &id).map_err(|_| anyhow!("Could not check the assistant's answers."))?;
            match request.as_ref().map(|row| row.status.as_str()) {
                Some("done" | "acked") => answered += 1,
                Some("pending") => return Err(anyhow!("The assistant stopped before answering all requests. Open Settings, ChatBot, Test.")),
                _ => {},
            }
        }
        if let Some(id) = job_id {
            let state: String = conn.query_row("SELECT status FROM annotation_jobs WHERE id=?1", [&id], |row| row.get(0))?;
            if state != "done" && state != "cancelled" {
                return Err(anyhow!("The assistant stopped before finishing this page run. Open Settings, ChatBot, Test."));
            }
        }
        Ok(answered)
    }).await?
}

pub async fn test(settings: AssistantAppConfig) -> AssistantRunnerStatus {
    if cfg!(target_os = "android") {
        return AssistantRunnerStatus { state: "failed".into(), error: Some("Test the assistant app through your PC connection.".into()), ..Default::default() };
    }
    {
        let mut inner = runner().lock().unwrap_or_else(|error| error.into_inner());
        if inner.running || inner.stopped { return inner.status.clone(); }
        inner.running = true;
    }
    begin_status(&settings, None);
    let result = match Config::load() {
        Ok(cfg) => run(&settings, &cfg, None, true).await.map(|_| 0),
        Err(_) => Err(anyhow!("Could not read the assistant app settings.")),
    };
    finish_status(result);
    let result = status();
    let restart = {
        let mut inner = runner().lock().unwrap_or_else(|error| error.into_inner());
        inner.running = false;
        if !inner.stopped && !inner.queue.is_empty() { inner.running = true; true } else { false }
    };
    if restart { tokio::spawn(work_queue()); }
    result
}

fn fixed_prompt(job_id: Option<&str>, dry: bool) -> Result<String> {
    if dry { return Ok(DRY_PROMPT.into()); }
    anyhow::ensure!(job_id.is_none_or(footnotes::valid_id), "Invalid annotation job id.");
    let mut prompt = "Answer the pending Pen Island ChatBot work. Call list_footnote_requests and answer each request (get_footnote_request, then submit_footnote).".to_owned();
    if let Some(id) = job_id {
        prompt.push_str(&format!(" Then call list_annotation_jobs and, for the job `{id}` only, read its pages and references and submit footnotes page by page, then finish_annotation_job."));
    }
    prompt.push_str(" Follow the tool descriptions. Don't do anything else.");
    Ok(prompt)
}

fn footnote_mcp(mcp: &Path, hub: &str, job_id: Option<&str>, dry: bool) -> agent_cli::McpSpec {
    let mut args = vec![MCP_FLAG.to_owned(), "--hub".into(), hub.into()];
    if let Some(id) = job_id { args.extend(["--job".into(), id.into()]); }
    if dry { args.push("--read-only".into()); }
    let allowed = if dry { vec!["list_footnote_requests", "list_annotation_jobs"] } else { MCP_TOOLS.to_vec() };
    agent_cli::McpSpec { executable: mcp.into(), args,
        allowed_tools: allowed.into_iter().map(str::to_owned).collect(), env: Default::default() }
}

#[cfg(test)]
fn command_spec(settings: &AssistantAppConfig, executable: PathBuf, mcp: &Path, cwd: &Path,
    hub: &str, job_id: Option<&str>, dry: bool, catalog: Option<&Path>, claude_mcp: Option<&Path>) -> Result<CommandSpec> {
    agent_cli::command_spec(settings, executable, &footnote_mcp(mcp, hub, job_id, dry), cwd,
        fixed_prompt(job_id, dry)?, catalog, claude_mcp)
}

async fn run(settings: &AssistantAppConfig, cfg: &Config, job_id: Option<&str>, dry: bool) -> Result<()> {
    let mcp = std::env::current_exe().map_err(|_| anyhow!("Could not find Pen Island's assistant tools."))?;
    let hub = format!("http://127.0.0.1:{}", cfg.serve.port);
    let prepared = agent_cli::prepare(settings, footnote_mcp(&mcp, &hub, job_id, dry), fixed_prompt(job_id, dry)?).await?;
    let logfile = std::env::temp_dir().join("pen-island-assistant-last.log");
    let log = std::fs::File::create(&logfile)?;
    let mut command = prepared.command();
    command.stdout(log.try_clone()?).stderr(log);
    let mut child = {
        let mut inner = runner().lock().unwrap_or_else(|error| error.into_inner());
        anyhow::ensure!(!inner.stopped, "The assistant app is stopping.");
        let child = command.spawn().map_err(|_| anyhow!("The assistant app could not start. Open Settings, ChatBot, Test."))?;
        inner.pid = child.id();
        child
    };
    let limit = if job_id.is_some() { Duration::from_secs(15 * 60) } else { Duration::from_secs(3 * 60) };
    let result = wait_child(&mut child, limit).await;
    runner().lock().unwrap_or_else(|error| error.into_inner()).pid = None;
    result?;
    let output = std::fs::read_to_string(logfile).unwrap_or_default();
    if settings.app == "codex" {
        let events: Vec<Value> = output.lines().filter_map(|line| serde_json::from_str(line).ok()).collect();
        anyhow::ensure!(!events.iter().any(|event| event["type"] == "turn.failed" || event["type"] == "error" || event["item"]["type"] == "error"),
            "Codex could not finish. Open Settings, ChatBot, Test.");
        if dry {
            for name in ["list_footnote_requests", "list_annotation_jobs"] {
                anyhow::ensure!(events.iter().any(|event| event["type"] == "item.completed" && event["item"]["type"] == "mcp_tool_call"
                    && event["item"]["tool"] == name && event["item"]["status"] == "completed" && event["item"]["result"]["isError"] != true),
                    "Codex could not reach Pen Island's tools. Open Settings, ChatBot, Test.");
            }
        }
    } else if settings.app == "claude" {
        let response: Value = serde_json::from_str(output.trim()).map_err(|_| anyhow!("Claude Code could not finish. Open Settings, ChatBot, Test."))?;
        anyhow::ensure!(response["is_error"] != true, "Claude Code could not finish. Open Settings, ChatBot, Test.");
    }
    Ok(())
}

async fn wait_child(child: &mut tokio::process::Child, limit: Duration) -> Result<()> {
    let pid = child.id();
    match tokio::time::timeout(limit, child.wait()).await {
        Ok(Ok(status)) if status.success() => Ok(()),
        Ok(_) => { if let Some(pid) = pid { kill_tree(pid); } Err(anyhow!("The assistant app could not finish. Open Settings, ChatBot, Test.")) },
        Err(_) => {
            if let Some(pid) = pid { kill_tree(pid); }
            let _ = child.kill().await;
            let _ = child.wait().await;
            Err(anyhow!("The assistant app timed out. Open Settings, ChatBot, Test."))
        }
    }
}

/// The shipped desktop binary also provides stdio MCP, before creating a window.
pub fn serve_mcp_if_requested() -> bool {
    if cfg!(target_os = "android") { return false; }
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) != Some(MCP_FLAG) { return false; }
    let result = (|| -> Result<()> {
        let value = |flag: &str| args.iter().position(|arg| arg == flag).and_then(|index| args.get(index + 1)).cloned();
        let hub = value("--hub").context("Missing local hub.")?;
        let url = reqwest::Url::parse(&hub)?;
        anyhow::ensure!(url.scheme() == "http" && url.host_str().is_some_and(|host| host == "127.0.0.1" || host == "localhost" || host == "[::1]"), "The assistant tools require a local hub.");
        let cfg = Config::load()?;
        let client = crate::mcp::HttpFootnoteHub::new(hub, cfg.serve.token)?;
        let restricted = crate::mcp::AppFootnoteHub::new(client, value("--job"), args.iter().any(|arg| arg == "--read-only"))?;
        crate::mcp::serve(&restricted)
    })();
    if result.is_err() { eprintln!("Pen Island's assistant tools could not start."); std::process::exit(2); }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_prompts_only_interpolate_checked_job_ids() {
        assert!(fixed_prompt(Some("../other"), false).is_err());
        let prompt = fixed_prompt(Some("aj-one"), false).unwrap();
        assert!(prompt.contains("job `aj-one` only"));
        assert!(!fixed_prompt(None, false).unwrap().contains("list_annotation_jobs"));
        assert_eq!(fixed_prompt(Some("untrusted text"), true).unwrap(), DRY_PROMPT);
    }

    // Written against the original runner before extracting the adapters.
    #[test]
    fn exact_footnote_command_lines_regression() {
        let settings = AssistantAppConfig::default();
        let spec = command_spec(&settings, "codex.exe".into(), Path::new("desktop.exe"),
            Path::new("empty"), "http://127.0.0.1:7878", Some("aj-one"), false,
            Some(Path::new("catalog.json")), None).unwrap();
        assert_eq!(spec.args.join("\n"), r#"exec
--ignore-user-config
--ignore-rules
--ephemeral
--skip-git-repo-check
--strict-config
--sandbox
read-only
--json
--color
never
-C
empty
-m
gpt-6.1-sol
-c
approval_policy="never"
-c
forced_login_method="chatgpt"
-c
model_reasoning_effort="high"
-c
web_search="disabled"
-c
history.persistence="none"
-c
project_doc_max_bytes=0
-c
mcp_servers.pen_island.command="desktop.exe"
-c
mcp_servers.pen_island.args=["--pen-island-assistant-mcp","--hub","http://127.0.0.1:7878","--job","aj-one"]
-c
mcp_servers.pen_island.required=true
-c
mcp_servers.pen_island.default_tools_approval_mode="approve"
-c
mcp_servers.pen_island.enabled_tools=["list_footnote_requests","get_footnote_request","submit_footnote","list_annotation_jobs","get_annotation_pages","get_annotation_reference","submit_page_annotations","finish_annotation_job"]
-c
model_catalog_json="catalog.json"
--disable
shell_tool
--disable
apps
--disable
plugins
--disable
hooks
--disable
multi_agent
--disable
browser_use
--disable
browser_use_external
--disable
computer_use
--disable
image_generation
--disable
code_mode
--disable
tool_suggest
--disable
skill_search
--disable
skill_mcp_dependency_install
--disable
goals
--disable
sleep_tool
--disable
workspace_dependencies
--disable
view_image
Answer the pending Pen Island ChatBot work. Call list_footnote_requests and answer each request (get_footnote_request, then submit_footnote). Then call list_annotation_jobs and, for the job `aj-one` only, read its pages and references and submit footnotes page by page, then finish_annotation_job. Follow the tool descriptions. Don't do anything else."#);
        let settings = AssistantAppConfig { app: "claude".into(), model: "sonnet".into(), ..settings };
        let spec = command_spec(&settings, "claude.exe".into(), Path::new("desktop.exe"),
            Path::new("empty"), "http://127.0.0.1:7878", None, true, None,
            Some(Path::new("mcp.json"))).unwrap();
        assert_eq!(spec.args, vec!["-p", DRY_PROMPT, "--restricted", "--strict-mcp-config",
            "--mcp-config", "mcp.json", "--tools", "", "--allowedTools", "mcp__pen_island__*",
            "--permission-mode", "dontAsk", "--permission-prompts", "none",
            "--no-session-persistence", "--disable-slash-commands", "--no-chrome",
            "--output-format", "json", "--model", "sonnet"]);
    }

    #[test]
    fn command_arguments_bound_codex_tools_without_bypassing_sandbox() {
        let spec = command_spec(&AssistantAppConfig::default(), "codex.exe".into(), Path::new("desktop.exe"),
            Path::new("empty"), "http://127.0.0.1:7878", Some("aj-one"), false, Some(Path::new("catalog.json")), None).unwrap();
        let args = spec.args.join("\n");
        for required in ["--ignore-user-config", "--ephemeral", "--sandbox\nread-only", "forced_login_method=\"chatgpt\"",
            "web_search=\"disabled\"", "model_catalog_json=\"catalog.json\"", "--disable\nshell_tool", "--pen-island-assistant-mcp", "--job", "aj-one"] {
            assert!(args.contains(required), "{required}");
        }
        assert!(!args.contains("dangerously"));
        assert!(!args.contains("--disable\ncode_mode_host"));
        assert_eq!(spec.executable, Path::new("codex.exe"));
    }

    #[test]
    fn dry_tests_only_expose_listing_tools_and_do_not_change_settings() {
        let settings = AssistantAppConfig::default();
        let spec = command_spec(&settings, "codex.exe".into(), Path::new("desktop.exe"), Path::new("empty"),
            "http://127.0.0.1:7878", None, true, Some(Path::new("catalog.json")), None).unwrap();
        let allowlist = spec.args.iter().find(|arg| arg.starts_with("mcp_servers.pen_island.enabled_tools=")).unwrap();
        assert!(!allowlist.contains("submit"));
        assert!(spec.args.iter().any(|arg| arg.contains("--read-only")));
        assert_eq!(settings, AssistantAppConfig::default());
    }

    #[test]
    fn installed_metadata_loses_file_writes_and_extra_model_tools() {
        let source = br#"{"models":[{"slug":"fixture","apply_patch_tool_type":"freeform","experimental_supported_tools":["clock"]}]}"#;
        let filtered = restricted_catalog(source, "fixture").unwrap();
        assert_eq!(filtered["models"][0]["apply_patch_tool_type"], Value::Null);
        assert_eq!(filtered["models"][0]["experimental_supported_tools"], json!([]));
        assert!(restricted_catalog(source, "unknown").is_err());
        assert!(restricted_catalog(br#"{"models":[{"slug":"fixture"}]}"#, "fixture").is_err());
    }

    #[test]
    fn one_worker_keeps_one_followup_and_never_restarts_after_shutdown() {
        let mut inner = Runner::default();
        assert!(inner.enqueue(None));
        assert!(!inner.enqueue(None));
        assert!(!inner.enqueue(None));
        assert_eq!(inner.queue.len(), 1);
        assert!(!inner.enqueue(Some("aj-one".into())));
        assert!(!inner.enqueue(Some("aj-one".into())));
        assert_eq!(inner.queue.len(), 2);
        inner.stopped = true;
        assert!(!inner.enqueue(Some("aj-two".into())));
        assert_eq!(inner.queue.len(), 2);
    }

    #[tokio::test]
    async fn timeout_terminates_a_sleeping_child() {
        let mut command = if cfg!(windows) {
            let mut command = Command::new("powershell.exe");
            command.args(["-NoProfile", "-Command", "Start-Sleep -Seconds 10"]); command
        } else {
            let mut command = Command::new("sh"); command.args(["-c", "sleep 10"]); command
        };
        hide(&mut command);
        let mut child = command.kill_on_drop(true).spawn().unwrap();
        let error = wait_child(&mut child, Duration::from_millis(50)).await.unwrap_err();
        assert!(error.to_string().contains("timed out"));
        assert!(child.try_wait().unwrap().is_some());
    }
}
