"""Optional GitHub OAuth front end for Pen Island's bearer-protected MCP.

Only the three footnote tools are exposed. The public tunnel must target
127.0.0.1:7880; the normal, authenticated lc adapter remains on 127.0.0.1:7879.
Credentials are read from an ignored local JSON file, never command arguments.
"""
from __future__ import annotations

import argparse
import base64
from dataclasses import dataclass, field
import hashlib
import hmac
import json
import logging
from pathlib import Path
import re
import sys
from typing import Annotated, Any, Literal
from urllib.parse import urlsplit

import httpx2
from cryptography.fernet import Fernet
from fastmcp import FastMCP
from fastmcp.client.transports import StreamableHttpTransport
from fastmcp.server.auth import AuthContext
from fastmcp.server.auth.providers.github import GitHubProvider
from fastmcp.server.middleware import AuthMiddleware, Middleware
from fastmcp.server.providers.proxy import ProxyClient
from fastmcp.tools import ToolResult
from key_value.aio.stores.filetree import FileTreeStore
from key_value.aio.wrappers.encryption import FernetEncryptionWrapper
from pydantic import BaseModel, ConfigDict, Field

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG = PROJECT_ROOT / ".tmp-current-grok-oauth-config.json"
BIND_HOST, BIND_PORT = "127.0.0.1", 7880
BACKEND_URL = "http://127.0.0.1:7879/mcp"
TOOLS = frozenset({
    "list_footnote_requests", "get_footnote_request", "submit_footnote",
    "list_annotation_jobs", "get_annotation_pages", "get_annotation_reference",
    "submit_page_annotations", "finish_annotation_job",
})
HANDOFF_TOOLS = frozenset({"start_assistant_app", "assistant_app_status"})
TOOLS = TOOLS | HANDOFF_TOOLS
# Keep in step with WORKFLOW and INSTRUCTIONS in src/mcp.rs: the bridge sends
# these when an assistant connects, before any call reaches `lc mcp`.
WORKFLOW = (
    "You are connected to a reader's Pen Island footnote inbox. The reader selects text in "
    "a document and asks for a footnote; each request waits here until an assistant answers "
    "it. To answer: call list_footnote_requests, then for each request call "
    "get_footnote_request and submit_footnote. Read any attachments in extras.references "
    "before answering. Only answer requests listed here, and never invent request ids. If "
    "the inbox is empty, say so. The reader may also ask for this page or a page range (a "
    "chapter) to be annotated: call list_annotation_jobs, read each job's pages a few at a "
    "time with get_annotation_pages, call submit_page_annotations once per page with the "
    "footnotes worth adding (each quoting the exact words it is about), then "
    "finish_annotation_job. When a job lists attachments in references, read them first "
    "with get_annotation_reference. Attached files and PDF pages may hold problems or other "
    "tasks (exercises, homework, essay prompts, discussion questions), solved homework or "
    "notes; infer which from their content. Aim the footnotes at the relevant ideas, and "
    "use tasks only for hints, previews and explanations; never solve them or quote or "
    "paraphrase solutions. If you can run scheduled or repeating tasks, offer to check for "
    "new requests and jobs every few minutes."
)
FOOTNOTE_GUIDE = (
    "Every request and every page run carries a guide (in get_footnote_request and "
    "get_annotation_pages) saying what the reader is reading and how they want the notes "
    "shaped: free-form notes, or labelled `fields` from their preset. Follow it. Explain "
    "the quoted words in the context of the surrounding text, for a reader in the middle of "
    "this document. For a selection, use extras.per_page as the limit on the number of "
    "notes when present; otherwise write 2-4. Follow extras.focus and the request's prompt "
    "when provided. Attachments in extras.references may hold problems, solved homework or "
    "notes; infer which from their content; use them to explain and to point toward "
    "problems with hints and previews, and never solve a problem or quote or paraphrase a "
    "solution. Add links only to sources you are confident exist."
)
JOB_GUIDE = (
    "Choose the passages a thoughtful reader of this kind of text would most want "
    "explained, following the job's focus and guide. Attached files and PDF pages may hold "
    "tasks (exercises, homework, essay prompts, discussion questions), solved homework or "
    "notes; infer which from their content rather than their title or kind. Solved homework "
    "is only for seeing which ideas matter; never quote or paraphrase its solutions. "
    "Highlight the key words; underline the phrase the explanation hinges on."
)
INSTRUCTIONS = f"{WORKFLOW}\n\nHow to write each footnote: {FOOTNOTE_GUIDE}"


