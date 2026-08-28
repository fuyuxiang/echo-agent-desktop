# Third-Party Notices

EchoAgent application code is licensed under the MIT License. The application
also embeds and distributes third-party components under their respective
licenses.

## xai-org/grok-build

- Source: https://github.com/xai-org/grok-build
- Pinned revision: `c2ad97f8`
- License: Apache License 2.0
- Copyright: Copyright 2023-2026 SpaceXAI
- Local license copy: `vendor/grok-build/LICENSE`
- Upstream notices: `vendor/grok-build/third_party/NOTICE`

EchoAgent consumes selected Rust crates from this repository as in-process path
dependencies. The pinned source may carry EchoAgent build-compatibility patches
from `patches/grok-build/`; those changes are not endorsed by the upstream
project.

The names “Grok”, “xAI”, and related upstream crate and model identifiers remain
the property of their respective owners. EchoAgent is an independent project
and is not affiliated with, endorsed by, or sponsored by xAI.

Additional dependency notices remain available in the embedded upstream source
tree and its crate-specific license files.
