"""Routing decides token spend: agentic costs 3-10x a single retrieval, so the
default must lean FAST and only escalate on real multi-hop signals.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from echo_agent_org.router import PlanKind, classify, last_user_text  # noqa: E402


@pytest.mark.parametrize(
    "query",
    ["你好", "hi", "谢谢", "嗯", "1+1", "翻译上面这段", "润色一下", "格式化这段代码"],
)
def test_no_retrieval_cases(query):
    assert classify(query).kind is PlanKind.NO_RETRIEVAL


@pytest.mark.parametrize(
    "query",
    [
        "差旅住宿标准是多少",
        "报销单需要几级审批",
        "XR-2000 型号的保修期",
        "新人入职要准备什么材料",
    ],
)
def test_fast_cases(query):
    assert classify(query).kind is PlanKind.FAST


@pytest.mark.parametrize(
    "query",
    [
        "对比报销流程和差旅政策的区别以及冲突",
        "汇总一下各部门的考勤规定分别是什么",
        "梳理整体流程，以及各自的负责人有哪些",
    ],
)
def test_agentic_cases(query):
    assert classify(query).kind is PlanKind.AGENTIC


def test_two_questions_escalate():
    q = "报销上限是多少？审批要几级？"
    assert classify(q).kind is PlanKind.AGENTIC


def test_tool_only_mode_forces_agentic():
    plan = classify("差旅住宿标准是多少", {"inject_mode": "tool_only"})
    assert plan.kind is PlanKind.AGENTIC


def test_agentic_can_be_disabled():
    """Cost control: an org may want to cap token spend."""
    plan = classify("对比报销流程和差旅政策的区别以及冲突", {"allow_agentic": False})
    assert plan.kind is PlanKind.FAST


def test_last_user_text_plain():
    msgs = [
        {"role": "user", "content": "第一轮"},
        {"role": "assistant", "content": "答"},
        {"role": "user", "content": "第二轮"},
    ]
    assert last_user_text(msgs) == "第二轮"


def test_last_user_text_multimodal():
    msgs = [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "这张图里"},
                {"type": "image", "url": "x"},
                {"type": "text", "text": "写了什么"},
            ],
        }
    ]
    assert last_user_text(msgs) == "这张图里 写了什么"


def test_last_user_text_no_user_message():
    assert last_user_text([{"role": "system", "content": "s"}]) == ""
    assert last_user_text([]) == ""
    assert last_user_text(None) == ""


def test_plan_carries_reason():
    """Reasons surface in logs when tuning thresholds."""
    assert classify("你好").reason
    assert classify("差旅住宿标准是多少").reason
