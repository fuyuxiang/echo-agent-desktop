"""Read-only offline cache.

Its own SQLite file, deliberately not the core's KnowledgeIndex: touching core
storage would couple plugin upgrades to core schema changes. Desktop writes
this file via /api/v1/sync; the plugin only reads.

Chinese FTS5 note: unicode61 splits CJK per character, which tanks recall for
multi-character terms. Desktop writes a bigram column alongside the raw text
("报销审批" -> "报销 销审 审批"); queries are bigram-ised the same way.

Every failure returns an empty result rather than raising — a corrupt or absent
cache must not break a conversation.
"""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path

from .types import Chunk, Citation, RetrieveResult


def cache_path(cfg: dict | None = None) -> Path:
    cfg = cfg or {}
    explicit = cfg.get("cache_path") or os.environ.get("ECHO_ORG_CACHE")
    if explicit:
        return Path(explicit).expanduser()
    home = Path(os.environ.get("ECHO_AGENT_HOME", Path.home() / ".echo-agent"))
    return home / "plugins" / "org" / "cache.db"


def to_bigrams(text: str) -> str:
    """Bigram-ise CJK runs so FTS5 unicode61 can match multi-char terms."""
    out: list[str] = []
    run: list[str] = []

    def flush() -> None:
        if not run:
            return
        s = "".join(run)
        if len(s) == 1:
            out.append(s)
        else:
            out.extend(s[i : i + 2] for i in range(len(s) - 1))
        run.clear()

    for ch in text or "":
        if "一" <= ch <= "鿿":
            run.append(ch)
        else:
            flush()
            if not ch.isspace():
                out.append(ch)
    flush()
    return " ".join(out)


class OrgCache:
    def __init__(self, cfg: dict | None = None, logger=None):
        self._path = cache_path(cfg)
        self._log = logger

    @property
    def available(self) -> bool:
        return self._path.is_file()

    def _connect(self) -> sqlite3.Connection | None:
        if not self.available:
            return None
        try:
            return sqlite3.connect(
                f"file:{self._path}?mode=ro", uri=True, timeout=2.0
            )
        except sqlite3.Error as e:
            if self._log:
                self._log.debug("org cache unreadable: {}", e)
            return None

    def search(self, query: str, *, limit: int = 8) -> RetrieveResult:
        conn = self._connect()
        if conn is None:
            return RetrieveResult(from_cache=True)

        match = to_bigrams(query)
        if not match.strip():
            conn.close()
            return RetrieveResult(from_cache=True)

        sql = """
            SELECT c.chunk_id, c.doc_id, c.title, c.text, c.heading,
                   c.loc_page, c.loc_start_ms, c.scope_kind,
                   bm25(org_kb_fts) AS rank
              FROM org_kb_fts
              JOIN org_kb_fts_map m ON m.fts_rowid = org_kb_fts.rowid
              JOIN org_kb_cache c ON c.chunk_id = m.chunk_id
             WHERE org_kb_fts MATCH ?
             ORDER BY rank
             LIMIT ?
        """
        try:
            rows = conn.execute(sql, (match, limit)).fetchall()
        except sqlite3.Error as e:
            if self._log:
                self._log.debug("org cache query failed: {}", e)
            return RetrieveResult(from_cache=True)
        finally:
            conn.close()

        chunks = [
            Chunk(
                chunk_id=str(r[0]),
                doc_id=str(r[1]),
                doc_title=str(r[2] or ""),
                text=str(r[3] or ""),
                scope_kind=str(r[7] or "org"),
                # bm25() returns negative values, lower is better; map to 0..1
                # only for display ordering — never compare against live scores.
                score=1.0 / (1.0 + abs(float(r[8] or 0.0))),
                citation=Citation(
                    page=r[5], heading=str(r[4] or ""), start_ms=r[6]
                ),
            )
            for r in rows
        ]
        return RetrieveResult(chunks=chunks, from_cache=True)
