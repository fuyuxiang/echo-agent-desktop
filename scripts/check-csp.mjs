#!/usr/bin/env node
/**
 * CSP 白名单静态扫描。
 *
 * 读取 src-tauri/tauri.conf.json 的 csp 字段作为白名单源，
 * 扫描 src/ 下所有 .ts/.tsx/.mjs/.js 文件中的 http(s)/ws(s) 域，
 * 任何未列入白名单的域都视为违规（CI/build 阶段阻断）。
 *
 * 用法：node scripts/check-csp.mjs
 *       node scripts/check-csp.mjs --root /path/to/repo
 *       node scripts/check-csp.mjs --csp "self ipc: https://api.openai.com ..."
 *
 * 退出码：0 = 全部白名单；1 = 发现违规域；2 = 配置错误。
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// ---------- CSP 解析 ----------

/**
 * 把 csp 字符串解析为 [{ directive, sources }] 列表。
 */
export function parseCsp(csp) {
  if (!csp || typeof csp !== "string") return [];
  return csp
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((segment) => {
      const idx = segment.indexOf(" ");
      if (idx < 0) return { directive: segment, sources: [] };
      const directive = segment.slice(0, idx);
      const sources = segment
        .slice(idx + 1)
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      return { directive, sources };
    });
}

// ---------- 白名单 ----------

export class Allowlist {
  constructor(items) {
    this.items = new Set(items);
  }
  has(item) {
    return this.items.has(item);
  }
}

/** 判断 domain 是否在白名单内。 */
export function isWhitelisted(allow, domain) {
  if (!domain || typeof domain !== "string") return true; // 跳过空 / 非字符串
  // 标准化：去掉单/双引号（白名单里常以 'self' 形式出现）
  const normalized = domain.replace(/^['"]|['"]$/g, "");
  return allow.has(normalized) || allow.has(domain);
}

// ---------- 域提取 ----------

const DOMAIN_RE = /\b((?:https?|wss?):\/\/[A-Za-z0-9._:-]+)/g;
const COMMENT_LINE_RE = /^\s*(?:\/\/|\*|<!--)/;
const STRING_LITERAL_LINE_RE = /^[A-Za-z_$][\w$]*\s*[:=]/; // 可能是 "const x = ..." 一行才计入字符串

/**
 * 从源码中抠出所有 http(s)/ws(s) 域。
 * - 跳过单行注释（//、*、<!--）
 * - 跳过 window.location / location.href 类引用（这些是 SPA 内部跳转，不算外联）
 */
export function extractDomains(src) {
  const found = new Set();
  for (const rawLine of src.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (COMMENT_LINE_RE.test(line)) continue;
    // 跳过 window.location.href = "..." 这类内部跳转
    if (/(?:window\.)?location(?:\.[A-Za-z]+)*\s*[=(]/i.test(line)) continue;
    let m;
    DOMAIN_RE.lastIndex = 0;
    while ((m = DOMAIN_RE.exec(line)) !== null) {
      found.add(m[1]);
    }
  }
  return Array.from(found);
}

// ---------- 单文件 / 目录扫描 ----------

/**
 * 扫描单个文件，返回 [{ file, domain, line }] 形式的违规列表。
 */
export function scanFile(filePath, cspString) {
  const csp = parseCsp(cspString);
  // 把所有 directive 的 source 合并成白名单（任何 directive 出现的都算白名单）
  const allow = new Allowlist(
    csp.flatMap((d) => d.sources),
  );
  let src;
  try {
    src = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    return [{ file: filePath, domain: "", line: 0, error: `read failed: ${err.message}` }];
  }
  const domains = extractDomains(src);
  const violations = [];
  for (const domain of domains) {
    if (!isWhitelisted(allow, domain)) {
      // 找到该域在文件中的行号
      const lines = src.split(/\r?\n/);
      let lineNo = 0;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(domain)) {
          lineNo = i + 1;
          break;
        }
      }
      violations.push({ file: filePath, domain, line: lineNo });
    }
  }
  return violations;
}

const SCAN_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "__tests__"]);

/** 递归扫描 root 下所有源码文件，返回违规列表。 */
export function scanRoot(root, cspString) {
  const out = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile() && SCAN_EXTS.has(path.extname(e.name))) {
        out.push(...scanFile(full, cspString));
      }
    }
  }
  walk(root);
  return out;
}

// ---------- CLI ----------

function loadCspFromTauriConfig(repoRoot) {
  const confPath = path.join(repoRoot, "src-tauri", "tauri.conf.json");
  if (!fs.existsSync(confPath)) {
    throw new Error(`未找到 tauri.conf.json：${confPath}`);
  }
  const conf = JSON.parse(fs.readFileSync(confPath, "utf8"));
  const csp = conf?.app?.security?.csp;
  if (typeof csp !== "string") {
    throw new Error("tauri.conf.json 缺少 app.security.csp 字符串");
  }
  return csp;
}

function parseArgs(argv) {
  const args = { root: process.cwd(), csp: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") args.root = path.resolve(argv[++i]);
    else if (a === "--csp") args.csp = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log("用法：node scripts/check-csp.mjs [--root <dir>] [--csp <csp-string>]");
      process.exit(0);
    } else {
      console.error(`未知参数：${a}`);
      process.exit(2);
    }
  }
  return args;
}

export function main(argv = process.argv) {
  const args = parseArgs(argv);
  const csp = args.csp ?? loadCspFromTauriConfig(args.root);
  const scanDir = path.join(args.root, "src");
  if (!fs.existsSync(scanDir)) {
    console.error(`扫描目录不存在：${scanDir}`);
    return 2;
  }
  const violations = scanRoot(scanDir, csp);
  if (violations.length === 0) {
    console.log(`✓ CSP 检查通过：未发现非白名单域（基于 src-tauri/tauri.conf.json 当前 csp）`);
    return 0;
  }
  console.error(`✗ CSP 检查失败：发现 ${violations.length} 个非白名单域`);
  for (const v of violations) {
    console.error(`  ${path.relative(args.root, v.file)}:${v.line}  ${v.domain}`);
  }
  console.error(`\n请在 src-tauri/tauri.conf.json 的 app.security.csp 中加入该域，或改用 Rust 代理出站。`);
  return 1;
}

// 直接运行入口
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
