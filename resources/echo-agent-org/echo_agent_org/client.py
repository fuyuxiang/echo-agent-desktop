"""HTTP client for the org server.

Timeouts are load-bearing: injection sits on the user's first-token path, so a
slow server must degrade to cache rather than stall the turn. Failures raise
(never return partial results) so the caller's degradation policy stays in one
place.
"""

from __future__ import annotations

from .auth import Credentials
from .errors import OrgUnauthorized, OrgUnavailable
from .types import Chunk, Citation, Memory, RetrieveResult

DEFAULT_CONNECT_MS = 3000
DEFAULT_READ_MS = 8000


class OrgClient:
    def __init__(self, cfg: dict, logger=None):
        self._cfg = cfg or {}
        self._log = logger
        self._base = (self._cfg.get("server_url") or "").rstrip("/")
        timeouts = self._cfg.get("timeouts") or {}
        self._connect_s = timeouts.get("connect_ms", DEFAULT_CONNECT_MS) / 1000
        self._read_s = timeouts.get("read_ms", DEFAULT_READ_MS) / 1000
        self._creds = Credentials(self._cfg)

    @property
    def credentials(self) -> Credentials:
        return self._creds

    async def _post(self, path: str, payload: dict) -> dict:
        """POST JSON. Raises OrgUnauthorized / OrgUnavailable, never returns partial."""
        try:
            import httpx
        except ImportError as e:  # pragma: no cover - dependency guard
            raise OrgUnavailable(f"httpx unavailable: {e}") from e

        headers = self._creds.auth_header()  # raises OrgUnauthorized if absent
        timeout = httpx.Timeout(self._read_s, connect=self._connect_s)

        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.post(
                    f"{self._base}{path}", json=payload, headers=headers
                )
        except Exception as e:
            raise OrgUnavailable(f"{type(e).__name__}: {e}") from e

        if resp.status_code in (401, 403):
            raise OrgUnauthorized(f"server rejected credentials ({resp.status_code})")
        if resp.status_code >= 500:
            raise OrgUnavailable(f"server error {resp.status_code}")
        if resp.status_code >= 400:
            raise OrgUnavailable(f"bad request {resp.status_code}: {resp.text[:200]}")

        try:
            body = resp.json()
        except ValueError as e:
            raise OrgUnavailable(f"malformed JSON response: {e}") from e

        if not body.get("ok", True):
            err = (body.get("error") or {}).get("message", "unknown")
            raise OrgUnavailable(f"server reported failure: {err}")
        return body.get("data", body)

    async def retrieve(self, query: str, *, limit: int = 8, **extra) -> RetrieveResult:
        payload = {"query": query, "limit": limit, **extra}
        data = await self._post("/api/v1/retrieve", payload)
        return _parse_retrieve(data)

    async def submit_knowledge(
        self, *, kind: str, content: str, rationale: str = "",
        evidence: list | None = None, target_scope: str = "",
    ) -> str:
        data = await self._post(
            "/api/v1/promotions",
            {
                "payloadType": "memory",
                "source": "qa",
                "targetScope": target_scope,
                "payload": {
                    "kind": kind,
                    "content": content,
                    "rationale": rationale,
                    "evidence": evidence or [],
                },
            },
        )
        return str(data.get("promotionId") or data.get("promotion_id") or "")

    async def who_knows(self, topic: str) -> list[dict]:
        data = await self._post("/api/v1/retrieve", {"query": topic, "limit": 5})
        return data.get("suggestAsk") or data.get("suggest_ask") or []


def _parse_retrieve(data: dict) -> RetrieveResult:
    """Map the wire format to typed results. Tolerates missing optional fields."""
    chunks = []
    for raw in data.get("chunks") or []:
        cit = raw.get("citation") or {}
        owner = raw.get("owner") or {}
        chunks.append(
            Chunk(
                chunk_id=str(raw.get("chunkId") or raw.get("chunk_id") or ""),
                doc_id=str(raw.get("docId") or raw.get("doc_id") or ""),
                doc_title=str(raw.get("docTitle") or raw.get("doc_title") or ""),
                text=str(raw.get("text", "")),
                score=float(raw.get("score", 0.0) or 0.0),
                scope_kind=str(raw.get("scopeKind") or raw.get("scope_kind") or "org"),
                modality=str(raw.get("modality", "text")),
                citation=Citation(
                    page=cit.get("page"),
                    heading=str(cit.get("heading") or ""),
                    start_ms=cit.get("startMs", cit.get("start_ms")),
                    end_ms=cit.get("endMs", cit.get("end_ms")),
                    open_url=str(cit.get("openUrl") or cit.get("open_url") or ""),
                ),
                owner_name=str(owner.get("displayName") or owner.get("display_name") or ""),
                stale=bool(raw.get("stale", False)),
                updated_at=int(raw.get("updatedAt") or raw.get("updated_at") or 0),
            )
        )

    memories = [
        Memory(
            id=str(m.get("id", "")),
            kind=str(m.get("kind", "fact")),
            content=str(m.get("content", "")),
            scope_kind=str(m.get("scopeKind") or m.get("scope_kind") or "org"),
            confidence=float(m.get("confidence", 0.8) or 0.8),
        )
        for m in (data.get("memories") or [])
    ]

    return RetrieveResult(
        chunks=chunks,
        memories=memories,
        diagnostics=data.get("diagnostics") or {},
    )
