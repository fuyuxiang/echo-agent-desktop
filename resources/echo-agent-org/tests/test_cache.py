"""Offline cache: bigram-based CJK matching, and fail-soft on every error path."""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from echo_agent_org.cache import OrgCache, build_match, to_bigrams  # noqa: E402


def test_bigrams_split_cjk():
    assert to_bigrams("报销审批") == "报销 销审 审批"
    assert to_bigrams("差旅") == "差旅"
    assert to_bigrams("我") == "我"


def test_bigrams_keep_ascii_tokens():
    out = to_bigrams("XR2000 报销")
    assert out == "XR2000 报销"
    assert "报销" in out


def test_build_match_matches_desktop_contract():
    assert build_match('XR2000 报销审批') == '"xr2000" OR "报销" OR "销审" OR "审批"'
    assert build_match('"*():^-') == ""


def test_bigrams_empty():
    assert to_bigrams("") == ""
    assert to_bigrams("   ") == ""


def _build_cache(path: Path):
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        CREATE TABLE org_kb_cache (
          chunk_id TEXT PRIMARY KEY, doc_id TEXT, title TEXT, text TEXT,
          heading TEXT, loc_page INTEGER, loc_start_ms INTEGER,
          scope_kind TEXT, updated_at INTEGER
        );
        CREATE VIRTUAL TABLE org_kb_fts USING fts5(
          body, content=''
        );
        CREATE TABLE org_kb_fts_map (
          chunk_id TEXT PRIMARY KEY, fts_rowid INTEGER NOT NULL
        );
        """
    )
    conn.execute(
        "INSERT INTO org_kb_cache VALUES (?,?,?,?,?,?,?,?,?)",
        ("c1", "d1", "差旅管理办法", "一线城市住宿标准 500 元", "4.2 住宿", 7,
         None, "org", 0),
    )
    # Desktop writes raw text plus its bigram form so CJK terms are matchable.
    text = conn.execute("SELECT text FROM org_kb_cache WHERE chunk_id = 'c1'").fetchone()[0]
    info = conn.execute(
        "INSERT INTO org_kb_fts(body) VALUES (?)", (text + " " + to_bigrams(text),)
    )
    conn.execute(
        "INSERT INTO org_kb_fts_map(chunk_id, fts_rowid) VALUES (?,?)",
        ("c1", info.lastrowid),
    )
    conn.commit()
    conn.close()


def test_cache_hit(tmp_path):
    db = tmp_path / "cache.db"
    _build_cache(db)
    res = OrgCache({"cache_path": str(db)}).search("住宿标准")
    assert res.from_cache is True
    assert len(res.chunks) == 1
    assert "500" in res.chunks[0].text
    assert res.chunks[0].citation.page == 7


def test_missing_file_returns_empty_not_raise(tmp_path):
    res = OrgCache({"cache_path": str(tmp_path / "nope.db")}).search("住宿")
    assert res.chunks == []
    assert res.from_cache is True


def test_corrupt_file_returns_empty_not_raise(tmp_path):
    db = tmp_path / "bad.db"
    db.write_bytes(b"this is not sqlite")
    res = OrgCache({"cache_path": str(db)}).search("住宿")
    assert res.chunks == []


def test_missing_tables_returns_empty_not_raise(tmp_path):
    db = tmp_path / "empty.db"
    sqlite3.connect(db).close()
    res = OrgCache({"cache_path": str(db)}).search("住宿")
    assert res.chunks == []


def test_blank_query_returns_empty(tmp_path):
    db = tmp_path / "cache.db"
    _build_cache(db)
    assert OrgCache({"cache_path": str(db)}).search("   ").chunks == []
