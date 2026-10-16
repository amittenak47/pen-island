//! The only subprocess is this test binary, running one explicitly ignored
//! helper. File-backed JSON-RPC simulates MCP transport without a network.

use super::*;
use crate::llm::agent_runs::{
    AgentAction, AgentCompletion, AgentResponder, AgentRunHandle, AgentRunInput, AgentRunStatus,
    AgentTaskContext,
};
use crate::llm::coach::EventSink;
use crate::mcp::{coach::AgentScope, FootnoteHub};
use crate::serve::Shared;

const HELPER: &str = "serve::assistant_runner::agent_cli::tests::fake_cli_process";

pub(crate) struct Fixture {
    pub directory: tempfile::TempDir,
    pub settings: AssistantAppConfig,
    pub hook: Arc<AppCliHook>,
}

impl Fixture {
    pub fn new(mode: &str) -> Self {
        let directory = tempfile::Builder::new()
            .prefix("agent-cli-test-")
            .tempdir()
            .unwrap();
        let settings = AssistantAppConfig {
            app: "custom".into(),
            model: json!({"mode":mode,"dir":directory.path()}).to_string(),
            custom_command: json!([
                std::env::current_exe().unwrap(),
                "--ignored",
                "--exact",
                HELPER,
                "--nocapture",
                "--skip",
                "{prompt}",
                "--skip",
                "{mcp_config}",
                "--skip",
                "{model}"
            ])
            .to_string(),
            ..Default::default()
        };
        settings.validate().unwrap();
        Self {
            directory,
            settings,
            hook: Arc::new(AppCliHook {
                slot: Default::default(),
            }),
        }
    }

    pub fn state(&self) -> Shared {
        let mut cfg = Config {
            assistant_app: self.settings.clone(),
            ..Default::default()
        };
        cfg.coach.agent_mcp_tools = true;
        cfg.llm.modes.review = "app".into();
        let state = crate::serve::new_state(cfg);
        state.agent_runs.set_app_hook(self.hook.clone());
        state
    }

    pub fn create(&self, state: &Shared, timeout: Duration) -> AgentRunHandle {
        state.agent_runs.create(
            "cli-test".into(),
            AgentResponder::App,
            AgentRunInput {
                cfg: state.cfg_snapshot(),
                action: AgentAction::Ask,
                payload: json!({"surface":"whiteboard","draw":true,"question":"show a pair"}),
                context: AgentTaskContext {
                    task_id: "whiteboard".into(),
                    ..Default::default()
                },
            },
            EventSink::none(),
            Some(timeout),
        )
    }

    pub async fn ready(&self) -> Value {
        read_json(&self.directory.path().join("ready.json")).await
    }

    pub async fn idle(&self) {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if self.hook.slot.lock().unwrap().is_none() {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("CLI released its slot after cleanup");
    }

    pub async fn pump(&self, state: &Shared) -> Vec<Value> {
        let ready = self.ready().await;
        let scope = AgentScope::app(ready["run"].as_str().unwrap().into()).unwrap();
        let hub = crate::mcp::coach::AgentHub::new(FakeTransport(state.clone()), scope).unwrap();
        let mut replies = Vec::new();
        for index in 0..7 {
            let request =
                read_json(&self.directory.path().join(format!("request-{index}.json"))).await;
            let response = crate::mcp::dispatch(&hub, &request).unwrap();
            if index == 3 {
                assert_eq!(
                    response["result"]["isError"], true,
                    "another run is refused"
                );
            } else {
                assert!(response["error"].is_null(), "{response}");
                assert_ne!(response["result"]["isError"], true, "{response}");
            }
            write_json(
                &self.directory.path().join(format!("response-{index}.json")),
                &response,
            );
            replies.push(response);
        }
        replies
    }
}

struct FakeTransport(Shared);
impl FootnoteHub for FakeTransport {
    fn list_pending(&self) -> Result<Value, String> {
        panic!("no footnote transport")
    }
    fn get(&self, _: &str) -> Result<Value, String> {
        panic!("no footnote transport")
    }
    fn submit(
        &self,
        _: &str,
        _: &crate::pads::footnotes::FootnoteSubmission,
    ) -> Result<Value, String> {
        panic!("no footnote transport")
    }
    fn call(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
        assert_eq!((method, path), ("POST", "/coach/agent-mcp"));
        crate::mcp::coach::handle(&self.0, serde_json::from_value(body.unwrap()).unwrap())
            .map_err(|error| error.to_string())
    }
}

fn write_json(path: &Path, value: &Value) {
    std::fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
}

async fn read_json(path: &Path) -> Value {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let Ok(bytes) = std::fs::read(path) {
                if let Ok(value) = serde_json::from_slice(&bytes) {
                    return value;
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("fake CLI did not write {}", path.display()))
}

async fn completion(handle: &mut AgentRunHandle) -> AgentCompletion {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let Some(value) = handle.completion.borrow_and_update().clone() {
                return value;
            }
            handle.completion.changed().await.unwrap();
        }
    })
    .await
    .expect("agent completion deadline")
}

