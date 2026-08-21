"""Tools for the agentic path.

Subclass the real `echo_agent.tools.Tool` ABC — context.register_tool() does an
isinstance check (plugins/context.py:62) and rejects duck-typed objects.

error_kind matters: `business` (no permission, nothing found) must not trip the
circuit breaker, while `dependency` (server down) should. Getting this wrong
means one unreachable server disables tools for every session.
"""

from __future__ import annotations

from typing import Any

from echo_agent.tools.base import Tool, ToolResult

from .errors import OrgUnauthorized, OrgUnavailable
from .grounding import render

_SCOPE_NOTE = (
    "只返回当前用户有权访问的内容；权限由服务端强制，无权限时会返回空结果。"
)


class _OrgTool(Tool):
    """Shared plumbing: uniform failure mapping for every org tool."""

    risk_level = "read"

    def __init__(self, client, *, budget: int = 6000):
        self._client = client
        self._budget = budget

    def execution_mode(self, params: dict[str, Any]) -> str:
        return "read_only"

    def is_ready(self) -> bool:
        return self._client.credentials.logged_in

    def readiness_detail(self) -> tuple[bool, str]:
        if not self._client.credentials.logged_in:
            return False, "未登录企业服务器，无法访问组织知识库"
        return True, "ok"

    @staticmethod
    def _fail(e: Exception) -> ToolResult:
        if isinstance(e, OrgUnauthorized):
            return ToolResult(
                success=False,
                error="企业凭证无效或已过期，请重新登录后再试",
                error_kind="business",
            )
        if isinstance(e, OrgUnavailable):
            return ToolResult(
                success=False,
                error=f"组织知识库暂时不可达：{e}",
                error_kind="dependency",
            )
        return ToolResult(
            success=False, error=f"{type(e).__name__}: {e}", error_kind="internal"
        )


class OrgSearchTool(_OrgTool):
    name = "org_search"
    description = (
        "检索企业组织知识库（制度、产品文档、SOP、会议结论）。"
        "多跳问题可多次调用，每次换一个更具体的子问题。" + _SCOPE_NOTE
    )
    parameters = {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "检索问题，越具体越好"},
            "limit": {"type": "integer", "description": "返回条数，默认 8"},
        },
        "required": ["query"],
    }

    async def execute(self, params, ctx=None) -> ToolResult:
        try:
            result = await self._client.retrieve(
                params["query"], limit=int(params.get("limit", 8))
            )
        except Exception as e:
            return self._fail(e)

        if result.empty:
            return ToolResult(
                success=True, output="组织知识库里没有找到相关内容。"
            )
        return ToolResult(
            success=True,
            output=render(result, budget=self._budget),
            metadata={"chunks": len(result.chunks), **result.diagnostics},
        )


class OrgFetchDocTool(_OrgTool):
    name = "org_fetch_doc"
    description = (
        "取组织文档的完整段落用于精读，适合已知 doc_id 但检索片段不够的场景。"
        + _SCOPE_NOTE
    )
    parameters = {
        "type": "object",
        "properties": {
            "doc_id": {"type": "string"},
            "page": {"type": "integer", "description": "页码，可选"},
        },
        "required": ["doc_id"],
    }

    async def execute(self, params, ctx=None) -> ToolResult:
        try:
            data = await self._client._post(
                "/api/v1/docs/fetch",
                {"docId": params["doc_id"], "page": params.get("page")},
            )
        except Exception as e:
            return self._fail(e)
        text = str(data.get("text") or "")
        if not text:
            return ToolResult(success=True, output="该文档没有可读内容或无权访问。")
        return ToolResult(success=True, output=text[: self._budget * 3])


class OrgWhoKnowsTool(_OrgTool):
    name = "org_who_knows"
    description = "找出某个主题在公司内的负责人或高频贡献者，用于回答「该问谁」。"
    parameters = {
        "type": "object",
        "properties": {"topic": {"type": "string"}},
        "required": ["topic"],
    }

    async def execute(self, params, ctx=None) -> ToolResult:
        try:
            people = await self._client.who_knows(params["topic"])
        except Exception as e:
            return self._fail(e)
        if not people:
            return ToolResult(success=True, output="没有找到该主题的明确负责人。")
        lines = [
            f"- {p.get('displayName') or p.get('display_name') or '?'}：{p.get('reason', '')}"
            for p in people
        ]
        return ToolResult(success=True, output="\n".join(lines))


class OrgSubmitKnowledgeTool(_OrgTool):
    name = "org_submit_knowledge"
    description = (
        "把一条结论提交到组织知识库的审核队列。不会直接生效，需管理员审核。"
        "只在用户明确表示要沉淀/记录时调用。"
    )
    risk_level = "write"
    parameters = {
        "type": "object",
        "properties": {
            "kind": {
                "type": "string",
                "enum": ["fact", "decision", "convention", "pitfall", "howto"],
            },
            "content": {"type": "string", "description": "一句话陈述，300 字内"},
            "rationale": {"type": "string", "description": "为什么成立"},
            "target_scope": {"type": "string", "description": "目标 scope id"},
        },
        "required": ["kind", "content"],
    }

    def execution_mode(self, params: dict[str, Any]) -> str:
        return "side_effect"

    async def execute(self, params, ctx=None) -> ToolResult:
        try:
            pid = await self._client.submit_knowledge(
                kind=params["kind"],
                content=params["content"],
                rationale=params.get("rationale", ""),
                target_scope=params.get("target_scope", ""),
            )
        except Exception as e:
            return self._fail(e)
        return ToolResult(
            success=True,
            output=f"已提交待审核（编号 {pid}）。管理员通过后全公司可检索到。",
            metadata={"promotion_id": pid},
        )


def build_tools(client, *, budget: int = 6000) -> list[Tool]:
    return [
        OrgSearchTool(client, budget=budget),
        OrgFetchDocTool(client, budget=budget),
        OrgWhoKnowsTool(client, budget=budget),
        OrgSubmitKnowledgeTool(client, budget=budget),
    ]
