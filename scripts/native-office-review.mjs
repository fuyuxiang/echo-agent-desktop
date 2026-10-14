import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';

const FORMATS = ['docx', 'pdf', 'xlsx', 'pptx'];
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const TITLE = '原生中文办公验收';
const MARKDOWN = `# 原生中文办公验收

通过真实桌面办公工具生成中文成果，验证保存文件及重启后可取得。

## 任务与层次

- 父任务：核对成果
  - 子任务甲：确认中文与表格
  - 子任务乙：确认代码换行
- 后续任务：保留第一次生成的文件

## 中文表格

| 项目 | 编号 | 状态 | 表达式 | 金额 |
| --- | --- | --- | --- | --- |
| 中文任务甲 | 001234 | 已核对 | $a<b>c$ | $5 |
| 中文任务乙 | 12345678901234567890 | 待复核 | $\\{x\\}$ | $10 |

## 两行代码

\`\`\`text
第一行代码
第二行代码
\`\`\`

## 比较、公式与图表源码

普通比较：a < b > c。公式：$a<b>c$，$\\{x\\}$。
括号公式：\\(a<b>c\\)。方括号公式：\\[\\{x\\}\\]。
金额：$5 / $10。English: office affinity efficient final_file.

$$
\\{x\\}
x<y>z
$$

\`\`\`mermaid
flowchart LR
 A[甲] --> B[乙]
\`\`\`

验收结论：重复标题应生成独立文件，原文件内容保持。
`;

function checkedSession(request) {
  if (!request || request.phase !== 'first-launch'
    || typeof request.sessionId !== 'string' || !request.sessionId.trim()
    || request.sessionId.length > 256 || /[\u0000-\u001f\u007f]/u.test(request.sessionId)) {
    throw new Error('Native Office review requires a live first-launch session');
  }
  return request.sessionId;
}

async function checkedWorkspace(home, request) {
  checkedSession(request);
  if (typeof home !== 'string' || !isAbsolute(home)
    || typeof request.cwd !== 'string' || !isAbsolute(request.cwd)) {
    throw new Error('Native Office review requires absolute isolated paths');
  }
  const canonicalHome = await realpath(home);
  const cwd = await realpath(request.cwd);
  // Compare with the literal child of the canonical home, rather than the
  // canonical target of a potentially escaping workspaces/default symlink.
  if (cwd !== join(canonicalHome, 'workspaces', 'default')) {
    throw new Error('Native Office review workspace differs from the isolated default workspace');
  }
  return { home: canonicalHome, cwd, directory: join(cwd, 'EchoAgent成果') };
}

function checkedReceipt(value) {
  if (!value || typeof value !== 'object' || !FORMATS.includes(value.format)
    || typeof value.path !== 'string' || !isAbsolute(value.path) || value.path.includes('\0')
    || !Number.isSafeInteger(value.byteSize) || value.byteSize <= 0 || value.byteSize > MAX_FILE_BYTES
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256)) {
    throw new Error('Native Office returned an invalid document receipt');
  }
  // Never persist arbitrary response fields, which could contain credentials.
  return { path: value.path, format: value.format, byteSize: value.byteSize, sha256: value.sha256 };
}

async function verifyOneReceipt(directory, candidate) {
  const receipt = checkedReceipt(candidate);
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
    || await realpath(directory) !== directory) {
    throw new Error('Native Office output directory is not an ordinary workspace directory');
  }
  if (dirname(resolve(receipt.path)) !== directory
    || await realpath(receipt.path) !== receipt.path
    || extname(receipt.path) !== `.${receipt.format}`) {
    throw new Error('Native Office receipt points outside its authorized document directory');
  }
  const stat = await lstat(receipt.path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== receipt.byteSize) {
    throw new Error('Native Office output is missing, is not an ordinary file, or has the wrong size');
  }
  const data = await readFile(receipt.path);
  const validMagic = receipt.format === 'pdf'
    ? data.subarray(0, 5).equals(Buffer.from('%PDF-'))
    : data.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  if (!validMagic || createHash('sha256').update(data).digest('hex') !== receipt.sha256) {
    throw new Error('Native Office output file signature or SHA-256 differs from its receipt');
  }
  return receipt;
}

