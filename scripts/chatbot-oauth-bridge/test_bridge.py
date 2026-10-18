"""In-process bridge contract tests. No credentials, listeners or external I/O."""
import asyncio
from contextlib import asynccontextmanager
import json
import logging
from pathlib import Path
import re
import unittest

import httpx2
from fastmcp import Client
from fastmcp.client.transports import StreamableHttpTransport
from fastmcp.server.auth import AccessToken, TokenVerifier

logging.disable(logging.CRITICAL)

from bridge import (BACKEND_URL, COACH_ACTION_TOOLS, COACH_INBOX_TOOLS,
                    COACH_TOOLS, COACH_WORKFLOW, HANDOFF_TOOLS, INSTRUCTIONS,
                    TOOLS, WORKFLOW, BridgeConfig, build_bridge, relay)


class OwnerAuth(TokenVerifier):
    async def verify_token(self, token):
        if token != "test-owner":
            return None
        return AccessToken(token=token, client_id="test", scopes=[],
                           claims={"sub": "123", "github_user_data": {"id": 123}})


class FakeBackend:
    def __init__(self):
        self.open = False
        self.handoff = False
        self.fail = False
        self.calls = []
        self.schema = {"type": "object", "properties": {
            "run_id": {"type": "string"}, "frames": {"type": "array"}},
            "required": ["run_id", "frames"], "additionalProperties": False}

    def tools(self):
        names = {"list_footnote_requests", "delete_everything"}
        if self.open:
            names |= COACH_TOOLS - {"search_web"}
        if self.handoff:
            names |= HANDOFF_TOOLS
        return [{"name": name, "description": f"Backend {name}",
                 "inputSchema": self.schema if name == "draw_structure" else
                 {"type": "object", "properties": {}}} for name in sorted(names)]

    async def handle(self, request):
        # This transport cannot contact any address or carry a real credential.
        assert str(request.url) == BACKEND_URL
        assert request.headers["Authorization"] == "Bearer test-backend"
        if request.method == "GET":
            return httpx2.Response(405)
        if request.method == "DELETE":
            return httpx2.Response(200)
        message = json.loads(request.content)
        if "id" not in message:
            return httpx2.Response(202)
        method, params = message["method"], message.get("params", {})
        if method == "initialize":
            result = {"protocolVersion": params["protocolVersion"],
                      "capabilities": {"tools": {}, "prompts": {}},
                      "serverInfo": {"name": "fake", "version": "1"}}
        elif method == "tools/list":
            if self.fail:
                return httpx2.Response(200, json={"jsonrpc": "2.0", "id": message["id"],
                    "error": {"code": -32603, "message": "Unavailable"}})
            result = {"tools": self.tools()}
        elif method == "tools/call":
            self.calls.append((params["name"], params.get("arguments", {})))
            result = {"content": [{"type": "text", "text": json.dumps({"name": params["name"], "arguments": params.get("arguments", {})})}]}
        elif method == "prompts/get":
            if params["name"] == "answer_coach_requests" and not self.open:
                return httpx2.Response(200, json={"jsonrpc": "2.0", "id": message["id"],
                    "error": {"code": -32602, "message": "Unknown prompt"}})
            text = "Original prompt" + ("\n\n" + COACH_WORKFLOW if self.open else "")
            result = {"messages": [{"role": "user", "content": {"type": "text", "text": text}}]}
        elif method == "ping":
            result = {}
        else:
            raise AssertionError(f"Unexpected backend method {method}")
        return httpx2.Response(200, json={"jsonrpc": "2.0", "id": message["id"], "result": result})


class BridgeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        asyncio.get_running_loop().set_debug(False)
        self.backend = FakeBackend()
        # Paths are inert placeholders; build_bridge must never read them.
        placeholder = Path("unused-test-path")
        config = BridgeConfig("https://bridge.test", 123, "test-client", "test-secret",
                              placeholder, placeholder, placeholder, "test-backend", b"unused")
        self.bridge = build_bridge(config, auth_provider=OwnerAuth(),
                                   backend_transport=httpx2.MockTransport(self.backend.handle))
        self.app = self.bridge.http_app(path="/mcp", stateless_http=True, json_response=True)

    @asynccontextmanager
    async def client(self):
        transport = StreamableHttpTransport("https://bridge.test/mcp",
            httpx_client_factory=lambda **_kw: httpx2.AsyncClient(
                transport=httpx2.ASGITransport(app=self.app),
                headers={"Authorization": "Bearer test-owner"}, follow_redirects=True))
        async with self.app.router.lifespan_context(self.app):
            async with Client(transport, cache=False, mode="legacy") as client:
                yield client

    async def test_live_gate_and_action_schemas_follow_backend(self):
        async with self.client() as client:
            for opened in [False, True, False]:
                self.backend.open = opened
                self.backend.handoff = opened
                tools = {tool.name: tool for tool in await client.list_tools()}
                self.assertEqual(COACH_INBOX_TOOLS & tools.keys(), COACH_INBOX_TOOLS if opened else set())
                self.assertEqual(HANDOFF_TOOLS & tools.keys(), HANDOFF_TOOLS if opened else set())
                self.assertNotIn("search_web", tools)  # optional backend schema absent
                self.assertNotIn("delete_everything", tools)
                if opened:
                    self.assertEqual(tools["draw_structure"].input_schema, self.backend.schema)
                    self.assertIn("description", tools["get_agent_request"].input_schema["properties"]["run_id"])
                    self.assertIn("description", tools["reply"].input_schema["properties"]["text"])
                else:
                    self.assertFalse(COACH_ACTION_TOOLS & tools.keys())

    async def test_inbox_and_generic_action_calls_preserve_arguments(self):
        self.backend.open = True
        async with self.client() as client:
            for name, arguments in [
                ("list_agent_requests", {}),
                ("get_agent_request", {"run_id": "agent-test"}),
                ("draw_structure", {"run_id": "agent-test", "frames": [{"cells": [2, 7]}]}),
                ("report_step", {"run_id": "agent-test", "text": "Reading your board"}),
                ("reply", {"run_id": "agent-test", "text": "A pair."}),
            ]:
                result = await client.call_tool(name, arguments)
                self.assertEqual(json.loads(result.content[0].text), {"name": name, "arguments": arguments})
                self.assertEqual(self.backend.calls[-1], (name, arguments))

    async def test_relay_refuses_outside_allow_list_and_closed_gate(self):
        with self.assertRaisesRegex(ValueError, "Unknown bridge tool"):
            await relay(None, "delete_everything", {})
        self.backend.open = True
        async with self.client() as client:
            result = await client.call_tool("delete_everything", {}, raise_on_error=False)
            self.assertTrue(result.is_error)
            self.backend.open = False
            for name in ["get_agent_request", "draw_structure"]:
                result = await client.call_tool(name, {"run_id": "agent-test"}, raise_on_error=False)
                self.assertTrue(result.is_error)
            self.assertEqual(self.backend.calls, [])

    async def test_prompts_and_initialize_wording_follow_gate(self):
        for opened in [False, True, False]:
            self.backend.open = opened
            async with self.client() as client:
                self.assertEqual(client.initialize_result.instructions,
                    INSTRUCTIONS + ("\n\n" + COACH_WORKFLOW if opened else ""))
                names = {prompt.name for prompt in await client.list_prompts()}
                self.assertEqual("answer_coach_requests" in names, opened)
                for name in ["answer_footnotes", "watch_footnotes"]:
                    result = await client.get_prompt(name)
                    self.assertEqual(COACH_WORKFLOW in result.messages[0].content.text, opened)
                if opened:
                    result = await client.get_prompt("answer_coach_requests")
                    self.assertIn(COACH_WORKFLOW, result.messages[0].content.text)
                else:
                    with self.assertRaises(Exception):
                        await client.get_prompt("answer_coach_requests")

    async def test_discovery_instructions_follow_gate(self):
        # The newer SDK discovery hook uses the same instruction gate.
        from types import SimpleNamespace
        gate = next(middleware for middleware in self.bridge.middleware
                    if type(middleware).__name__ == "InboxGate")

        async def response(_context):
            return SimpleNamespace(instructions=INSTRUCTIONS)

        for opened in [False, True, False]:
            self.backend.open = opened
            result = await gate.on_discover(None, response)
            self.assertEqual(result.instructions,
                INSTRUCTIONS + ("\n\n" + COACH_WORKFLOW if opened else ""))

    async def test_backend_failure_closes_both_gates(self):
        self.backend.open = self.backend.handoff = True
        self.backend.fail = True
        async with self.client() as client:
            names = {tool.name for tool in await client.list_tools()}
            self.assertFalse(names & (COACH_TOOLS | HANDOFF_TOOLS))
            result = await client.call_tool("reply", {"run_id": "agent-test", "text": "Done"}, raise_on_error=False)
            self.assertTrue(result.is_error)
            self.assertEqual(self.backend.calls, [])

    def test_allow_list_and_workflow_copies_match_rust(self):
        source = (Path(__file__).resolve().parents[2] / "src" / "mcp.rs").read_text(encoding="utf-8")
        for name, text in [("WORKFLOW", WORKFLOW), ("COACH_WORKFLOW", COACH_WORKFLOW)]:
            match = re.search(rf'pub const {name}: &str = (".*?");', source)
            self.assertEqual(json.loads(match[1]), text)
        coach = (Path(__file__).resolve().parents[2] / "src" / "mcp" / "coach.rs").read_text(encoding="utf-8")
        names = re.search(r'pub const COACH_TOOLS: &\[&str\] = &\[(.*?)\];', coach, re.S)[1]
        self.assertEqual(set(re.findall(r'"([a-z_]+)"', names)), COACH_TOOLS)
        self.assertFalse(TOOLS - COACH_TOOLS - HANDOFF_TOOLS - {
            "list_footnote_requests", "get_footnote_request", "submit_footnote",
            "list_annotation_jobs", "get_annotation_pages", "get_annotation_reference",
            "submit_page_annotations", "finish_annotation_job"})


if __name__ == "__main__":
    unittest.main()
