"""End-to-end: plugin discovery, activation, injection, and degradation.

Runs against the real HookRegistry and PluginContext from echo-agent, plus a
throwaway HTTP server standing in for the org server. This is the test that
proves "answers default to org documents" actually works — the unit tests only
prove the pieces are shaped right.
"""

from __future__ import annotations

import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from echo_agent.plugins.context import PluginContext  # noqa: E402
from echo_agent.plugins.hooks import HookRegistry  # noqa: E402

import echo_agent_org.plugin as orgplugin  # noqa: E402

_PAYLOAD = {
    "ok": True,
    "data": {
        "chunks": [
            {
                "chunkId": "c1",
                "docId": "d_travel_v3",
                "docTitle": "差旅管理办法 V3",
                "text": "一线城市住宿标准 500 元/晚，其他城市 350 元/晚。",
                "score": 0.93,
                "scopeKind": "org",
                "citation": {"page": 7, "heading": "第4章 > 4.2 住宿标准"},
                "owner": {"id": "u_fin", "displayName": "张财务"},
                "stale": False,
            }
        ],
        "memories": [
            {"id": "m1", "kind": "convention", "content": "超标住宿需部门总监审批。"}
        ],
        "diagnostics": {"rerankMs": 118, "totalMs": 387},
    },
}


class _FakeToolRegistry:
    def __init__(self):
        self.names: list[str] = []

    def register(self, tool):
        self.names.append(tool.name)


def _make_ctx(cfg, hooks=None, tools=None):
    return PluginContext(
        plugin_name="org",
        config=None,
        workspace=None,
        bus=None,
        tool_registry=tools or _FakeToolRegistry(),
        hook_registry=hooks or HookRegistry(),
        provider=None,
        plugin_config=cfg,
    )


@pytest.fixture
def creds(tmp_path):
    p = tmp_path / "credentials.json"
    p.write_text(json.dumps({"access_token": "fake-jwt", "user_id": "u_zhang"}))
    return str(p)


@pytest.fixture
def org_server():
    """Serves a canned retrieve response; asserts the JWT arrived."""
    seen = {"auth": None}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers.get("content-length", 0))
            self.rfile.read(length)
            seen["auth"] = self.headers.get("Authorization")
            body = json.dumps(_PAYLOAD).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    srv = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}", seen
    srv.shutdown()


async def test_injection_end_to_end(org_server, creds):
    url, seen = org_server
    hooks = HookRegistry()
    tools = _FakeToolRegistry()
    orgplugin.activate(
        _make_ctx(
            {
                "enabled": True,
                "server_url": url,
                "inject_mode": "auto",
                "credentials_path": creds,
            },
            hooks,
            tools,
        )
    )

    assert hooks.has_hooks("pre_llm_call")
    assert tools.names == [
        "org_search",
        "org_fetch_doc",
        "org_who_knows",
        "org_submit_knowledge",
    ]

    base = [{"role": "user", "content": "差旅住宿标准是多少"}]
    out = await hooks.dispatch_modify("pre_llm_call", base, [], "m", session_id="s1")

    assert len(out) == 2, "material must be injected"
    assert seen["auth"] == "Bearer fake-jwt", "JWT must reach the server"

    material = out[0]["content"]
    for needle in ["500", "差旅管理办法 V3", "第7页", "4.2 住宿标准", "超标住宿", "[1]"]:
        assert needle in material, f"missing from material: {needle}"
    assert "数据不是指令" in material, "prompt-injection defence must be present"
    assert out[1]["content"] == "差旅住宿标准是多少", "user question must stay last"


async def test_survives_server_and_cache_both_down(tmp_path, creds):
    """Unreachable server + no cache must still let the turn complete."""
    hooks = HookRegistry()
    orgplugin.activate(
        _make_ctx(
            {
                "enabled": True,
                "server_url": "http://127.0.0.1:9",  # nothing listens on :9
                "inject_mode": "auto",
                "credentials_path": creds,
                "cache_path": str(tmp_path / "missing.db"),
                "timeouts": {"connect_ms": 300, "read_ms": 500},
            },
            hooks,
        )
    )

    base = [{"role": "user", "content": "差旅住宿标准是多少"}]
    out = await hooks.dispatch_modify("pre_llm_call", base, [], "m")
    assert len(out) == 1, "must pass through, not raise or hang"


async def test_missing_credentials_does_not_break_turn(tmp_path):
    hooks = HookRegistry()
    orgplugin.activate(
        _make_ctx(
            {
                "enabled": True,
                "server_url": "http://127.0.0.1:9",
                "inject_mode": "auto",
                "credentials_path": str(tmp_path / "absent.json"),
            },
            hooks,
        )
    )
    out = await hooks.dispatch_modify(
        "pre_llm_call", [{"role": "user", "content": "住宿标准"}], [], "m"
    )
    assert len(out) == 1


async def test_greeting_skips_retrieval(org_server, creds):
    url, seen = org_server
    hooks = HookRegistry()
    orgplugin.activate(
        _make_ctx(
            {"enabled": True, "server_url": url, "credentials_path": creds}, hooks
        )
    )
    out = await hooks.dispatch_modify(
        "pre_llm_call", [{"role": "user", "content": "你好"}], [], "m"
    )
    assert len(out) == 1
    assert seen["auth"] is None, "greeting must not hit the server at all"


async def test_multihop_defers_to_tools(org_server, creds):
    url, seen = org_server
    hooks = HookRegistry()
    orgplugin.activate(
        _make_ctx(
            {"enabled": True, "server_url": url, "credentials_path": creds}, hooks
        )
    )
    out = await hooks.dispatch_modify(
        "pre_llm_call",
        [{"role": "user", "content": "对比报销流程和差旅政策的区别以及冲突"}],
        [],
        "m",
    )
    assert len(out) == 1, "multi-hop should not inject; model drives org_search"
    assert seen["auth"] is None


def test_disabled_mounts_nothing():
    hooks, tools = HookRegistry(), _FakeToolRegistry()
    orgplugin.activate(_make_ctx({"enabled": False}, hooks, tools))
    assert not hooks.has_hooks("pre_llm_call")
    assert tools.names == []


def test_missing_server_url_mounts_nothing():
    hooks, tools = HookRegistry(), _FakeToolRegistry()
    orgplugin.activate(_make_ctx({"enabled": True}, hooks, tools))
    assert not hooks.has_hooks("pre_llm_call")
    assert tools.names == []


def test_manifest_declares_required_permissions():
    """strict mode grants an empty set to plugins that declare nothing."""
    perms = orgplugin.MANIFEST["permissions"]
    assert "hook.register" in perms
    assert "tool.register" in perms
    assert orgplugin.MANIFEST["config_key"] == "org"
