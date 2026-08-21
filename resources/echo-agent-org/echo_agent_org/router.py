"""Retrieval routing: decide whether a turn needs org material, and how.

Agentic loops cost 3-10x the tokens of a single retrieval, so the default must
lean toward FAST. AGENTIC is an escalation for questions a single lookup cannot
answer (comparison, cross-topic synthesis, full-process walkthroughs).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum


class PlanKind(Enum):
    NO_RETRIEVAL = "no_retrieval"
    FAST = "fast"
    AGENTIC = "agentic"


@dataclass(frozen=True)
class Plan:
    kind: PlanKind
    reason: str = ""


# Multi-hop signals: comparison, aggregation, whole-process questions.
_AGENTIC_PATTERNS = [
    r"对比", r"比较", r"区别", r"差异", r"冲突", r"矛盾",
    r"汇总", r"梳理", r"全貌", r"整体流程", r"哪些",
    r"分别", r"各自", r"以及.*和",
]

# Queries that need no external material at all.
_NO_RETRIEVAL_PATTERNS = [
    r"^(翻译|润色|格式化|改写|总结上面|重写)",
    r"^(你好|hi|hello|谢谢|好的|嗯|在吗)[\s！!。.?？]*$",
    r"^\s*\d+\s*[\+\-\*/]\s*\d+",
]

_MIN_QUERY_LEN = 4


def last_user_text(messages: list) -> str:
    """Extract plain text of the last user message.

    Handles both `content: str` and multimodal `content: [{type, text}]`.
    """
    for msg in reversed(messages or []):
        if not isinstance(msg, dict) or msg.get("role") != "user":
            continue
        content = msg.get("content")
        if isinstance(content, str):
            return content.strip()
        if isinstance(content, list):
            parts = [
                p.get("text", "")
                for p in content
                if isinstance(p, dict) and p.get("type") in ("text", None)
            ]
            return " ".join(parts).strip()
    return ""


def classify(query: str, cfg: dict | None = None) -> Plan:
    """Route a query. Rules first (zero cost); no LLM call here."""
    cfg = cfg or {}
    q = (query or "").strip()

    if len(q) < _MIN_QUERY_LEN:
        return Plan(PlanKind.NO_RETRIEVAL, "query too short")

    for pat in _NO_RETRIEVAL_PATTERNS:
        if re.search(pat, q, re.IGNORECASE):
            return Plan(PlanKind.NO_RETRIEVAL, f"matched {pat!r}")

    if cfg.get("inject_mode") == "tool_only":
        return Plan(PlanKind.AGENTIC, "inject_mode=tool_only")

    if not cfg.get("allow_agentic", True):
        return Plan(PlanKind.FAST, "agentic disabled by config")

    hits = [p for p in _AGENTIC_PATTERNS if re.search(p, q)]
    question_marks = q.count("?") + q.count("？")
    if len(hits) >= 2 or question_marks >= 2:
        return Plan(PlanKind.AGENTIC, f"multi-hop signals: {hits}, q={question_marks}")

    return Plan(PlanKind.FAST, "default")
