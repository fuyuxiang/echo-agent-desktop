#!/usr/bin/env python3
"""Real loopback WebDAV acceptance resources; never a fake IPC/server fixture.

Install WsgiDAV and Cheroot in an isolated Python environment, then run this
script. Without --rust-test-binary, only the standard server resource preflight
is verified. With it, the exact ignored production Rust command test runs in a
fresh ECHO_AGENT_HOME. Credentials are synthetic and remain in a private temp
manifest; output/evidence never contains them. No OS transfer dialog is bypassed.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import secrets
import signal
import subprocess
import tempfile
import threading
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import ProxyHandler, Request, build_opener

from cheroot import wsgi
from wsgidav.wsgidav_app import WsgiDAVApp


SEED_NAME = "原始 中文.txt"
SEED_CONTENT = "标准 WebDAV 原始合成资料\n只用于本次隔离验收，必须保留。\n"
TEST_NAME = "storage::tests::webdav_standard_server_real_commands"
PROPFIND = b'<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:allprop/></d:propfind>'


def private_json(path: Path, value: dict) -> None:
    with path.open("x", encoding="utf-8") as stream:
        os.chmod(path, 0o600)
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")


def save_evidence(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(4)}.part")
    private_json(temporary, value)
    temporary.replace(path)


def make_server(root: Path, username: str, password: str, *, shared_readonly=False, audit_path=None):
    # This is the upstream FilesystemProvider + HTTPAuthenticator + Cheroot,
    # without a custom request handler or synthesized WebDAV responses.
    app = WsgiDAVApp({
        "provider_mapping": {
            "/rw": {"root": str(root / "rw"), "readonly": False},
            "/ro": {"root": str(root / ("rw" if shared_readonly else "ro")), "readonly": True},
        },
        "http_authenticator": {
            "accept_basic": True,
            "accept_digest": False,
            "default_to_digest": False,
        },
        "simple_dc": {"user_mapping": {"*": {username: {"password": password}}}},
        "dir_browser": {"enable": False},
        "verbose": 0,
        "logging": {"enable": False},
    })
    if audit_path is not None:
        # Observation only: all requests and responses still go through the
        # upstream WsgiDAV application. Never inspect credentials or bodies,
        # synthesize responses, inject failures, or change status/headers.
        audit_lock = threading.Lock()
        upstream = app

        def audited_app(environ, start_response):
            def observe_response(status, headers, exc_info=None):
                result = start_response(status, headers, exc_info)
                # WsgiDAV decodes UTF-8 then moves the share prefix into
                # SCRIPT_NAME. Preserve the real complete route for auditing.
                entry = {"method": environ.get("REQUEST_METHOD"),
                         "path": environ.get("SCRIPT_NAME", "") + environ.get("PATH_INFO", ""),
                         "status": int(status.split(" ", 1)[0]),
                         "contentLength": environ.get("CONTENT_LENGTH", "")}
                with audit_lock, audit_path.open("a", encoding="utf-8") as stream:
                    stream.write(json.dumps(entry, ensure_ascii=False) + "\n")
                return result
            return upstream(environ, observe_response)

        app = audited_app
    server = wsgi.Server(("127.0.0.1", 0), app, numthreads=4)
    server.prepare()
    thread = threading.Thread(target=server.serve, name="standard-webdav-review", daemon=True)
    thread.start()
    return server, thread, server.socket.getsockname()[1]


def call(url: str, method: str, username: str, password: str, body=None, headers=None):
    # Disabling proxies here is only for this resource preflight. The production
    # process receives NO_PROXY for loopback, retaining its real reqwest client.
    authorization = base64.b64encode(f"{username}:{password}".encode()).decode()
    request = Request(url, data=body, method=method, headers={
        "Authorization": f"Basic {authorization}",
        **(headers or {}),
    })
    try:
        with build_opener(ProxyHandler({})).open(request, timeout=10) as response:
            return response.status, response.read()
    except HTTPError as error:
        return error.code, error.read()


def preflight(base: str, root: Path, username: str, password: str):
    checks = []

    def check(name: str, condition: bool, **evidence):
        checks.append({"id": name, "passed": bool(condition), **evidence})
        if not condition:
            raise RuntimeError(f"Standard WebDAV resource check failed: {name}")

    status, xml = call(base + "/rw/", "PROPFIND", username, password, PROPFIND, {"Depth": "1"})
    check("standard-propfind", status == 207 and b"multistatus" in xml, status=status)
    escaped = quote(SEED_NAME, safe="")
    status, data = call(base + "/rw/" + escaped, "GET", username, password)
    check("standard-chinese-spaced-get", status == 200 and data == SEED_CONTENT.encode(),
          status=status, size=len(data), sha256=hashlib.sha256(data).hexdigest())
    status, _ = call(base + "/rw/", "PROPFIND", username, "deliberately-wrong", PROPFIND, {"Depth": "0"})
    check("standard-bad-credential-401", status == 401, status=status)
    status, _ = call(base + "/ro/" + escaped, "PUT", username, password, b"must-not-be-saved")
    check("standard-readonly-put-denied", status == 403 and (root / "ro" / SEED_NAME).read_text(encoding="utf-8") == SEED_CONTENT,
          status=status)
    scratch = "资源探针 临时目录"
    scratch_url = base + "/rw/" + quote(scratch, safe="")
    status, _ = call(scratch_url, "MKCOL", username, password)
    check("standard-mkcol", status == 201 and (root / "rw" / scratch).is_dir(), status=status)
    content = "资源准备传输测试：中文 空格\n".encode()
    scratch_file = scratch_url + "/" + quote("合成 文档.txt", safe="")
    status, _ = call(scratch_file, "PUT", username, password, content)
    physical = root / "rw" / scratch / "合成 文档.txt"
    check("standard-put-physical-bytes", status == 201 and physical.read_bytes() == content,
          status=status, size=len(content), sha256=hashlib.sha256(content).hexdigest())
    status, result = call(scratch_file, "GET", username, password)
    check("standard-put-get-roundtrip", status == 200 and result == content, status=status)
    status, _ = call(scratch_url, "DELETE", username, password)
    check("standard-delete-own-scratch-only", status == 204 and not physical.exists(), status=status)
    check("standard-original-files-preserved",
          all((root / share / SEED_NAME).read_text(encoding="utf-8") == SEED_CONTENT for share in ["rw", "ro"]))
    return checks


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="Redacted JSON evidence output")
    parser.add_argument("--rust-test-binary", type=Path, help="Already-built real echoagent_lib test binary; no Cargo is launched")
    parser.add_argument("--serve", action="store_true", help="Keep the real standard service alive for native UI acceptance until SIGTERM")
    parser.add_argument("--home", type=Path, help="Fresh private temporary echo-native-review-* home, required for --serve")
    parser.add_argument("--manifest", type=Path, help="Private scope file inside --home, required for --serve")
    args = parser.parse_args()
    output = args.output.resolve()
    run = Path(tempfile.mkdtemp(prefix="echo-webdav-real-", dir="/private/tmp")).resolve()
    root = run / "physical-root"
    home = run / "echo-home"
    if args.serve:
        if args.rust_test_binary or args.home is None or args.manifest is None:
            parser.error("--serve requires --home and --manifest and cannot run a Rust test binary")
        supplied_home = args.home
        home = supplied_home.resolve(strict=True)
        if supplied_home.is_symlink() or not home.is_dir() or home != supplied_home.absolute() or not home.name.startswith("echo-native-review-"):
            parser.error("Native home must be an ordinary canonical echo-native-review-* directory")
        if not str(home).startswith(("/private/tmp/", "/private/var/folders/")) or home.stat().st_mode & 0o077:
            parser.error("Native home must be a private temporary directory")
        if args.manifest.absolute().parent != home or args.manifest.exists():
            parser.error("Manifest must be a new private file directly inside the isolated home")
    else:
        if args.home is not None or args.manifest is not None:
            parser.error("--home/--manifest are only supported with --serve")
        home.mkdir(mode=0o700)
    root.mkdir(mode=0o700)
    for share in ["rw", "ro"]:
        (root / share).mkdir(mode=0o700)
        (root / share / SEED_NAME).write_text(SEED_CONTENT, encoding="utf-8")
    username, password = "isolated-review", secrets.token_urlsafe(24)
    evidence = {
        "layer": "standard-server-resource-preflight",
        "passed": False,
        "server": "upstream WsgiDAV FilesystemProvider / Cheroot",
        "versions": {name: importlib.metadata.version(name) for name in ["wsgidav", "cheroot"]},
        "runDirectory": str(run),
        "scope": "Synthetic temporary files only; OS dialogs and native CloudStorage UI are not verified",
    }
    server, thread = None, None
    try:
        audit_path = run / "requests.redacted.jsonl" if args.serve else None
        if audit_path is not None:
            audit_path.touch(mode=0o600)
        server, thread, port = make_server(root, username, password, shared_readonly=args.serve, audit_path=audit_path)
        base = f"http://127.0.0.1:{port}"
        evidence["endpoints"] = {"readWrite": base + "/rw", "readOnly": base + "/ro"}
        evidence["resourceChecks"] = preflight(base, root, username, password)
        manifest = args.manifest.absolute() if args.serve else run / "manifest.private.json"
        private_json(manifest, {
            "schema": 1, "home": str(home), "root": str(root),
            "readWriteUrl": base + "/rw", "readOnlyUrl": base + "/ro",
            "username": username, "password": password,
            "seedName": SEED_NAME, "seedContent": SEED_CONTENT,
            **({"nonce": secrets.token_hex(16), "readOnlySharesPhysicalRoot": True,
                "requestAudit": str(audit_path)} if args.serve else {}),
        })
        if args.serve:
            evidence["passed"] = True
            evidence["live"] = True
            evidence["readOnlySharesPhysicalRoot"] = True
            evidence["manifestPath"] = str(manifest)
            evidence["requestAudit"] = str(audit_path)
            save_evidence(output, evidence)
            print(json.dumps({"ready": True, "output": str(output), "home": str(home),
                              "resourceChecks": len(evidence["resourceChecks"])}), flush=True)
            signal.signal(signal.SIGTERM, lambda _signal, _frame: server.stop())
            signal.signal(signal.SIGINT, lambda _signal, _frame: server.stop())
            thread.join()
        if args.rust_test_binary:
            binary = args.rust_test_binary.resolve(strict=True)
            if args.rust_test_binary.is_symlink() or not binary.is_file() or not os.access(binary, os.X_OK):
                raise RuntimeError("Rust test binary must be an existing ordinary executable")
            evidence["layer"] = "real-production-rust-commands-and-standard-webdav"
            evidence["rustTests"] = []
            evidence["rustChecks"] = []
            for phase in ["first", "restart"]:
                rust_output = output.with_name(output.stem + f"-{phase}-rust.json")
                log = output.with_name(output.stem + f"-{phase}-rust.log")
                clean_env = {k: v for k, v in os.environ.items() if not k.startswith(("ECHO_AGENT_", "GROK_", "OTEL_", "CLAUDE_", "CURSOR_", "OPENAI_", "ANTHROPIC_"))}
                env = {**clean_env, "ECHO_AGENT_REVIEW_ISOLATED": "1", "ECHO_AGENT_TELEMETRY_ENABLED": "false", "ECHO_AGENT_TELEMETRY_TRACE_UPLOAD": "false", "ECHO_AGENT_HOME": str(home),
                       "ECHO_WEBDAV_REVIEW_MANIFEST": str(manifest),
                       "ECHO_WEBDAV_REVIEW_OUTPUT": str(rust_output),
                       "ECHO_WEBDAV_REVIEW_PHASE": phase,
                       "NO_PROXY": "127.0.0.1,localhost,::1", "no_proxy": "127.0.0.1,localhost,::1"}
                with log.open("w", encoding="utf-8") as stream:
                    result = subprocess.run([str(binary), TEST_NAME, "--exact", "--ignored", "--nocapture", "--test-threads=1"],
                                            env=env, stdout=stream, stderr=subprocess.STDOUT, timeout=90, check=False)
                evidence["rustTests"].append({"name": TEST_NAME, "phase": phase, "binary": str(binary),
                                             "exitCode": result.returncode, "log": str(log), "evidence": str(rust_output)})
                if result.returncode != 0 or not rust_output.is_file():
                    raise RuntimeError("Real production storage command test failed; see redacted Rust log")
                rust_evidence = json.loads(rust_output.read_text())
                if rust_evidence.get("passed") is not True or not rust_evidence.get("checks") or rust_evidence.get("phase") != phase:
                    raise RuntimeError("Real Rust evidence is missing successful checks")
                evidence["rustChecks"].extend(rust_evidence["checks"])
        evidence["passed"] = True
    except Exception as error:
        # Do not copy HTTP bodies, Authorization headers, config, or credential
        # material into errors. Exception types plus known stage are sufficient.
        evidence["error"] = {"type": type(error).__name__, "stage": evidence["layer"]}
    finally:
        if server is not None:
            server.stop()
        if thread is not None:
            thread.join(timeout=5)
        evidence["serverStopped"] = thread is None or not thread.is_alive()
        save_evidence(output, evidence)
    print(json.dumps({"passed": evidence["passed"], "layer": evidence["layer"], "output": str(output),
                      "resourceChecks": len(evidence.get("resourceChecks", [])),
                      "rustChecks": len(evidence.get("rustChecks", [])), "serverStopped": evidence["serverStopped"]}))
    return 0 if evidence["passed"] and evidence["serverStopped"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
