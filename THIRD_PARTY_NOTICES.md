# Third-Party Notices

EchoAgent application code is licensed under the MIT License. The application
also embeds and distributes third-party components under their respective
licenses.

## EchoAgent Agent Runtime (`echo-agent`)

- Runtime name: `echo-agent`
- Rust entry crate: `echo-agent-runtime`
- Source: https://github.com/fuyuxiang/echo-agent
- Pinned revision: `c2ad97f8`
- Integration: source snapshot tracked directly under `vendor/echo-agent-build/`
- License: Apache License 2.0
- Copyright: Copyright 2023-2026 EchoAgent contributors
- Local license copy: `vendor/echo-agent-build/LICENSE`
- Bundled dependency notices: `vendor/echo-agent-build/third_party/NOTICE`

EchoAgent Desktop consumes selected Rust crates from this `echo-agent` source
snapshot as in-process path dependencies. The maintained snapshot uses
EchoAgent crate names, Rust module names, configuration keys, environment
variables, protocol identifiers, and user-facing terminology throughout.
Modified files are maintained by EchoAgent contributors. Copyright, license,
and NOTICE material remain intact.

Additional dependency notices remain available in the embedded runtime source
tree and its crate-specific license files.

## OpenAI Codex Runtime (`@openai/codex`)

- Source: https://github.com/openai/codex
- Version: `0.153.4`
- Integration: platform-specific native sidecar staged from the official npm package
- License: Apache License 2.0
- Copyright: Copyright OpenAI
- Bundled Apache 2.0 license text: `licenses/echo-agent-build-LICENSE`

The Codex Runtime is used only for the optional ChatGPT account connection. It
owns the browser sign-in flow, token persistence and Codex App Server protocol;
EchoAgent Desktop does not read or copy its authentication tokens.

## async-openai

- Source: https://github.com/our-forks/async-openai
- Pinned revision: `95b52ebdedf42143083cf3d6f0e0be7c84e9c808`
- Integration: build-dependency source under `vendor/async-openai/`
- License: MIT
- Copyright: Copyright 2022 Himanshu Neema
- Local license copy: `vendor/async-openai/LICENSE`

The vendored source contains the `async-openai` and `async-openai-macros`
crates used by the embedded Runtime. Non-build example assets and generated API
reference input are intentionally excluded.

## nucleo

- Source: https://github.com/helix-editor/nucleo
- Pinned revision: `5b74652e482f7c07d827f18c6d21e7540c242c69`
- Integration: build-dependency source under `vendor/nucleo/`
- License: Mozilla Public License 2.0
- Local license copy: `vendor/nucleo/LICENSE`

The vendored source contains the `nucleo` and `nucleo-matcher` crates used by
the embedded Runtime. The upstream license and source form are retained.
