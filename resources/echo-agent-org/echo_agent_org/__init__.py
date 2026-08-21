"""echo-agent-org — 企业组织知识库插件.

Installed alongside echo-agent, discovered via the `echo_agent.plugins`
entry-points group. Not installed = zero effect on echo-agent's behaviour.
"""

from __future__ import annotations

__version__ = "1.0.0"

from .errors import OrgConfigError, OrgError, OrgUnauthorized, OrgUnavailable
from .types import Chunk, Citation, Memory, RetrieveResult

__all__ = [
    "__version__",
    "OrgError",
    "OrgUnavailable",
    "OrgUnauthorized",
    "OrgConfigError",
    "Chunk",
    "Citation",
    "Memory",
    "RetrieveResult",
]
