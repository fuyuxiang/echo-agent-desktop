import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, request } from "node:http";
import { createRequire } from "node:module";
import { deflateSync, gzipSync } from "node:zlib";

// A separate process exposes uncaught decoder errors. Never intercept them here.
// All traffic uses a disposable loopback server; no application/user data is read.
const bodyParser = createRequire(import.meta.url)(process.argv[2]);
const parser = bodyParser.json();
const finishRequests = new Map();
const server = createServer((incoming, response) => {
  // Wait for the entire HTTP body, including bytes received after parsing.
  const finish = finishRequests.get(incoming.url);
  const ended = finish || incoming.url === "/trailing-gzip" ? new Promise((resolve, reject) => {
    incoming.once("end", resolve);
    incoming.once("error", reject);
  }) : Promise.resolve();
  const hash = incoming.url === "/late-deflate-with-consumer" ? createHash("sha256") : null;
  const hashed = hash ? new Promise((resolve, reject) => {
    hash.once("finish", () => resolve(hash.digest("hex")));
    hash.once("error", reject);
    incoming.pipe(hash);
  }) : Promise.resolve(null);
  parser(incoming, response, error => {
    // Release the late HTTP tail only after the parser has returned a body.
    finish?.();
    void Promise.all([ended, hashed]).then(([, digest]) => {
      response.statusCode = error ? 400 : 200;
      if (digest) response.setHeader("x-body-sha256", digest);
      response.end(error ? "rejected" : JSON.stringify(incoming.body));
    }).catch(error => response.destroy(error));
  });
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
async function send(body, { encoding, path = "/", trailer } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      host: "127.0.0.1", port: server.address().port, method: "POST", path,
      headers: { "content-type": "application/json", "content-length": body.length + (trailer?.length ?? 0),
        ...(encoding ? { "content-encoding": encoding } : {}) },
    }, response => {
      let content = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { content += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, content, digest: response.headers["x-body-sha256"] }));
      response.on("error", reject);
    });
    outgoing.on("error", reject);
    outgoing.setTimeout(5000, () => outgoing.destroy(new Error(`request timed out: ${path}`)));
    if (trailer) {
      finishRequests.set(path, () => outgoing.end(trailer));
      outgoing.write(body);
    } else outgoing.end(body);
  }).finally(() => finishRequests.delete(path));
}
try {
  const json = Buffer.from('{"value":"正常输入"}');
  const normal = { status: 200, content: json.toString(), digest: undefined };
  assert.deepEqual(await send(json), normal);
  assert.deepEqual(await send(gzipSync(json), { encoding: "gzip" }), normal);
  assert.equal((await send(Buffer.from("invalid gzip"), { encoding: "gzip" })).status, 400);
  assert.deepEqual(await send(json), normal);

  // Use a complete frame, NUL and a large tail to reach the decoder after
  // raw-body removes its error listener. A short malformed suffix misses this.
  // Trigger shapes: https://github.com/expressjs/body-parser/blob/1.20.9/test/json.js
  const trailingGzip = Buffer.concat([gzipSync(json), Buffer.from([0]), Buffer.alloc(100 * 1024, 0x58)]);
  assert.deepEqual(await send(trailingGzip, { encoding: "gzip", path: "/trailing-gzip" }), normal);
  assert.deepEqual(await send(json), normal);

  // End the decoder's readable side while the HTTP request remains open.
  // Send the tail from the parser callback, with no timing sleeps.
  const prefix = Buffer.concat([deflateSync(json), Buffer.from([0])]);
  const trailer = Buffer.alloc(1024);
  for (const path of ["/late-deflate", "/late-deflate-with-consumer"]) {
    const reply = await send(prefix, { encoding: "deflate", path, trailer });
    assert.equal(reply.status, 200);
    assert.equal(reply.content, json.toString());
    if (path.endsWith("with-consumer")) {
      assert.equal(reply.digest, createHash("sha256").update(prefix).update(trailer).digest("hex"));
    }
    assert.deepEqual(await send(json), normal);
  }
  console.log(JSON.stringify({ normalJson: true, validGzip: true, invalidGzipRejected: true,
    trailingGzip: true, lateDeflate: true, otherPipePreserved: true, subsequentRequests: true }));
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