/** Verify saved results again after native restart without making network calls. */
export async function verifyNativeOfficeReceipts({ home, request, receipts }) {
  const workspace = await checkedWorkspace(home, request);
  if (!Array.isArray(receipts) || receipts.length !== 5) {
    throw new Error('Native Office review requires four formats and a repeated-title document');
  }
  const counts = Object.fromEntries(FORMATS.map((format) => [format, 0]));
  const checked = [];
  const paths = new Set();
  for (const candidate of receipts) {
    const receipt = await verifyOneReceipt(workspace.directory, candidate);
    if (paths.has(receipt.path)) throw new Error('Native Office repeated a document destination');
    paths.add(receipt.path);
    counts[receipt.format] += 1;
    checked.push(receipt);
  }
  if (counts.docx !== 2 || counts.pdf !== 1 || counts.xlsx !== 1 || counts.pptx !== 1) {
    throw new Error('Native Office review receipts do not cover all required formats');
  }
  return checked;
}

async function snapshot(directory) {
  let stat;
  try { stat = await lstat(directory); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('Cannot inspect the Native Office output directory');
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Native Office output directory is unsafe');
  const entries = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name);
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_FILE_BYTES) {
      throw new Error('Native Office output directory contains an unexpected entry');
    }
    entries.push({ name, size: entry.size, sha256: createHash('sha256').update(await readFile(path)).digest('hex') });
  }
  return entries;
}

