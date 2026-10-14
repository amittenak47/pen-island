import { afterEach, beforeEach, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ hub: null as null | { url: string; token: string }, invoke: vi.fn(), fetch: vi.fn() }));
vi.mock("./nativeHttp", async original => ({ ...await original<typeof import("./nativeHttp")>(), loadInvoke: async () => transport.invoke }));
vi.mock("../util/padHub", async original => ({ ...await original<typeof import("../util/padHub")>(), loadPadHub: () => transport.hub }));
vi.mock("../util/padHubStatus", async original => ({
  ...await original<typeof import("../util/padHubStatus")>(), isPadHubOffline: () => false,
  beginPadHubStatusRequest: vi.fn(), reportPadHubStatus: vi.fn(),
}));
import { DEFAULT_ASSISTANT_RUNNER_CONFIG, LcClient } from "./client";
const config = { ...DEFAULT_ASSISTANT_RUNNER_CONFIG, model: "desktop-model" };
const status = { app: "codex", state: "done", started_at: 1, finished_at: 2 };
beforeEach(() => { transport.invoke.mockReset(); transport.fetch.mockReset(); transport.hub = null; vi.stubGlobal("fetch", transport.fetch); });
afterEach(() => vi.unstubAllGlobals());
it("uses registered local commands for desktop runner settings, status and dry checks", async () => {
  transport.invoke.mockResolvedValue({ status: 200, body: config });
  const client = new LcClient();
  expect(await client.assistantRunnerConfig()).toEqual(config);
  expect(await client.putAssistantRunnerConfig(config)).toEqual(config);
  transport.invoke.mockResolvedValue({ status: 200, body: status });
  expect(await client.assistantRunnerStatus()).toEqual(status);
  expect(await client.testAssistantRunner(config)).toEqual(status);
  expect(transport.invoke.mock.calls).toEqual([
    ["lc_assistant_runner_config", {}], ["lc_put_assistant_runner_config", { body: config }],
    ["lc_assistant_runner_status", {}], ["lc_test_assistant_runner", { body: config }],
  ]);
  expect(transport.fetch).not.toHaveBeenCalled();
});
it("sends tablet runner settings and dry checks to the paired PC", async () => {
  transport.hub = { url: "http://hub.test", token: "123456" };
  transport.fetch.mockImplementation(async () => new Response(JSON.stringify(config), { status: 200, headers: { "content-type": "application/json" } }));
  const client = new LcClient();
  await client.assistantRunnerConfig(); await client.putAssistantRunnerConfig(config); await client.assistantRunnerStatus(); await client.testAssistantRunner(config);
  expect(transport.fetch.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
    ["http://hub.test/assistant-runner/config", "GET"], ["http://hub.test/assistant-runner/config", "PUT"],
    ["http://hub.test/assistant-runner", "GET"], ["http://hub.test/assistant-runner/test", "POST"],
  ]);
  for (const [, init] of transport.fetch.mock.calls) expect(init.headers).toMatchObject({ "x-lc-token": "123456" });
  expect(JSON.parse(transport.fetch.mock.calls[1]![1].body)).toEqual(config);
  expect(JSON.parse(transport.fetch.mock.calls[3]![1].body)).toEqual(config);
  expect(transport.invoke).not.toHaveBeenCalled();
});
