"""Plugin entry point. echo-agent's loader discovers this MODULE (not a
function) via the `echo_agent.plugins` entry-points group.

Contracts verified against echo-agent source before writing this file:

- loader.py:83-111  entry-point target must be a module with `activate` (or a
                    dict with an 'activate' key). Manifest comes from a
                    module-level MANIFEST dict.
- manager.py:181-188  the entry function is named `activate(ctx)`; sync or
                    async both work.
- manager.py:141-143  plugin_config is read from
                    `config.plugins.config[<config_key or name>]`.
- sandbox.py        `hook.register` / `tool.register` are enforced at
                    registration time. Under permission_mode=strict a plugin
                    that declares no permissions gets an EMPTY set, so these
                    must be declared or the plugin silently does nothing.
- hooks.py:104      dispatch_modify reads ONLY `.modified` off the return
                    value. Returning a bare list raises AttributeError, which
                    hooks.py:109 swallows into a warning — the injection then
                    silently does nothing. Return HookResult or None.
"""

from __future__ import annotations

MANIFEST = {
    "name": "org",
    "version": "1.0.0",
    "description": "企业组织知识库接入：问答默认基于组织文档",
    "author": "Echo",
    "config_key": "org",
    "kind": "integration",
    # Must be declared explicitly: strict mode grants an empty permission set
    # to plugins that declare nothing, which would block both registrations.
    "permissions": ["hook.register", "tool.register", "network"],
    "provides": {
        "hooks": ["pre_llm_call"],
        "tools": [
            "org_search",
            "org_fetch_doc",
            "org_who_knows",
            "org_submit_knowledge",
        ],
    },
}

DEFAULT_TOKEN_BUDGET = 6000


def activate(ctx) -> None:
    """Wire up hook + tools. Called once at agent start."""
    cfg = ctx.plugin_config or {}

    if not cfg.get("enabled"):
        ctx.log.debug("org plugin present but disabled; nothing mounted")
        return

    server_url = (cfg.get("server_url") or "").strip()
    if not server_url:
        ctx.log.warning("org plugin enabled but server_url missing; not mounting")
        return

    # Imported lazily so a missing httpx cannot break agent startup for a user
    # who merely has the package installed but disabled.
    from .cache import OrgCache
    from .client import OrgClient
    from .errors import OrgUnauthorized, OrgUnavailable
    from .grounding import insert_materials, render
    from .router import PlanKind, classify, last_user_text

    client = OrgClient(cfg, logger=ctx.log)
    cache = OrgCache(cfg, logger=ctx.log)
    budget = int(cfg.get("material_token_budget", DEFAULT_TOKEN_BUDGET))
    inject_mode = cfg.get("inject_mode", "auto")

    async def inject(messages, tool_defs, model, **_kw):
        """pre_llm_call hook.

        Return None to pass through unchanged; return HookResult(modified=...)
        to rewrite. Returning a bare list would be silently dropped.
        """
        from echo_agent.plugins.hooks import HookResult

        try:
            query = last_user_text(messages)
            if not query:
                return None

            plan = classify(query, cfg)
            if plan.kind is PlanKind.NO_RETRIEVAL:
                ctx.log.debug("org: skip retrieval ({})", plan.reason)
                return None
            if plan.kind is PlanKind.AGENTIC:
                # Let the model drive multi-hop retrieval via org_search.
                ctx.log.debug("org: defer to tools ({})", plan.reason)
                return None

            try:
                result = await client.retrieve(query, limit=8)
            except OrgUnauthorized:
                # No cache fallback: serving cached content after a permission
                # revocation would hand back what the server just withdrew.
                ctx.log.warning("org: credentials invalid; skipping injection")
                return None
            except OrgUnavailable as e:
                ctx.log.debug("org: server unreachable ({}); using local cache", e)
                result = cache.search(query, limit=8)

            if result.empty:
                return None

            material = render(result, budget=budget)
            if not material:
                return None

            return HookResult(modified=insert_materials(messages, material))

        except Exception as e:  # plugin self-guard; never break the turn
            ctx.log.warning("org: injection failed ({}: {})", type(e).__name__, e)
            return None

    if inject_mode == "auto":
        ctx.register_hook("pre_llm_call", inject)
        ctx.log.info("org plugin: auto-injection enabled ({})", server_url)
    elif inject_mode == "off":
        ctx.log.info("org plugin: injection off, tools only")

    from .tools import build_tools

    ctx.register_tools(build_tools(client, budget=budget))


def deactivate(ctx) -> None:
    """Core unregisters hooks/tools by plugin name; nothing else to release."""
    ctx.log.debug("org plugin deactivated")
