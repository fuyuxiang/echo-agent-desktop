"""The contract test that matters: injection must actually happen.

hooks.py:104 reads ONLY `.modified` off a hook's return value, and hooks.py:109
swallows any exception into a warning. So a hook that returns a bare list fails
silently — plugin loads, logs look clean, no material is injected.

Every assertion here is positive (message count grew, material is present).
Asserting "no exception raised" would let that bug pass.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from echo_agent.plugins.hooks import HookRegistry, HookResult  # noqa: E402

from echo_agent_org.grounding import (  # noqa: E402
    GROUNDING_RULES,
    insert_materials,
    render,
)
from echo_agent_org.types import Chunk, Citation, Memory, RetrieveResult  # noqa: E402


def _result() -> RetrieveResult:
    return RetrieveResult(
        chunks=[
            Chunk(
                chunk_id="c1",
                doc_id="d1",
                doc_title="费用报销管理办法 V3",
                text="一线城市住宿标准 500 元/晚，其他城市 350 元/晚。",
                score=0.91,
                citation=Citation(page=7, heading="第4章 > 4.2 住宿标准"),
            )
        ],
        memories=[Memory(id="m1", kind="convention", content="报销单需直属上级先签。")],
    )


def test_bare_list_return_is_silently_dropped():
    """Documents the failure mode, so a regression is caught here first."""
    reg = HookRegistry()

    async def bad_hook(messages, tool_defs, model, **kw):
        return messages + [{"role": "user", "content": "MATERIAL"}]

    reg.register("pre_llm_call", bad_hook, plugin="bad")
    base = [{"role": "user", "content": "住宿标准"}]

    async def run():
        return await reg.dispatch_modify("pre_llm_call", base, [], "m")

    import asyncio

    out = asyncio.run(run())
    # The bug: no exception surfaces, but nothing was injected either.
    assert len(out) == 1, "bare list should be dropped — this is why we use HookResult"


async def test_hookresult_return_actually_injects():
    reg = HookRegistry()
    material = render(_result())

    async def good_hook(messages, tool_defs, model, **kw):
        return HookResult(modified=insert_materials(messages, material))

    reg.register("pre_llm_call", good_hook, plugin="org")
    base = [{"role": "user", "content": "住宿标准是多少"}]
    out = await reg.dispatch_modify("pre_llm_call", base, [], "m")

    assert len(out) == 2, "material message must be added"
    joined = " ".join(str(m.get("content", "")) for m in out)
    assert "500" in joined, "retrieved facts must reach the model"
    assert GROUNDING_RULES.splitlines()[0] in joined, "citation rules must be present"


async def test_material_precedes_last_user_message():
    """Order matters: the model should read material before the question."""
    material = render(_result())
    base = [
        {"role": "user", "content": "第一轮"},
        {"role": "assistant", "content": "答"},
        {"role": "user", "content": "住宿标准"},
    ]
    out = insert_materials(base, material)

    assert len(out) == 4
    assert out[2]["content"] is material or "材料" in out[2]["content"]
    assert out[3]["content"] == "住宿标准", "last user message must stay last"


def test_insert_does_not_mutate_input():
    base = [{"role": "user", "content": "q"}]
    insert_materials(base, "MATERIAL")
    assert len(base) == 1, "core may reuse the caller's list; never mutate it"


def test_render_marks_stale_and_cache():
    res = _result()
    res.chunks[0].stale = True
    res.from_cache = True
    out = render(res)
    assert "[可能过时]" in out
    assert "本地缓存" in out


def test_render_respects_token_budget():
    big = RetrieveResult(
        chunks=[
            Chunk(
                chunk_id=f"c{i}",
                doc_id="d",
                doc_title="T",
                text="报销标准说明。" * 200,
                score=1.0 - i * 0.1,
            )
            for i in range(10)
        ]
    )
    out = render(big, budget=800)
    # At least one chunk survives, but not all ten.
    assert "[1]" in out
    assert "[10]" not in out


def test_render_empty_returns_empty_string():
    assert render(RetrieveResult()) == ""


def test_insert_with_empty_material_is_noop():
    base = [{"role": "user", "content": "q"}]
    assert insert_materials(base, "") == base
