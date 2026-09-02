# EchoAgent Vendored Runtime

This directory is a source snapshot tracked directly by the
`echo-agent-desktop` repository. It is not a Git submodule.

- Upstream: <https://github.com/xai-org/grok-build.git>
- Upstream revision: `c2ad97f87aea4303b6000a2c22128bc91ee76c9b`
- Upstream license: Apache License 2.0
- Imported: 2026-09-01

The checked-in snapshot directly includes EchoAgent compatibility changes and
the protocol namespace migration performed by
`scripts/rename-runtime-namespace.*`. Modified files are maintained as part of
EchoAgent and are not endorsed by the upstream project.

When importing a newer upstream revision, use a temporary checkout, compare it
with the maintained source and integrate required compatibility changes there,
run the namespace migration, then replace only the tracked source snapshot
(never `target/` or nested Git metadata). Update `ECHOAGENT_VENDOR.json`, this
file, `THIRD_PARTY_NOTICES.md`, and the changelog, then run the complete frontend
and Rust test suites before committing.
