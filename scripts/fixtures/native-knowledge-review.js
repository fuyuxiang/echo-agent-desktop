// Loaded only by the isolated native acceptance driver. Every operation below
// uses an existing production IPC command; no model, OS picker, or store mocks.
window.__echoNativeKnowledgeReview = async ({ invoke, home, cwd, phase, expected }) => {
  const startedAt = Date.now();
  const deadline = startedAt + 170000;
  const report = { environment: "native WebView + production IPC + isolated local files", phase,
    checks: [], errors: [], expected: null, passed: false, osDirectoryPicker: "not exercised",
    semanticService: "optional; actual retrieval mode is recorded" };
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const record = (id, evidence, result = "passed") => report.checks.push({ id, result, evidence });
  const path = (value) => {
    assert(typeof value === "string" && value.startsWith("/") && !value.split(/[\\/]/).includes(".."), "Expected absolute scoped native path");
    return value.replace(/\\/g, "/").replace(/^\/var\//, "/private/var/").replace(/^\/tmp\//, "/private/tmp/").replace(/\/+$/, "");
  };
  const within = (value, root) => path(value) === path(root) || path(value).startsWith(`${path(root)}/`);
  const temporary = (value) => /^(\/private\/tmp\/|\/private\/var\/folders\/)/.test(path(value));
  const call = async (command, args = {}, timeoutMs = 15000) => {
    const remaining = deadline - Date.now();
    assert(remaining > 0, `Native knowledge acceptance deadline exceeded before ${command}`);
    let timer;
    try {
      return await Promise.race([invoke(command, args), new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${command} timed out`)), Math.min(timeoutMs, remaining));
      })]);
    } finally { clearTimeout(timer); }
  };
  // WKWebView custom schemes need not expose WebCrypto. Keep the same exact
  // SHA-256 assertion with this UTF-8 software implementation, not a fake hash.
  const sha256Utf8 = (text) => {
    const input = new TextEncoder().encode(text);
    const bytes = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64);
    bytes.set(input); bytes[input.length] = 0x80;
    const view = new DataView(bytes.buffer);
    view.setUint32(bytes.length - 8, Math.floor(input.length / 0x20000000));
    view.setUint32(bytes.length - 4, (input.length * 8) >>> 0);
    const constants = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    const state = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
    const words = new Uint32Array(64);
    const rotate = (value, count) => (value >>> count) | (value << (32 - count));
    for (let offset = 0; offset < bytes.length; offset += 64) {
      for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
      for (let i = 16; i < 64; i++) {
        const x = words[i - 15], y = words[i - 2];
        words[i] = (words[i - 16] + (rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3))
          + words[i - 7] + (rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10))) >>> 0;
      }
      let [a,b,c,d,e,f,g,h] = state;
      for (let i = 0; i < 64; i++) {
        const first = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25))
          + ((e & f) ^ (~e & g)) + constants[i] + words[i]) >>> 0;
        const second = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        h=g; g=f; f=e; e=(d + first) >>> 0; d=c; c=b; b=a; a=(first + second) >>> 0;
      }
      [a,b,c,d,e,f,g,h].forEach((value, i) => { state[i] = (state[i] + value) >>> 0; });
    }
    return [...state].map((value) => value.toString(16).padStart(8, "0")).join("");
  };
  const digest = async (text) => {
    if (globalThis.crypto?.subtle) {
      return [...new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
        .map((value) => value.toString(16).padStart(2, "0")).join("");
    }
    return sha256Utf8(text);
  };
  const memoryArgs = { scope: "global", path: "MEMORY.md", cwd };
  const expectationFile = "原生知识验收/expected.json";
  const readSources = async () => {
    const result = await call("org_local_kb_sources_get", { includeStorageState: true });
    assert(result && typeof result.exists === "boolean" && Array.isArray(result.sources), "Invalid persisted knowledge source descriptor");
    for (const source of result.sources) assert(within(source.root, cwd), "Knowledge source escaped isolated authorized workspace");
    return result;
  };
  const search = async (query) => {
    const result = await call("personal_knowledge_search", { query, limit: 8,
      requestId: `native-knowledge-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` });
    assert(result && Array.isArray(result.items) && result.index && typeof result.retrievalMode === "string", "Invalid native knowledge search response");
    for (const item of result.items) {
      assert(within(item.path, cwd), "Search returned a path outside the isolated authorized workspace");
      assert(typeof item.snippet === "string" && typeof item.source === "string", "Invalid knowledge reference");
    }
    return result;
  };
  const waitForHit = async (marker, source, maxMs = 25000) => {
    const stop = Math.min(deadline, Date.now() + maxMs);
    let latest;
    while (Date.now() < stop) {
      latest = await search(marker);
      const hit = latest.items.find((item) => item.source === source.id && within(item.path, source.root) && item.snippet.includes(marker));
      if (hit) return { response: latest, hit };
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Local fingerprint was not retrievable (${source.id}; mode=${latest?.retrievalMode}; state=${latest?.index?.state})`);
  };
  const validateMemoryEntry = async (entry, content) => {
    assert(entry?.scope === "global" && entry.path === "MEMORY.md" && entry.readOnly === false, "Unexpected canonical memory scope");
    assert(entry.content === content && entry.size === new TextEncoder().encode(content).length, "Memory content/UTF-8 size mismatch");
    assert(entry.revision === await digest(content), "Memory revision is not the persisted content SHA-256");
  };
  const mustReject = async (id, command, args) => {
    let error = null;
    try { await call(command, args); } catch (reason) { error = String(reason); }
    assert(error && !error.includes("timed out"), `${id}: operation was not rejected by native validation`);
    record(id, { rejected: true, reason: error.slice(0, 350) });
  };
  try {
    assert(typeof invoke === "function", "Native invoke is required");
    assert(sha256Utf8("abc") === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "Software SHA-256 self-check failed");
    assert(temporary(home) && temporary(cwd) && within(cwd, home), "Refusing non-isolated native knowledge/memory data roots");
    assert(path(home).length > 30 && path(home) !== path(cwd), "Data home and authorized workspace must be separate temporary paths");
    assert(phase === "first-launch" || phase === "restart", "Unknown native acceptance phase");
    assert(await call("personal_knowledge_allowed") === true, "Personal knowledge is unavailable under the current actual policy");
    record("native-knowledge-isolation", { home, cwd, authorization: "existing native-managed workspace; no OS picker or synthetic grant" });

    if (phase === "restart") {
      if (!expected) expected = JSON.parse(await call("read_text_file", { path: expectationFile, cwd, maxBytes: 65536 }));
      assert(expected?.version === 1 && path(expected.home) === path(home) && path(expected.cwd) === path(cwd), "Restart expectation belongs to another profile/workspace");
      report.expected = expected;
      const stored = await readSources();
      assert(stored.exists && stored.sources.length === 1 && stored.sources[0].id === expected.activeSource.id
        && path(stored.sources[0].root) === path(expected.activeSource.root), "Knowledge source registration did not survive restart or revoked source returned");
      record("native-knowledge-source-restart", { sources: stored.sources });
      const restoredMemory = await call("memory_get", memoryArgs);
      assert(restoredMemory === expected.memory.content, "Canonical memory changed across native process restart");
      const memories = await call("memory_list", { cwd });
      const memory = memories.find((item) => item.scope === "global" && item.path === "MEMORY.md");
      await validateMemoryEntry(memory, restoredMemory);
      assert(memory.revision === expected.memory.revision, "Memory revision changed across process restart");
      record("native-memory-restart", { scope: memory.scope, path: memory.path, size: memory.size, revision: memory.revision, fingerprint: expected.fingerprint });
      const found = await waitForHit(expected.updatedMarker, expected.activeSource);
      const revoked = await search(expected.revokedMarker);
      assert(!revoked.items.some((item) => item.source === expected.revokedSource.id || within(item.path, expected.revokedSource.root)
        || item.snippet.includes(expected.revokedMarker)), "Revoked source resurfaced after process restart");
      record("native-knowledge-search-restart", { source: found.hit.source, path: found.hit.path, snippet: found.hit.snippet,
        retrievalMode: found.response.retrievalMode, degradedReason: found.response.degradedReason, revokedSourceReturned: false });
      const summaries = memories.filter((entry) => entry.scope === "session");
      assert(summaries.every((entry) => entry.readOnly && !entry.path.includes("/")), "Generated summary scope was not read-only and bounded");
      record("native-memory-summary-list", { count: summaries.length, readOnly: true,
        limitation: summaries.length ? "Existing generated summaries are listed; no model consolidation requested" : "Temporary workspace has no generated summary; generation/consolidation untested" });
    } else {
      const fingerprint = await digest(`${path(home)}\n${path(cwd)}\nnative-knowledge-v1`);
      const suffix = fingerprint.slice(0, 20);
      const oldMarker = `NKOLD${suffix}`;
      const updatedMarker = `NKUPDATED${suffix}`;
      const revokedMarker = `NKREVOKED${suffix}`;
      expected = { version: 1, home, cwd, fingerprint, oldMarker, updatedMarker, revokedMarker, memory: null, activeSource: null, revokedSource: null };
      report.expected = expected;
      const initialSources = await readSources();
      assert(initialSources.sources.length === 0, "Refusing to overwrite pre-existing knowledge registrations, even in the test profile");
      const memories = await call("memory_list", { cwd });
      const initialMemory = memories.find((item) => item.scope === "global" && item.path === "MEMORY.md");
      const base = initialMemory?.content || "";
      const content = `${base}${base ? "\n\n" : ""}# 原生 MemoryStorage 验收\n合成数据指纹：${fingerprint}\n中文、表格约束：|项目|结果|；仅用于隔离验收。\n`;
      const first = await call("memory_save", { ...memoryArgs, content, expectedRevision: initialMemory?.revision || "" });
      await validateMemoryEntry(first, content);
      const updated = `${content}\n二次保存已确认；${updatedMarker}\n`;
      let current = await call("memory_save", { ...memoryArgs, content: updated, expectedRevision: first.revision });
      await validateMemoryEntry(current, updated);
      await mustReject("native-memory-reject-stale-save", "memory_save", { ...memoryArgs, content: "旧版本不可覆盖", expectedRevision: first.revision });
      await mustReject("native-memory-reject-stale-delete", "memory_delete", { ...memoryArgs, expectedRevision: first.revision });
      assert(await call("memory_get", memoryArgs) === updated, "Rejected stale write/delete changed canonical memory");
      if (!initialMemory) {
        await call("memory_delete", { ...memoryArgs, expectedRevision: current.revision });
        await mustReject("native-memory-deleted-not-readable", "memory_get", memoryArgs);
        current = await call("memory_save", { ...memoryArgs, content: updated, expectedRevision: "" });
        await validateMemoryEntry(current, updated);
        record("native-memory-delete-recreate", { onlyFreshHelperOwnedFileDeleted: true, revision: current.revision });
      } else record("native-memory-delete-recreate", { reason: "Pre-existing test-profile canonical memory retained" }, "not_exercised");
      await mustReject("native-memory-reject-traversal", "memory_save", { ...memoryArgs, path: "../越界.md", content: "should reject", expectedRevision: "" });
      expected.memory = { content: updated, revision: current.revision };
      record("native-memory-save-get-revision", { fingerprint, scope: current.scope, path: current.path, size: current.size, revision: current.revision });
      const summaries = memories.filter((entry) => entry.scope === "session");
      assert(summaries.every((entry) => entry.readOnly && !entry.path.includes("/")), "Invalid generated summary metadata");
      record("native-memory-summary-list", { count: summaries.length, readOnly: true,
        limitation: summaries.length ? "Existing summaries observed; model generation/consolidation not requested" : "Ephemeral workspace has no generated summary; empty state only" });

      const activeFile = await call("write_text_file", { path: "原生知识验收/保留资料/中文 规则.md", workspaceRoot: cwd,
        content: `# 原生个人知识验收\n请按合成差旅规则复核，知识指纹为 ${oldMarker}。\n|规则|金额|\n|住宿|500元|\n` });
      const revokedFile = await call("write_text_file", { path: "原生知识验收/撤销资料/中文 撤销.md", workspaceRoot: cwd,
        content: `# 待撤销的合成知识\n撤销后不得检索或引用；指纹为 ${revokedMarker}。\n` });
      assert(within(activeFile, cwd) && within(revokedFile, cwd), "Native file writes escaped the scoped workspace");
      expected.activeSource = { id: `native-active-${suffix}`, kind: "local-folder", label: "原生验收保留资料", root: activeFile.slice(0, activeFile.lastIndexOf("/")), enabled: true };
      expected.revokedSource = { id: `native-revoked-${suffix}`, kind: "local-folder", label: "原生验收撤销资料", root: revokedFile.slice(0, revokedFile.lastIndexOf("/")), enabled: true };
      await call("org_local_kb_sources_set", { sources: [expected.activeSource, expected.revokedSource] });
      const registered = await readSources();
      assert(registered.exists && registered.sources.length === 2, "Authorized source registrations were not persisted");
      const firstHit = await waitForHit(oldMarker, expected.activeSource);
      const revokeHit = await waitForHit(revokedMarker, expected.revokedSource);
      record("native-knowledge-register-search", { sources: registered.sources, fingerprint, activePath: firstHit.hit.path,
        activeSnippet: firstHit.hit.snippet, revokedPath: revokeHit.hit.path, retrievalMode: firstHit.response.retrievalMode,
        degradedReason: firstHit.response.degradedReason, index: firstHit.response.index });
      await call("write_text_file", { path: activeFile, workspaceRoot: cwd,
        content: `# 更新后的原生个人知识验收\n合成规则已更新，指纹为 ${updatedMarker}。\n|规则|金额|\n|住宿|650元|\n` });
      const rebuild = await call("personal_knowledge_rebuild", {}, 100000);
      const updatedHit = await waitForHit(updatedMarker, expected.activeSource);
      const outdated = await search(oldMarker);
      assert(!outdated.items.some((item) => item.snippet.includes(oldMarker)), "Rebuilt index returned the old file fingerprint");
      record("native-knowledge-update-rebuild", { state: rebuild.state, updatedPath: updatedHit.hit.path,
        updatedSnippet: updatedHit.hit.snippet, retrievalMode: updatedHit.response.retrievalMode, oldFingerprintReturned: false });
      await call("org_local_kb_sources_set", { sources: [expected.activeSource] });
      const retained = await readSources();
      assert(retained.sources.length === 1 && retained.sources[0].id === expected.activeSource.id, "Source revocation did not persist");
      const revoked = await search(revokedMarker);
      assert(!revoked.items.some((item) => item.source === expected.revokedSource.id || within(item.path, expected.revokedSource.root)
        || item.snippet.includes(revokedMarker)), "KNW-B07: revoked knowledge source remained queryable before asynchronous index cleanup");
      record("native-knowledge-immediate-revoke", { remainingSources: retained.sources, revokedSourceReturned: false,
        indexState: revoked.index.state, retrievalMode: revoked.retrievalMode, waitedForRebuild: false });
      await call("write_text_file", { path: expectationFile, workspaceRoot: cwd, content: JSON.stringify(expected) });
    }
    report.passed = !report.checks.some((check) => check.result === "failed");
  } catch (reason) {
    report.errors.push(String(reason).slice(0, 1400));
    report.checks.push({ id: "native-knowledge-memory-failure", result: "failed", evidence: report.errors[report.errors.length - 1] });
  }
  report.durationMs = Date.now() - startedAt;
  return report;
};