/// Invoked only by the custom adapter, never as a normal unit test.
#[test]
#[ignore = "subprocess helper; launched only by fake-CLI tests"]
fn fake_cli_process() {
    let args: Vec<_> = std::env::args().collect();
    let values: Vec<_> = args
        .windows(2)
        .filter(|pair| pair[0] == "--skip")
        .map(|pair| pair[1].clone())
        .collect();
    let config: Value = serde_json::from_str(&values[2]).unwrap();
    let dir = Path::new(config["dir"].as_str().unwrap());
    let mode = config["mode"].as_str().unwrap();
    if mode == "descendant" {
        write_json(&dir.join("descendant.json"), &json!(std::process::id()));
        std::thread::sleep(Duration::from_secs(20));
        return;
    }
    let child_pid = if mode == "tree" {
        let mut descendant = args[1..].to_vec();
        *descendant.last_mut().unwrap() = json!({"mode":"descendant","dir":dir}).to_string();
        let mut command = std::process::Command::new(&args[0]);
        command
            .args(descendant)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        Some(command.spawn().unwrap().id())
    } else {
        None
    };
    let mcp: Value = serde_json::from_slice(&std::fs::read(&values[1]).unwrap()).unwrap();
    write_json(
        &dir.join("ready.json"),
        &json!({
            "pid":std::process::id(), "child_pid":child_pid,
            "run":std::env::var(RUN_ENV).unwrap(), "bots":std::env::var(BOTS_ENV).unwrap(),
            "mcp":mcp, "prompt":values[0], "cwd":std::env::current_dir().unwrap(),
            "api_keys_removed":(["OPENAI_API_KEY","CODEX_API_KEY","ANTHROPIC_API_KEY"]
                .iter().all(|key| std::env::var_os(key).is_none())),
            "marker":std::env::var("PEN_ISLAND_ASSISTANT_CHILD").unwrap()
        }),
    );
    // Any CLI reasoning on stdout must stay out of panel events/results.
    println!("PRIVATE CLI REASONING: never show this in the panel");
    if mode == "exit" {
        eprintln!("error: process stopped\nBearer unknown-secret-value\npassword=do-not-expose");
        return;
    }
    if mode == "success" {
        let rpc = |method: &str, params: Value| json!({"jsonrpc":"2.0","id":1,"method":method,"params":params});
        let tool = |name: &str, arguments: Value| {
            rpc("tools/call", json!({"name":name,"arguments":arguments}))
        };
        let messages = [
            rpc("initialize", json!({"protocolVersion":"2025-06-18"})),
            rpc("tools/list", json!({})),
            tool("get_agent_request", json!({})),
            tool(
                "get_agent_request",
                json!({"run_id":"agent-00000000000000000000000000000000"}),
            ),
            tool("report_step", json!({"text":"Reading your board"})),
            tool(
                "draw_structure",
                json!({"viz":"array","id":"pair","title":"Pair","frames":[{"cells":[2,7]}]}),
            ),
            tool("reply", json!({"text":"A pair."})),
        ];
        for (index, message) in messages.iter().enumerate() {
            write_json(&dir.join(format!("request-{index}.json")), message);
            let until = std::time::Instant::now() + Duration::from_secs(15);
            while !dir.join(format!("response-{index}.json")).is_file() {
                assert!(
                    std::time::Instant::now() < until,
                    "fake MCP response deadline"
                );
                std::thread::sleep(Duration::from_millis(5));
            }
        }
    }
    // A CLI that hangs after reply must also be killed and release the slot.
    std::thread::sleep(Duration::from_secs(20));
}

