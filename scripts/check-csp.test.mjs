import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { extractDomains, isWhitelisted, parseCsp, scanFile, scanRoot, Allowlist } from "./check-csp.mjs";

const tmp = [];
function mk() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "echoagent-csp-"));
  tmp.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("parseCsp", () => {
  it("拆出 directive 与来源列表", () => {
    const csp = "default-src 'self'; connect-src 'self' ipc: http://ipc.localhost https://api.openai.com; img-src 'self' data:";
    const out = parseCsp(csp);
    expect(out).toEqual([
      { directive: "default-src", sources: ["'self'"] },
      { directive: "connect-src", sources: ["'self'", "ipc:", "http://ipc.localhost", "https://api.openai.com"] },
      { directive: "img-src", sources: ["'self'", "data:"] },
    ]);
  });

  it("空 CSP 返回空数组", () => {
    expect(parseCsp("")).toEqual([]);
  });
});

describe("extractDomains", () => {
  it("从源码里抠出 http(s)/ws(s) 域", () => {
    const src = `
      await fetch("https://api.anthropic.com/v1/messages");
      new WebSocket("wss://realtime.example.com/socket");
      const url = "http://internal.local/api";
      // 这是 https://comment.example 不算（注释里）
      // ignore: 'https://placeholder.test'
      window.location.href = "https://app.local/page";
    `;
    const domains = extractDomains(src);
    expect(domains).toContain("https://api.anthropic.com");
    expect(domains).toContain("wss://realtime.example.com");
    expect(domains).toContain("http://internal.local");
    expect(domains).not.toContain("https://app.local"); // 跳过 window.location
  });

  it("忽略注释行的域", () => {
    const src = `
// https://ignored.example.com/api
const x = "https://real.example.com";
`;
    const domains = extractDomains(src);
    expect(domains).toEqual(["https://real.example.com"]);
  });
});

describe("isWhitelisted", () => {
  const allow = new Allowlist([
    "self", "ipc:",
    "http://ipc.localhost",
    "https://api.anthropic.com",
    "https://api.openai.com",
    "https://api.deepseek.com",
    "https://dashscope.aliyuncs.com",
    "https://api.minimaxi.com",
    "https://agentclientprotocol.com",
    "http://10.132.19.82:8787",
    "https://asset.localhost",
    "data:", "blob:", "asset:",
  ]);

  it("白名单内域返回 true", () => {
    expect(isWhitelisted(allow, "https://api.anthropic.com")).toBe(true);
    expect(isWhitelisted(allow, "http://10.132.19.82:8787")).toBe(true);
    expect(isWhitelisted(allow, "'self'")).toBe(true);
    expect(isWhitelisted(allow, "ipc:")).toBe(true);
  });

  it("非白名单域返回 false", () => {
    expect(isWhitelisted(allow, "https://evil.example.com")).toBe(false);
    expect(isWhitelisted(allow, "http:")).toBe(false); // 通配协议不算白名单
    expect(isWhitelisted(allow, "https:")).toBe(false);
  });
});

describe("scanFile", () => {
  it("发现非白名单域时报告问题", () => {
    const dir = mk();
    const f = path.join(dir, "x.ts");
    fs.writeFileSync(f, 'fetch("https://suspicious.example.com/api");\n', "utf8");
    const issues = scanFile(f, "self ipc: https://api.anthropic.com");
    expect(issues).toHaveLength(1);
    expect(issues[0].domain).toBe("https://suspicious.example.com");
    expect(issues[0].file).toBe(f);
  });

  it("全部白名单时返回空", () => {
    const dir = mk();
    const f = path.join(dir, "y.ts");
    fs.writeFileSync(f, 'fetch("https://api.anthropic.com/v1/messages");\n', "utf8");
    const issues = scanFile(f, "self ipc: https://api.anthropic.com");
    expect(issues).toEqual([]);
  });
});

describe("scanRoot", () => {
  it("递归扫描目录下所有 .ts/.tsx 文件", () => {
    const dir = mk();
    const sub = path.join(dir, "src");
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, "a.ts"), 'fetch("https://a.example.com");\n');
    fs.writeFileSync(path.join(sub, "b.tsx"), 'fetch("https://api.anthropic.com");\n');
    fs.writeFileSync(path.join(sub, "c.txt"), 'ignore me\n'); // 非源码跳过
    const issues = scanRoot(sub, "self https://api.anthropic.com");
    expect(issues).toHaveLength(1);
    expect(issues[0].domain).toBe("https://a.example.com");
  });
});