function readOfficeRegistration(home) {
  // stdout is captured only in this process. Do not log it, stderr, or the
  // configuration, including when Python or TOML parsing fails.
  const result = spawnSync('python3', ['-c', `
import json, sys, tomllib
with open(sys.argv[1], 'rb') as source:
    server = tomllib.load(source)['mcp_servers']['echoagent-office']
print(json.dumps({'url': server['url'], 'authorization': server['headers']['Authorization']}))
`, join(home, 'config.toml')], { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('Cannot read the isolated Native Office registration');
  let registration;
  try { registration = JSON.parse(result.stdout); } catch {
    throw new Error('The isolated Native Office registration could not be parsed');
  }
  let url;
  try { url = new URL(registration.url); } catch {
    throw new Error('The isolated Native Office endpoint is invalid');
  }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
    || url.pathname !== '/mcp' || url.username || url.password || url.search || url.hash
    || typeof registration.authorization !== 'string'
    || !/^Bearer [A-Za-z0-9-]+$/u.test(registration.authorization)) {
    throw new Error('The isolated Native Office endpoint or authorization is invalid');
  }
  return { url: url.href, authorization: registration.authorization };
}

/** Exercise the running desktop's real task-bound Office MCP and Worker. */
export async function runNativeOfficeReview({ home, request, output }) {
  const startedAt = new Date().toISOString();
  const report = { environment: 'native desktop Office MCP + production Worker + real files', startedAt, passed: false, receipts: [], negativeChecks: [] };
  let authorization;
  const evidencePath = typeof output === 'string' && output.trim() && isAbsolute(resolve(output))
    ? join(resolve(output), 'native-office.json') : null;
  const save = async () => {
    if (!evidencePath) return;
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  };
  try {
    if (!evidencePath) throw new Error('Native Office review requires an evidence directory');
    const workspace = await checkedWorkspace(home, request);
    const sessionId = checkedSession(request);
    const registration = readOfficeRegistration(workspace.home);
    authorization = registration.authorization;
    report.sessionId = sessionId;
    report.workspace = workspace.cwd;
    let sequence = 0;
    const rpc = async (method, params, { auth = authorization, session = sessionId, expectedStatus = 200, timeout = 30000 } = {}) => {
      const id = `native-office-${++sequence}`;
      let response;
      try {
        response = await fetch(registration.url, {
          method: 'POST',
          redirect: 'error',
          headers: { 'Content-Type': 'application/json', Authorization: auth, 'X-EchoAgent-Session-Id': session },
          body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
          signal: AbortSignal.timeout(timeout),
        });
      } catch (error) {
        throw new Error(`Native Office ${method} request ${error.name === 'TimeoutError' ? 'timed out' : 'failed'}`);
      }
      if (response.status !== expectedStatus) throw new Error(`Native Office ${method} returned HTTP ${response.status}; expected ${expectedStatus}`);
      if (expectedStatus !== 200) {
        await response.body?.cancel();
        return { status: response.status };
      }
      let body;
      try { body = await response.json(); } catch {
        throw new Error(`Native Office ${method} returned invalid JSON`);
      }
      if (body?.jsonrpc !== '2.0' || body.id !== id || body.error || !body.result || typeof body.result !== 'object') {
        throw new Error(`Native Office ${method} returned an invalid JSON-RPC result`);
      }
      return body.result;
    };

    const initialized = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'echo-native-review', version: '1' } });
    if (initialized.serverInfo?.name !== 'echoagent-office' || !initialized.capabilities?.tools) {
      throw new Error('The running Native Office service did not initialize its tool capability');
    }
    const listed = await rpc('tools/list', {});
    if (!Array.isArray(listed.tools) || !listed.tools.some((tool) => tool.name === 'office_create')) {
      throw new Error('The running Native Office service did not expose office_create');
    }
    const before = await snapshot(workspace.directory);
    await rpc('tools/list', {}, { auth: 'Bearer invalid-native-review-token', expectedStatus: 401 });
    report.negativeChecks.push({ id: 'invalid-bearer', passed: true, status: 401 });

    const createParams = (format) => ({ name: 'office_create', arguments: { title: TITLE, markdown: MARKDOWN, format } });
    for (const negative of [
      { id: 'unknown-session', params: createParams('docx'), options: {
        session: `missing-native-office-${createHash('sha256').update(sessionId).digest('hex').slice(0, 32)}`,
      } },
      { id: 'unsupported-format', params: createParams('unsupported'), options: {} },
    ]) {
      const result = await rpc('tools/call', negative.params, { ...negative.options, timeout: 120000 });
      if (result.isError !== true || !Array.isArray(result.content)
        || !result.content.some((item) => item.type === 'text' && typeof item.text === 'string' && item.text.length > 0)
        || JSON.stringify(await snapshot(workspace.directory)) !== JSON.stringify(before)) {
        throw new Error(`Native Office ${negative.id} did not reject the operation without changing files`);
      }
      report.negativeChecks.push({ id: negative.id, passed: true, toolError: true, filesUnchanged: true });
    }

    for (const format of [...FORMATS, 'docx']) {
      const result = await rpc('tools/call', createParams(format), { timeout: 120000 });
      if (result.isError || !Array.isArray(result.content)) throw new Error(`Native Office ${format} creation returned a tool error`);
      const text = result.content.filter((item) => item.type === 'text' && typeof item.text === 'string');
      if (text.length !== 1) throw new Error(`Native Office ${format} creation did not return a single receipt`);
      let receipt;
      try { receipt = JSON.parse(text[0].text); } catch { throw new Error(`Native Office ${format} receipt is not JSON`); }
      if (receipt.format !== format) throw new Error(`Native Office ${format} receipt has the wrong format`);
      report.receipts.push(await verifyOneReceipt(workspace.directory, receipt));
      // Verify all prior results after each call so a repeated title cannot
      // silently replace the first artifact while reporting a new destination.
      for (const previous of report.receipts) await verifyOneReceipt(workspace.directory, previous);
    }
    report.receipts = await verifyNativeOfficeReceipts({ home: workspace.home, request, receipts: report.receipts });
    report.passed = true;
    report.markdown = MARKDOWN;
    report.finishedAt = new Date().toISOString();
    await save();
    return { passed: true, receipts: report.receipts, negativeChecks: report.negativeChecks, markdown: MARKDOWN };
  } catch (error) {
    // Our own errors avoid response/configuration content; redact the secret as
    // a final safeguard for filesystem or future call sites as well.
    let message = error instanceof Error ? error.message : 'Native Office review failed';
    if (authorization) message = message.replaceAll(authorization, '[redacted]').replaceAll(authorization.slice(7), '[redacted]');
    report.error = message;
    report.finishedAt = new Date().toISOString();
    try { await save(); } catch { /* Preserve the original validation failure. */ }
    throw new Error(message);
  }
}
