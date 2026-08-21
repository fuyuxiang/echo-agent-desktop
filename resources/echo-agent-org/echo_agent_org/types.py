"""Types shared across the org plugin.

Kept dependency-free (stdlib only) so tests can import them without httpx.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Citation:
    """Where a chunk came from — drives click-to-source in the UI."""

    page: int | None = None
    heading: str = ""
    start_ms: int | None = None
    end_ms: int | None = None
    open_url: str = ""

    def render(self) -> str:
        if self.page is not None:
            loc = f"第{self.page}页"
        elif self.start_ms is not None:
            loc = f"{self.start_ms // 60000}分{self.start_ms % 60000 // 1000}秒"
        else:
            loc = ""
        if self.heading:
            loc = f"{loc} {self.heading}".strip()
        return loc or "—"


@dataclass
class Chunk:
    chunk_id: str
    doc_id: str
    doc_title: str
    text: str
    score: float = 0.0
    scope_kind: str = "org"
    modality: str = "text"
    citation: Citation = field(default_factory=Citation)
    owner_name: str = ""
    stale: bool = False
    updated_at: int = 0


@dataclass
class Memory:
    """A distilled org convention/decision — denser than a doc chunk."""

    id: str
    kind: str
    content: str
    scope_kind: str = "org"
    confidence: float = 0.8


@dataclass
class RetrieveResult:
    chunks: list[Chunk] = field(default_factory=list)
    memories: list[Memory] = field(default_factory=list)
    diagnostics: dict = field(default_factory=dict)
    from_cache: bool = False

    @property
    def empty(self) -> bool:
        return not self.chunks and not self.memories