#[tokio::test]
async fn fake_cli_success_uses_scoped_mcp_and_hides_stdout() {
    let fixture = Fixture::new("success");
    let state = fixture.state();
    let mut run = fixture.create(&state, Duration::from_secs(15));
    state.agent_runs.start_app(&run.id).unwrap();
    let replies = fixture.pump(&state).await;
    let AgentCompletion::Done(body) = completion(&mut run).await else {
        panic!("reply completed run")
    };
    assert_eq!(body["reply"], "A pair.");
    assert_eq!(body["programs"].as_array().unwrap().len(), 1);
    assert!(body["reasoning"].is_null() || body["reasoning"] == "");
    assert_eq!(
        replies[1]["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "get_agent_request",
            "report_step",
            "reply",
            "draw_structure",
            "animate_trace",
            "annotate_region",
            "create_attachment"
        ]
    );
    let ready = fixture.ready().await;
    assert_eq!(ready["run"], run.id);
    assert_eq!(ready["bots"], "0");
    assert_eq!(ready["marker"], "1");
    assert_eq!(ready["api_keys_removed"], true);
    assert!(ready["prompt"].as_str().unwrap().contains("show a pair"));
    assert_eq!(ready["mcp"]["mcpServers"].as_object().unwrap().len(), 1);
    assert_eq!(
        ready["mcp"]["mcpServers"]["pen_island"]["env"][RUN_ENV],
        run.id
    );
    assert_eq!(ready["mcp"]["mcpServers"]["pen_island"]["args"][4], run.id);
    fixture.idle().await;
    assert_gone(ready["pid"].as_u64().unwrap() as u32);
    assert!(
        !Path::new(ready["cwd"].as_str().unwrap()).exists(),
        "workspace removed after cleanup"
    );
}

#[tokio::test]
async fn fake_cli_exit_without_reply_fails_with_secret_free_stderr() {
    let fixture = Fixture::new("exit");
    let state = fixture.state();
    let mut run = fixture.create(&state, Duration::from_secs(15));
    state.agent_runs.start_app(&run.id).unwrap();
    let AgentCompletion::Failed(message) = completion(&mut run).await else {
        panic!("missing reply fails")
    };
    assert!(
        message.contains("exited without calling reply"),
        "{message}"
    );
    assert!(
        message.contains("error: process stopped | [redacted] | [redacted]"),
        "{message}"
    );
    for secret in [
        "unknown-secret-value",
        "do-not-expose",
        "PRIVATE CLI REASONING",
    ] {
        assert!(!message.contains(secret));
    }
    fixture.idle().await;
    assert_gone(fixture.ready().await["pid"].as_u64().unwrap() as u32);
}

#[tokio::test]
async fn fake_cli_deadline_kills_process_and_releases_slot() {
    let fixture = Fixture::new("sleep");
    let state = fixture.state();
    let mut run = fixture.create(&state, Duration::from_secs(2));
    state.agent_runs.start_app(&run.id).unwrap();
    let ready = fixture.ready().await;
    let AgentCompletion::Failed(message) = completion(&mut run).await else {
        panic!("timeout fails")
    };
    assert!(message.contains("deadline expired"), "{message}");
    fixture.idle().await;
    assert_gone(ready["pid"].as_u64().unwrap() as u32);
    assert_eq!(
        state.agent_runs.get_request(&run.id).unwrap().status,
        AgentRunStatus::Failed
    );
}

