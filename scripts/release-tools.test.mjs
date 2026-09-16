import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { checkVersions, setVersion, validateVersion } from "./release-version.mjs";
import { verifySignatureMetadata } from "./verify-updater-signature.mjs";

const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "echoagent-release-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("release version synchronization", () => {
  it("updates and checks every version source", () => {
    const root = temporaryDirectory();
    fs.mkdirSync(path.join(root, "src-tauri"));
    fs.writeFileSync(path.join(root, "package.json"), '{\n  "version": "0.1.0"\n}\n');
    fs.writeFileSync(
      path.join(root, "src-tauri", "tauri.conf.json"),
      '{\n  "version": "0.1.0"\n}\n',
    );
    fs.writeFileSync(
      path.join(root, "src-tauri", "Cargo.toml"),
      '[package]\nname = "echoagent"\nversion = "0.1.0"\n\n[dependencies]\n',
    );
    fs.writeFileSync(
      path.join(root, "src-tauri", "Cargo.lock"),
      'version = 4\n\n[[package]]\nname = "echoagent"\nversion = "0.1.0"\n',
    );

    expect(setVersion("1.2.3-rc.1+build.7", root)).toBe("1.2.3-rc.1+build.7");
    expect(checkVersions(undefined, root)).toBe("1.2.3-rc.1+build.7");
    expect(setVersion("1.2.3-rc.1+build.7", root)).toBe("1.2.3-rc.1+build.7");
  });

  it("rejects invalid SemVer", () => {
    expect(() => validateVersion("01.2.3")).toThrow(/SemVer/);
  });
});

describe("updater signature metadata", () => {
  it("verifies key ID, file bytes and the trusted comment", () => {
    const root = temporaryDirectory();
    const artifact = path.join(root, "EchoAgent-v1.2.3-windows-x86_64-setup.exe");
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const rawPublicKey = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    const keyId = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const publicPacket = Buffer.concat([Buffer.from("Ed"), keyId, rawPublicKey]);
    fs.mkdirSync(path.join(root, "src-tauri"));
    fs.writeFileSync(artifact, "installer");
    fs.writeFileSync(
      path.join(root, "src-tauri", "tauri.conf.json"),
      JSON.stringify({
        plugins: {
          updater: {
            pubkey: Buffer.from(
              `untrusted comment: test\n${publicPacket.toString("base64")}\n`,
            ).toString("base64"),
          },
        },
      }),
    );
    const digest = crypto.createHash("blake2b512").update("installer").digest();
    const fileSignature = crypto.sign(null, digest, privateKey);
    const signaturePacket = Buffer.concat([Buffer.from("ED"), keyId, fileSignature]);
    const trustedComment = `timestamp:1\tfile:${path.basename(artifact)}`;
    const globalSignature = crypto.sign(
      null,
      Buffer.concat([fileSignature, Buffer.from(trustedComment)]),
      privateKey,
    );
    const signatureLines = [
      "untrusted comment: test",
      signaturePacket.toString("base64"),
      `trusted comment: ${trustedComment}`,
      globalSignature.toString("base64"),
    ];
    fs.writeFileSync(`${artifact}.sig`, Buffer.from(signatureLines.join("\n")).toString("base64"));

    expect(verifySignatureMetadata(artifact, undefined, root)).toBe("0102030405060708");

    fs.appendFileSync(artifact, "tampered");
    expect(() => verifySignatureMetadata(artifact, undefined, root)).toThrow(/文件内容/);

    fs.writeFileSync(artifact, "installer");
    const wrongKeyPacket = Buffer.from(signaturePacket);
    wrongKeyPacket[2] ^= 0xff;
    signatureLines[1] = wrongKeyPacket.toString("base64");
    fs.writeFileSync(`${artifact}.sig`, Buffer.from(signatureLines.join("\n")).toString("base64"));
    expect(() => verifySignatureMetadata(artifact, undefined, root)).toThrow(/密钥 ID/);
  });
});
