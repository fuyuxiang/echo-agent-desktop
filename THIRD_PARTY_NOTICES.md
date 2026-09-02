# Third-Party Notices

EchoAgent application code is licensed under the MIT License. The application
also embeds and distributes third-party components under their respective
licenses.

## xai-org/grok-build

- Source: https://github.com/xai-org/grok-build
- Pinned revision: `c2ad97f8`
- Integration: source snapshot tracked directly under `vendor/grok-build/`
- License: Apache License 2.0
- Copyright: Copyright 2023-2026 SpaceXAI
- Local license copy: `vendor/grok-build/LICENSE`
- Upstream notices: `vendor/grok-build/third_party/NOTICE`

EchoAgent consumes selected Rust crates from this source snapshot as in-process
path dependencies. The vendored files directly include EchoAgent compatibility
changes and the `echo.agent` protocol namespace migration. Modified files are
maintained by EchoAgent and are not endorsed by the upstream project. Upstream
copyright, license, and NOTICE material remain intact.

The names “Grok”, “xAI”, and related upstream crate and model identifiers remain
the property of their respective owners. EchoAgent is an independent project
and is not affiliated with, endorsed by, or sponsored by xAI.

Additional dependency notices remain available in the embedded upstream source
tree and its crate-specific license files.

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