#[tokio::test]
async fn fake_cli_cancel_kills_root_and_descendant() {
    let fixture = Fixture::new("tree");
    let state = fixture.state();
    let mut run = fixture.create(&state, Duration::from_secs(15));
    state.agent_runs.start_app(&run.id).unwrap();
    let ready = fixture.ready().await;
    read_json(&fixture.directory.path().join("descendant.json")).await;
    state.agent_runs.cancel(&run.id).unwrap();
    assert!(matches!(
        completion(&mut run).await,
        AgentCompletion::Cancelled
    ));
    fixture.idle().await;
    assert_gone(ready["pid"].as_u64().unwrap() as u32);
    assert_gone(ready["child_pid"].as_u64().unwrap() as u32);
}

#[tokio::test]
async fn second_app_is_refused_across_registries_and_slot_is_reusable() {
    let fixture = Fixture::new("sleep");
    let a = fixture.state();
    let b = fixture.state();
    let first = fixture.create(&a, Duration::from_secs(15));
    let second = fixture.create(&b, Duration::from_secs(15));
    a.agent_runs.start_app(&first.id).unwrap();
    let ready = fixture.ready().await;
    let error = b.agent_runs.start_app(&second.id).unwrap_err();
    assert!(error
        .to_string()
        .contains("Another AI application run is active"));
    b.agent_runs.fail(&second.id, error.to_string()).unwrap();
    // Refusing/cancelling a different request must not stop the first process.
    assert_eq!(
        a.agent_runs.get_request(&first.id).unwrap().status,
        AgentRunStatus::Waiting
    );
    a.agent_runs.cancel(&first.id).unwrap();
    fixture.idle().await;
    assert_gone(ready["pid"].as_u64().unwrap() as u32);
    let third = fixture.create(&b, Duration::from_secs(15));
    b.agent_runs.start_app(&third.id).unwrap();
    b.agent_runs.cancel(&third.id).unwrap();
    fixture.idle().await;
}

pub(crate) fn assert_gone(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let result = std::process::Command::new("tasklist.exe")
            .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        let output = String::from_utf8_lossy(&result.stdout);
        assert!(
            !output.contains(&format!("\"{pid}\"")),
            "PID {pid} still alive: {output}"
        );
    }
    #[cfg(not(windows))]
    {
        let status = std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(!status.success(), "PID {pid} still alive");
    }
}

#[test]
fn exact_app_commands_and_environment_preserve_builtin_lockdown() {
    let fixture = Fixture::new("sleep");
    let state = fixture.state();
    let handle = fixture.create(&state, Duration::from_secs(15));
    let request = state.agent_runs.get_request(&handle.id).unwrap();
    let mcp = agent_mcp(
        "desktop.exe".into(),
        "http://127.0.0.1:7878".into(),
        &request,
    );
    let prompt = agent_prompt(&request);
    for app in ["codex", "claude"] {
        let settings = AssistantAppConfig {
            app: app.into(),
            ..Default::default()
        };
        let spec = command_spec(
            &settings,
            format!("{app}.exe").into(),
            &mcp,
            Path::new("empty"),
            prompt.clone(),
            Some(Path::new("catalog.json")),
            Some(Path::new("mcp.json")),
        )
        .unwrap();
        // The footnote vector has its own literal golden regression, written
        // before extraction. Only these exact scoped inputs may differ.
        let mut expected = super::super::command_spec(
            &settings,
            format!("{app}.exe").into(),
            Path::new("desktop.exe"),
            Path::new("empty"),
            "http://127.0.0.1:7878",
            Some(&request.id),
            false,
            Some(Path::new("catalog.json")),
            Some(Path::new("mcp.json")),
        )
        .unwrap()
        .args;
        if app == "codex" {
            let allowlist = expected
                .iter_mut()
                .find(|arg| arg.starts_with("mcp_servers.pen_island.enabled_tools="))
                .unwrap();
            *allowlist = format!(
                "mcp_servers.pen_island.enabled_tools={}",
                json!(mcp.allowed_tools)
            );
            expected.pop();
            expected.extend([
                "-c".into(),
                "mcp_servers.pen_island.env.LC_AGENT_BOT_INBOX=\"0\"".into(),
                "-c".into(),
                format!(
                    "mcp_servers.pen_island.env.LC_AGENT_RUN_ID=\"{}\"",
                    request.id
                ),
                prompt.clone(),
            ]);
        } else {
            expected[1] = prompt.clone();
        }
        assert_eq!(spec.args, expected);
        assert_eq!(spec.executable, PathBuf::from(format!("{app}.exe")));
        let temp = tempfile::tempdir().unwrap();
        let prepared = PreparedCli {
            _temp: temp,
            cwd: "empty".into(),
            spec,
        };
        let command = prepared.app_command(&request);
        let env: BTreeMap<_, _> = command
            .as_std()
            .get_envs()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().into_owned(),
                    v.map(|v| v.to_string_lossy().into_owned()),
                )
            })
            .collect();
        assert_eq!(
            env,
            BTreeMap::from([
                ("OPENAI_API_KEY".into(), None),
                ("CODEX_API_KEY".into(), None),
                ("ANTHROPIC_API_KEY".into(), None),
                ("PEN_ISLAND_ASSISTANT_CHILD".into(), Some("1".into())),
                (RUN_ENV.into(), Some(request.id.clone())),
                (BOTS_ENV.into(), Some("0".into())),
            ])
        );
        assert_eq!(command.as_std().get_current_dir(), Some(Path::new("empty")));
    }
    assert_eq!(
        mcp.config(),
        json!({"mcpServers":{"pen_island":{
            "command":"desktop.exe", "args":["--pen-island-assistant-mcp","--hub","http://127.0.0.1:7878","--job",request.id],
            "env":{"LC_AGENT_RUN_ID":request.id,"LC_AGENT_BOT_INBOX":"0"}
        }}})
    );
}

