"""Credential access.

Identity does NOT come from the session. echo-agent-desktop hardcodes
`user_id: 'desktop-user'` in gateway-client.ts:sendAuth() and
adapters.ts:notifyMeeting(), so the session user_id is a placeholder, not the
enterprise identity. The authoritative identity is the JWT `sub` in the
credentials file, which desktop (or the CLI) writes after login.

Permissions are always enforced server-side against that JWT. Nothing here is
a security decision — this module only locates and reads the token.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from .errors import OrgUnauthorized


def credentials_path(cfg: dict | None = None) -> Path:
    """Resolve the credentials file. Config > env > default."""
    cfg = cfg or {}
    explicit = cfg.get("credentials_path") or os.environ.get("ECHO_ORG_CREDENTIALS")
    if explicit:
        return Path(explicit).expanduser()
    home = Path(os.environ.get("ECHO_AGENT_HOME", Path.home() / ".echo-agent"))
    return home / "plugins" / "org" / "credentials.json"


class Credentials:
    """Reads the credentials file, reloading when desktop rewrites it."""

    def __init__(self, cfg: dict | None = None):
        self._path = credentials_path(cfg)
        self._cache: dict = {}
        self._mtime: float = -1.0

    def _load(self) -> dict:
        try:
            stat = self._path.stat()
        except OSError:
            self._cache, self._mtime = {}, -1.0
            return self._cache

        if stat.st_mtime != self._mtime:
            try:
                self._cache = json.loads(self._path.read_text(encoding="utf-8"))
                self._mtime = stat.st_mtime
            except (OSError, json.JSONDecodeError):
                self._cache, self._mtime = {}, -1.0
        return self._cache

    @property
    def access_token(self) -> str:
        data = self._load()
        return str(data.get("access_token") or data.get("accessToken") or "")

    @property
    def user_id(self) -> str:
        """Enterprise user id — the only trustworthy identity for logging."""
        data = self._load()
        return str(data.get("user_id") or data.get("userId") or "")

    @property
    def logged_in(self) -> bool:
        return bool(self.access_token)

    def require_token(self) -> str:
        token = self.access_token
        if not token:
            raise OrgUnauthorized("no credentials; run login first")
        return token

    def auth_header(self) -> dict:
        return {"Authorization": f"Bearer {self.require_token()}"}
