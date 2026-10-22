import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { gzipSync } from "node:zlib";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { default: decompress } = require(process.env.THEIA_DECOMPRESS_MODULE
  || resolve("vendor/theia-platform/node_modules/decompress/index.js"));
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [path, value] of entries) {
    const name = Buffer.from(path);
    const body = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(0x314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function tar(entries) {
  const blocks = [];
  for (const { name, data = "", type = "0", link = "", mode = 0o644 } of entries) {
    const body = Buffer.from(data);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    for (const [offset, width, value] of [[100, 8, mode], [108, 8, 0], [116, 8, 0], [124, 12, body.length], [136, 12, 0]]) {
      header.write(value.toString(8).padStart(width - 1, "0") + "\0", offset, width);
    }
    header.fill(32, 148, 156);
    header.write(type, 156, 1);
    header.write(link, 157, 100);
    header.write("ustar\0", 257, 6);
    header.write("00", 263, 2);
    const checksum = header.reduce((sum, value) => sum + value, 0);
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
    blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

async function inDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "echo-archive-security-"));
  try { await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("VSIX metadata filtering, assets and nested archives remain readable", async () => {
  const archive = zip([
    ["extension/package.json", '{"name":"example","version":"1.0.0"}'],
    ["extension/中文.txt", "扩展内容"],
    ["extension/vscode_node_modules.zip", zip([["package/index.js", "module.exports = 42;"]])],
  ]);
  const metadata = await decompress(archive, { filter: file => file.path === "extension/package.json" });
  assert.equal(metadata.length, 1);
  assert.equal(JSON.parse(metadata[0].data).name, "example");
  await inDirectory(async directory => {
    await decompress(archive, directory);
    assert.equal(await readFile(join(directory, "extension/中文.txt"), "utf8"), "扩展内容");
    await decompress(join(directory, "extension/vscode_node_modules.zip"), join(directory, "modules"));
    assert.equal(await readFile(join(directory, "modules/package/index.js"), "utf8"), "module.exports = 42;");
  });
});

test("TAR and gzip plugin archives preserve files while dropping privileged mode bits", async () => {
  const archive = tar([{ name: "package/extension.js", data: "hello", mode: 0o6755 }]);
  for (const input of [archive, gzipSync(archive)]) {
    await inDirectory(async directory => {
      await decompress(input, directory);
      const file = join(directory, "package/extension.js");
      assert.equal(await readFile(file, "utf8"), "hello");
      assert.equal((await stat(file)).mode & 0o6000, 0);
    });
  }
});

test("archive entry traversal cannot write outside the extension directory", async () => {
  for (const input of [tar([{ name: "../escaped.txt", data: "escape" }]), zip([["../escaped.txt", "escape"]])]) {
    await inDirectory(async directory => {
      await assert.rejects(decompress(input, join(directory, "out")));
      await assert.rejects(stat(join(directory, "escaped.txt")), { code: "ENOENT" });
    });
  }
});

for (const [kind, type] of [["symbolic", "2"], ["hard", "1"]]) {
  test(`${kind} links cannot redirect extraction into a sibling prefix directory`, async () => {
    await inDirectory(async directory => {
      const input = tar([
        { name: "link", type, link: "../out-sibling/escaped.txt" },
        { name: "link/child.txt", data: "escape" },
      ]);
      await assert.rejects(decompress(input, join(directory, "out")));
      await assert.rejects(stat(join(directory, "out-sibling/escaped.txt")), { code: "ENOENT" });
    });
  });
}