#[test]
fn custom_template_substitutes_once_without_shell_or_argument_injection() {
    let settings = AssistantAppConfig {
        app: "custom".into(),
        model: "model {prompt}".into(),
        custom_command: json!(["fake-cli", "--prompt={prompt}", "{mcp_config}", "{model}"])
            .to_string(),
        ..Default::default()
    };
    let prompt = "question \"quoted\"; $(never-run) {model} {mcp_config}\nnext line";
    let spec = command_spec(
        &settings,
        PathBuf::new(),
        &McpSpec {
            executable: "lc.exe".into(),
            args: vec![],
            allowed_tools: vec![],
            env: Default::default(),
        },
        Path::new("empty"),
        prompt.into(),
        None,
        Some(Path::new("has spaces/mcp.json")),
    )
    .unwrap();
    assert_eq!(spec.executable, Path::new("fake-cli"));
    assert_eq!(
        spec.args,
        [
            format!("--prompt={prompt}"),
            "has spaces/mcp.json".into(),
            "model {prompt}".into()
        ]
    );
    for template in [
        "[]",
        "not JSON",
        "[\"{prompt}\",\"{mcp_config}\"]",
        "[\"cli\",\"{prompt}\"]",
    ] {
        assert!(AssistantAppConfig {
            custom_command: template.into(),
            ..settings.clone()
        }
        .validate()
        .is_err());
    }
}

#[test]
fn stderr_tail_never_discloses_unknown_text_or_unbounded_output() {
    let mut bytes = vec![b'x'; 10_000];
    bytes.extend_from_slice(b"\nerror: connection refused\nsecret with no recognizable marker\n\x1b[31mprivate thinking");
    assert_eq!(
        safe_stderr_tail(&bytes),
        "error: connection refused | [redacted] | [redacted]"
    );
    assert_eq!(safe_stderr_tail(&[]), "(empty)");
}

#[test]
fn default_hooks_share_the_app_slot_and_custom_settings_round_trip() {
    let a = AppCliHook::default();
    let b = AppCliHook::default();
    assert!(Arc::ptr_eq(&a.slot, &b.slot));
    let fixture = Fixture::new("exit");
    assert!(!Arc::ptr_eq(&a.slot, &fixture.hook.slot));
    let original = serde_json::to_value(&fixture.settings).unwrap();
    assert_eq!(
        serde_json::from_value::<AssistantAppConfig>(original).unwrap(),
        fixture.settings
    );
    let old: AssistantAppConfig = serde_json::from_value(json!({"app":"codex"})).unwrap();
    assert!(old.custom_command.is_empty());
    old.validate().unwrap();
}
