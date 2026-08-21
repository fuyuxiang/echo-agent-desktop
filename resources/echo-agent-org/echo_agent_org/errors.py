"""Failure modes the plugin must distinguish.

The split matters for degradation policy: an unreachable server may fall back
to the local cache, but invalid credentials must NOT — reading cache after a
permission revocation would serve content the server just took away.
"""

from __future__ import annotations


class OrgError(Exception):
    """Base for all org plugin errors."""


class OrgUnavailable(OrgError):
    """Server unreachable, timed out, or returned 5xx. Cache fallback allowed."""


class OrgUnauthorized(OrgError):
    """Token missing, expired, or rejected. Cache fallback FORBIDDEN."""


class OrgConfigError(OrgError):
    """Malformed plugin config. Surfaces at activate(), never mid-conversation."""
