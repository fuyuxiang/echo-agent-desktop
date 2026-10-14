// A real loopback page for model-driven Browser Use acceptance. Synthetic data
// lives only in this process; there are no contacts, credentials or user files.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

export async function createBrowserReviewResource(nonce) {
  assert(/^[a-f0-9]{32}$/.test(nonce), 'Expected a fixed lower-case review nonce');
  const prefix = `/review/${nonce}`;
  const inputMarker = `BROWSER-INPUT-${nonce}`;
  const submittedMarker = `BROWSER-SUBMITTED-${nonce}`;
  const deletedMarker = `BROWSER-DELETED-${nonce}`;
  const filename = '中文浏览器验收.txt';
  const bytes = Buffer.from(`独立浏览器下载验收\n${inputMarker}\n${submittedMarker}\n`, 'utf8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const events = [];
  let submitted = false, deleted = false, stopped = false, origin;
  const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>EchoAgent 隔离网页验收</title>
<style>body{font:18px system-ui;max-width:720px;margin:40px auto;padding:24px}label,input,button,a{display:block;margin:18px 0}input{width:95%;padding:12px}button{padding:12px 20px}output{display:block;white-space:pre-wrap}</style></head>
<body><h1>本次独立浏览器测试</h1><p>全部内容是合成测试数据，操作仅作用于这个临时本机网页。</p>
<label for="review-text">本次验收文本</label><input id="review-text" type="text" autocomplete="off">
<button id="submit">发送本次验收文本</button><output id="result" aria-live="polite">尚未发送</output>
<a id="download" href="${prefix}/download.txt" download="${filename}">下载中文验收文件</a>
<button id="delete">删除本次测试记录</button><output id="delete-result" aria-live="polite">尚未删除</output>
<script>const prefix=${JSON.stringify(prefix)}, nonce=${JSON.stringify(nonce)};
async function action(route, value, output){try{const response=await fetch(prefix+'/'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nonce,value})});const data=await response.json();document.getElementById(output).textContent=response.ok?data.marker:'操作失败：'+data.error;}catch(error){document.getElementById(output).textContent='连接失败';}}
document.getElementById('submit').addEventListener('click',()=>action('submit',document.getElementById('review-text').value,'result'));
document.getElementById('delete').addEventListener('click',()=>action('delete','delete-owned-fixture','delete-result'));
</script></body></html>`;
  const sockets = new Set();
  const server = createServer(async (request, response) => {
    const entry = { at: new Date().toISOString(), method: request.method,
      route: 'rejected', status: 0, userAgent: String(request.headers['user-agent'] || '').slice(0, 200) };
    const finish = (status, body, type = 'application/json; charset=utf-8', headers = {}) => {
      entry.status = status; events.push(entry);
      response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'", ...headers });
      response.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    try {
      if (request.headers.host !== new URL(origin).host) return finish(403, { error: 'host rejected' });
      const url = new URL(request.url, origin);
      if (url.origin !== origin || url.search || url.hash || !request.url.startsWith(prefix + '/')) {
        return finish(404, { error: 'outside this synthetic resource' });
      }
      if (request.method === 'GET' && url.pathname === prefix + '/') {
        entry.route = 'page'; return finish(200, page, 'text/html; charset=utf-8');
      }
      if (request.method === 'GET' && url.pathname === prefix + '/download.txt') {
        entry.route = 'download';
        if (!submitted || deleted) return finish(409, { error: 'submit the owned text first' });
        return finish(200, bytes, 'text/plain; charset=utf-8', {
          'Content-Disposition': `attachment; filename="browser-review.txt"; filename*=UTF-8''${encodeURIComponent(filename)}`,
          'Content-Length': bytes.length,
        });
      }
      if (request.method !== 'POST' || ![prefix + '/submit', prefix + '/delete'].includes(url.pathname)) {
        return finish(404, { error: 'unsupported route' });
      }
      entry.route = url.pathname.endsWith('/submit') ? 'submit' : 'delete';
      if (request.headers.origin !== origin || request.headers['content-type'] !== 'application/json') {
        return finish(403, { error: 'origin or content type rejected' });
      }
      let size = 0; const chunks = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 2048) return finish(413, { error: 'synthetic input too large' });
        chunks.push(chunk);
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!payload || payload.nonce !== nonce || Object.keys(payload).sort().join(',') !== 'nonce,value') {
        return finish(403, { error: 'scope rejected' });
      }
      if (entry.route === 'submit') {
        if (payload.value !== inputMarker || deleted || submitted) return finish(409, { error: 'unexpected or repeated test text' });
        submitted = true; return finish(200, { marker: submittedMarker });
      }
      if (payload.value !== 'delete-owned-fixture' || !submitted || deleted) return finish(409, { error: 'unexpected or repeated delete' });
      deleted = true; return finish(200, { marker: deletedMarker });
    } catch {
      if (!response.headersSent) finish(400, { error: 'invalid synthetic request' });
      else response.destroy();
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((accept, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', accept);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin, url: origin + prefix + '/', nonce, inputMarker, submittedMarker, deletedMarker,
    filename, bytes, sha256,
    snapshot: () => ({ submitted, deleted, stopped, events: events.map((entry) => ({ ...entry })) }),
    close: async () => {
      if (stopped) return;
      await new Promise((accept, reject) => {
        const timer = setTimeout(() => { for (const socket of sockets) socket.destroy(); }, 2000);
        server.close((error) => { clearTimeout(timer); if (error) reject(error); else accept(); });
        server.closeIdleConnections();
      });
      stopped = true;
    },
  };
}