class SetupError(ValueError):
    """Only static, safe messages may be placed in this exception."""


@dataclass(frozen=True, repr=False)
class BridgeConfig:
    public_base_url: str
    github_owner_id: int
    github_client_id: str
    github_client_secret: str = field(repr=False)
    backend_token_file: Path
    state_dir: Path
    storage_key_file: Path
    backend_token: str = field(repr=False)
    storage_key: bytes = field(repr=False)


def _local_path(value: Any, field_name: str, root: Path) -> Path:
    if not isinstance(value, str) or not value.strip():
        raise SetupError(f"{field_name} must name a project-local path")
    try:
        path = Path(value)
        path = (path if path.is_absolute() else root / path).resolve()
        path.relative_to(root.resolve())
    except (OSError, ValueError):
        raise SetupError(f"{field_name} must stay inside the project") from None
    return path


def load_config(path: Path = DEFAULT_CONFIG, *, root: Path = PROJECT_ROOT) -> BridgeConfig:
    try:
        if path.stat().st_size > 16_384:
            raise SetupError("OAuth configuration is too large")
        raw = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise SetupError("Cannot read a valid local OAuth configuration") from None
    fields = {
        "public_base_url", "github_owner_id", "github_client_id", "github_client_secret",
        "backend_token_file", "state_dir", "storage_key_file",
    }
    if not isinstance(raw, dict) or set(raw) != fields:
        raise SetupError("OAuth configuration must contain exactly the documented fields")
    origin = raw["public_base_url"]
    if not isinstance(origin, str):
        raise SetupError("public_base_url must be an HTTPS origin")
    try:
        url = urlsplit(origin)
        valid_origin = (url.scheme == "https" and bool(url.hostname)
                        and url.username is None and url.password is None
                        and url.port is None and url.path in ("", "/")
                        and not url.query and not url.fragment
                        and re.fullmatch(r"[A-Za-z0-9.-]+", url.hostname) is not None)
    except ValueError:
        valid_origin = False
    if not valid_origin:
        raise SetupError("public_base_url must be an HTTPS origin without credentials, query or path")
    origin = origin.rstrip("/")
    owner = raw["github_owner_id"]
    if type(owner) is not int or owner <= 0:
        raise SetupError("github_owner_id must be the verified positive integer account ID")
    client_id, secret = raw["github_client_id"], raw["github_client_secret"]
    if not client_id or not secret:
        raise SetupError("GitHub OAuth client ID and client secret are required; the bridge stays disabled")
    if not isinstance(client_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{10,200}", client_id):
        raise SetupError("GitHub OAuth client ID has an invalid format")
    if not isinstance(secret, str) or not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", secret):
        raise SetupError("GitHub OAuth client secret has an invalid format")
    token_path = _local_path(raw["backend_token_file"], "backend_token_file", root)
    state = _local_path(raw["state_dir"], "state_dir", root)
    key_path = _local_path(raw["storage_key_file"], "storage_key_file", root)
    try:
        if token_path.stat().st_size > 4096 or key_path.stat().st_size > 4096:
            raise SetupError("Local authentication files are invalid")
        token = token_path.read_text(encoding="ascii").strip()
        key = key_path.read_bytes().strip()
        seed = base64.b64decode(key, altchars=b"-_", validate=True)
    except (OSError, UnicodeError, ValueError):
        raise SetupError("Cannot read valid local authentication files") from None
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", token) or len(seed) != 32:
        raise SetupError("Local authentication files are invalid")
    if len(set(seed)) < 8:
        raise SetupError("The OAuth storage key must be randomly generated")
    return BridgeConfig(origin, owner, client_id, secret, token_path, state, key_path, token, key)


def owner_check(owner_id: int):
    def allowed(ctx: AuthContext) -> bool:
        # In pinned FastMCP4.1, GitHubProvider obtains these claims from the
        # authenticated GitHub /user API after OAuthProxy token verification.
        token = ctx.token
        claims = token.claims if token is not None else None
        user = claims.get("github_user_data") if isinstance(claims, dict) else None
        identity = user.get("id") if isinstance(user, dict) else None
        return (type(identity) is int and identity == owner_id
                and claims.get("sub") == str(identity))
    return allowed


def backend_http_client(token: str, *, transport=None, **_kwargs) -> httpx2.AsyncClient:
    # No environment proxy, cookie, client header or redirect can take this
    # private backend credential away from its fixed loopback destination.
    return httpx2.AsyncClient(
        headers={"Authorization": f"Bearer {token}"},
        timeout=30.0, follow_redirects=False, trust_env=False, transport=transport,
    )


def github_auth(config: BridgeConfig) -> GitHubProvider:
    store = FileTreeStore(data_directory=config.state_dir / "oauth")
    encrypted = FernetEncryptionWrapper(key_value=store, fernet=Fernet(config.storage_key))
    seed = base64.b64decode(config.storage_key, altchars=b"-_", validate=True)
    signing_key = hmac.digest(seed, b"Pen Island MCP OAuth signing key v1", hashlib.sha256)
    return GitHubProvider(
        client_id=config.github_client_id,
        client_secret=config.github_client_secret,
        base_url=config.public_base_url,
        redirect_path="/auth/callback",
        required_scopes=["read:user"],
        client_storage=encrypted,
        jwt_signing_key=signing_key,
        require_authorization_consent=True,
        enable_cimd=False,
    )


class FootnoteLink(BaseModel):
    model_config = ConfigDict(extra="forbid")
    url: str
    title: str | None = None


class NoteField(BaseModel):
    model_config = ConfigDict(extra="forbid")
    label: str = Field(description="One of the request's fields, as listed in its guide.")
    text: str = Field(description="Plain prose specific to the quoted words; the label is added for you.")


class PageAnnotation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    quote: str = Field(description="Exact words from the page that this footnote is about.")
    notes: Annotated[list[str], Field(max_length=8)] | None = Field(
        default=None, description="Free-form markdown notes, when the guide asks for free-form notes.")
    fields: Annotated[list[NoteField], Field(max_length=8)] | None = Field(
        default=None, description="When the guide names fields: the body as labelled fields. Leave out notes then.")
    title: Annotated[str, Field(max_length=120)] | None = None
    color: Annotated[int, Field(ge=1, le=8)] | None = None
    links: list[FootnoteLink] | None = None
    marks: list["FootnoteMark"] | None = None
    workspace_links: list[str] | None = None


class FootnoteMark(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["highlight", "underline"]
    quote: str = Field(description="Exact words copied from extras.mark_text.")
    color: Annotated[int, Field(ge=1, le=8)] | None = Field(default=None, description="Optional palette slot.")


def build_bridge(config: BridgeConfig, *, auth_provider=None, backend_transport=None) -> FastMCP:
    """The optional arguments are in-process test seams, never CLI options."""
    auth = auth_provider if auth_provider is not None else github_auth(config)
    backend = ProxyClient(
        StreamableHttpTransport(
            BACKEND_URL,
            headers={"Authorization": f"Bearer {config.backend_token}"},
            httpx_client_factory=lambda **kw: backend_http_client(
                config.backend_token, transport=backend_transport, **kw),
        ),
        forward_incoming_headers=False,
        mode="legacy",
        timeout=30.0,
    )
    class HandoffGate(Middleware):
        """Offer the hand-off tools only while `lc mcp` does (the reader's Settings switch)."""

        async def on_list_tools(self, context, call_next):
            tools = await call_next(context)
            try:
                async with backend.new() as client:
                    offered = {tool.name for tool in await client.list_tools()}
            except Exception:
                offered = set()
            return [tool for tool in tools if tool.name not in HANDOFF_TOOLS or tool.name in offered]

    bridge = FastMCP(
        "Pen Island ChatBot", instructions=INSTRUCTIONS, version="1.0.0",
        auth=auth, middleware=[AuthMiddleware(auth=owner_check(config.github_owner_id)), HandoffGate()],
        mask_error_details=True,
    )

    async def relay(name: str, arguments: dict[str, Any]) -> ToolResult:
        if name not in TOOLS:
            raise ValueError("Unknown footnote tool")
        async with backend.new() as client:
            result = await client.call_tool_mcp(name, arguments, timeout=30.0)
            return ToolResult(
                content=result.content, structured_content=result.structured_content,
                meta=result.meta, is_error=result.is_error,
            )

    async def relay_prompt(name: str) -> str:
        # The prompt wording lives in `lc mcp`; the bridge only passes it on.
        async with backend.new() as client:
            result = await client.get_prompt_mcp(name)
        return "\n\n".join(m.content.text for m in result.messages if getattr(m.content, "text", None))

    @bridge.prompt(name="answer_footnotes", title="Answer my footnote requests",
                   description="Answer every pending footnote request once.")
    async def answer_footnotes() -> str:
        return await relay_prompt("answer_footnotes")

    @bridge.prompt(name="watch_footnotes", title="Keep answering footnote requests",
                   description="Answer pending requests now, then keep checking for new ones.")
    async def watch_footnotes() -> str:
        return await relay_prompt("watch_footnotes")

    @bridge.tool(name="list_footnote_requests", output_schema=None,
                 annotations={"readOnlyHint": True, "openWorldHint": False})
    async def list_footnote_requests() -> ToolResult:
        """List pending footnote requests, oldest first, including excerpt and context."""
        return await relay("list_footnote_requests", {})

    @bridge.tool(name="get_footnote_request", output_schema=None,
                 annotations={"readOnlyHint": True, "openWorldHint": False})
    async def get_footnote_request(id: str) -> ToolResult:
        """Read one footnote request: wide context, existing page notes, and extras (palette, exact mark text, library items, focus, per_page note limit, and attached files or PDF pages in references with their text). Infer whether attachments contain problems, solved homework or notes; never solve problems or quote solutions."""
        return await relay("get_footnote_request", {"id": id})

    @bridge.tool(name="submit_footnote", output_schema=None,
                 annotations={"readOnlyHint": False, "destructiveHint": False, "openWorldHint": False})
    async def submit_footnote(
        id: str, notes: Annotated[list[str], Field(max_length=8)] | None = None,
        fields: Annotated[list[NoteField], Field(max_length=8)] | None = None,
        links: list[FootnoteLink] | None = None,
        title: Annotated[str, Field(max_length=120)] | None = None,
        color: Annotated[int, Field(ge=1, le=8)] | None = None,
        marks: Annotated[list[FootnoteMark], Field(max_length=12)] | None = None,
        workspace_links: Annotated[list[str], Field(max_length=8)] | None = None,
    ) -> ToolResult:
        """Save a footnote for one pending request. Everything is added; nothing of the reader's is replaced.

        Follow the request's guide: free-form notes, or labelled fields from the reader's preset.
        Optional: a short title and a palette color slot (used only if the reader hasn't set them),
        highlights/underlines quoting exact words from extras.mark_text, and workspace_links
        (ids from extras.workspace_items)."""
        arguments: dict[str, Any] = {
            "id": id, "notes": notes or [],
            "links": [link.model_dump(exclude_none=True) for link in links or []],
        }
        if fields:
            arguments["fields"] = [field.model_dump() for field in fields]
        if title is not None:
            arguments["title"] = title
        if color is not None:
            arguments["color"] = color
        if marks:
            arguments["marks"] = [mark.model_dump(exclude_none=True) for mark in marks]
        if workspace_links:
            arguments["workspace_links"] = workspace_links
        return await relay("submit_footnote", arguments)

    @bridge.tool(name="list_annotation_jobs", output_schema=None,
                 annotations={"readOnlyHint": True, "openWorldHint": False})
    async def list_annotation_jobs() -> ToolResult:
        """List page ranges (such as a chapter) the reader wants annotated, oldest first."""
        return await relay("list_annotation_jobs", {})

    @bridge.tool(name="get_annotation_pages", output_schema=None,
                 annotations={"readOnlyHint": True, "openWorldHint": False})
    async def get_annotation_pages(job_id: str, from_page: int | None = None, to_page: int | None = None) -> ToolResult:
        """Read up to five pages of an annotation job with its focus, per-page limit, palette, library items and attachments in references (read them with get_annotation_reference). Infer whether attachments contain problems, solved homework or notes; never solve problems or quote solutions."""
        arguments: dict[str, Any] = {"job_id": job_id}
        if from_page is not None:
            arguments["from_page"] = from_page
        if to_page is not None:
            arguments["to_page"] = to_page
        return await relay("get_annotation_pages", arguments)

    @bridge.tool(name="get_annotation_reference", output_schema=None,
                 annotations={"readOnlyHint": True, "openWorldHint": False})
    async def get_annotation_reference(job_id: str, index: int, offset: int | None = None) -> ToolResult:
        """Read one of a job's attachments: a library file or PDF pages. Infer whether its content holds problems, solved homework or notes. Use problems for hints, previews and explanations; never solve them or quote or paraphrase solutions. Long attachments come in parts: pass next_offset as offset to continue."""
        arguments: dict[str, Any] = {"job_id": job_id, "index": index}
        if offset is not None:
            arguments["offset"] = offset
        return await relay("get_annotation_reference", arguments)

    @bridge.tool(name="submit_page_annotations", output_schema=None,
                 description=(
                     "Add footnotes to one page of an annotation job: only passages worth explaining, "
                     "at most per_page. Each quotes the exact words it is about (copied from that page's "
                     f"text); the reader's app places it there. {FOOTNOTE_GUIDE} {JOB_GUIDE}"
                 ),
                 annotations={"readOnlyHint": False, "destructiveHint": False, "openWorldHint": False})
    async def submit_page_annotations(
        job_id: str, page: int, annotations: Annotated[list[PageAnnotation], Field(min_length=1, max_length=8)],
    ) -> ToolResult:
        """Add footnotes to one page: each quotes the exact words it is about; the reader's app places it there."""
        return await relay("submit_page_annotations", {
            "job_id": job_id, "page": page,
            "annotations": [annotation.model_dump(exclude_none=True) for annotation in annotations],
        })

    @bridge.tool(name="finish_annotation_job", output_schema=None,
                 annotations={"readOnlyHint": False, "destructiveHint": False, "openWorldHint": False})
    async def finish_annotation_job(job_id: str, summary: str = "") -> ToolResult:
        """Mark an annotation job finished, with a short summary for the reader."""
        return await relay("finish_annotation_job", {"job_id": job_id, "summary": summary})

    @bridge.tool(name="start_assistant_app", output_schema=None,
                 annotations={"readOnlyHint": False, "destructiveHint": False, "openWorldHint": False})
    async def start_assistant_app(job_id: str | None = None) -> ToolResult:
        """Hand the writing to the assistant app on the reader's PC (Codex or Claude Code, on their own subscription) instead of writing the footnotes yourself. Without job_id it takes every pending footnote request; with job_id it takes that page run. It runs in the background and takes minutes: call assistant_app_status every 30-60 seconds until state is done or failed, then tell the reader how it went. Use it when the reader asks you to use Codex, Claude Code or their PC."""
        return await relay("start_assistant_app", {} if job_id is None else {"job_id": job_id})

    @bridge.tool(name="assistant_app_status", output_schema=None,
                 annotations={"readOnlyHint": True, "openWorldHint": False})
    async def assistant_app_status() -> ToolResult:
        """Progress of the assistant app on the reader's PC: state (idle, running, done or failed), start and finish times, the page run, requests answered, and any error."""
        return await relay("assistant_app_status", {})

    return bridge


def build_app(config: BridgeConfig, **test_seams):
    bridge = build_bridge(config, **test_seams)
    app = bridge.http_app(
        path="/mcp", stateless_http=True, json_response=True,
        host_origin_protection=True,
        allowed_hosts=[urlsplit(config.public_base_url).netloc],
        allowed_origins=[config.public_base_url],
    )
    return app


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG,
                        help="Path to the local JSON setup file; never pass credentials here")
    args = parser.parse_args(argv)
    try:
        config = load_config(args.config)
        app = build_app(config)
    except SetupError as error:
        print(f"ChatBot OAuth setup: {error}", file=sys.stderr)
        return 2
    except Exception:
        print("ChatBot OAuth could not initialize; check local setup and pinned dependencies.", file=sys.stderr)
        return 2
    # OAuth callback URLs contain codes and state. No access/debug/error trace
    # is allowed to echo those URLs, credentials or local configuration values.
    logging.disable(logging.CRITICAL)
    import uvicorn
    print("Starting authenticated ChatBot OAuth bridge on 127.0.0.1:7880.")
    try:
        uvicorn.run(app, host=BIND_HOST, port=BIND_PORT, access_log=False,
                    log_config=None, log_level="critical")
    except (OSError, SystemExit):
        print("ChatBot OAuth stopped; check that its loopback port is available.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
