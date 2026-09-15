# Skill executable capability contract

EchoAgent continues to support portable `SKILL.md` prompt packages. A package
can additionally include `echo.skill.json` when it provides deterministic code,
depends on host commands or authenticated connectors, or produces files that
must be verified before the Agent reports success.

The manifest is deliberately declarative. It never grants permission and never
executes code itself. Skill entrypoints are run with the normal Bash tool, so
the active workspace sandbox and user approval policy remain authoritative.
Connector credentials remain inside the connector implementation and are never
copied into a Skill package, prompt, or script environment.

## Schema version 1

```json
{
  "schemaVersion": 1,
  "capabilities": [
    "document.docx.create",
    "document.docx.edit"
  ],
  "runtime": {
    "kind": "python",
    "command": "python3",
    "entrypoints": {
      "create": "scripts/create.py",
      "edit": "scripts/edit.py"
    },
    "timeoutSeconds": 120
  },
  "requirements": {
    "commands": ["libreoffice"],
    "connectors": [
      {
        "id": "microsoft-365",
        "label": "Microsoft 365",
        "accountRequired": true,
        "purpose": "Read a source document from OneDrive"
      }
    ],
    "osPermissions": []
  },
  "permissions": {
    "filesystem": "workspace-write",
    "network": ["https://graph.microsoft.com"],
    "externalActions": []
  },
  "artifacts": [
    {
      "id": "document",
      "pattern": "output/*.docx",
      "mimeType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "required": true,
      "maxBytes": 52428800
    }
  ]
}
```

`runtime.kind` accepts `python`, `node`, or `shell`. `command` is optional and
defaults to `python3`, `node`, or the platform shell. It must be a command name,
not an absolute path. Every entrypoint must be a regular file inside the package.

`requirements.commands` lists additional host commands. Connector IDs must
match an EchoAgent MCP connector name. Set `accountRequired` when the connector
needs OAuth, an API token, or another account credential. This lets the product
distinguish “connector missing” from “account not connected” without exposing a
secret to the model.

`permissions.filesystem` accepts `none`, `workspace-read`, or
`workspace-write`. These are requested capabilities for preflight and review,
not grants; the active sandbox may be stricter. Network entries are exact HTTPS origins; paths, wildcards,
embedded credentials, query strings, and fragments are rejected. Consequential
effects such as `email.send` or `notion.page.publish` belong in
`externalActions` and still require the normal tool approval flow.

Artifact patterns are workspace-relative and may contain glob characters, but
cannot be absolute or traverse a parent directory. A required artifact must
exist, be non-empty, and satisfy its declared MIME/size constraints before the
Agent can claim successful completion.

## Installation and readiness behavior

- Packages without `echo.skill.json` remain compatible and are labeled
  “prompt/workflow only”.
- Invalid manifests block managed installation and direct path registration.
- Missing commands do not block installation; the Skill is labeled “missing
  dependencies” until the host is ready.
- Connector/account and operating-system permission requirements are shown
  before installation. Installation never requests or stores those credentials.
- Declared workspace writes, network access, and external side effects are
  included in the installation risk report.
- On invocation, the validated contract is appended to the Skill instructions,
  including entrypoints, security boundaries, and artifact acceptance rules.
