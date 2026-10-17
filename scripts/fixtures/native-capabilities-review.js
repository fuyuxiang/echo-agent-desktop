// Fixed native acceptance: actual personal-memory controls, marketplace
// controls/Runtime reload, and the real wall-clock scheduler. No IPC replacement,
// model response, hook, run record or scheduler time is injected.
((scope) => {
  if (window.__echoNativeCapabilitiesStarted) return;
  window.__echoNativeCapabilitiesStarted = true;
  let invoke;
  let modelId = 'echoagent-ojlab/chat-qwen';
  const markerKey = 'echoagent.native-capabilities-review.v1';
  const required = {
    'first-launch': ['cap-isolation', 'cap-model-session', 'cap-memory-seed', 'cap-memory-delete', 'cap-memory-recreate',
      'cap-git-add', 'cap-git-install', 'cap-git-refresh-recovery', 'cap-git-update', 'cap-git-uninstall', 'cap-git-reinstall', 'cap-git-remove',
      'cap-schedule-config', 'cap-schedule-once-due', 'cap-schedule-recurring-first', 'cap-schedule-recurring-second', 'cap-schedule-pause'],
    restart: ['cap-isolation', 'cap-memory-restored', 'cap-git-revoked-restored', 'cap-schedule-restored', 'cap-schedule-reply-restored'],
  };
  const report = { version: 1, kind: 'capabilities', passed: false, phase: null, nativeContext: null,
    checks: [], errors: [], steps: [], activeStep: 'scope', expected: null,
    environment: 'actual native WebView + production UI/IPC/Runtime + owned TLS Git remote + real wall-clock scheduler',
    defaultHomeChanged: false, timeInjected: false, manualRunRequested: false, externalAccountRequested: false };
  const deadline = Date.now() + 75 * 60 * 1000;
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const visible = (element) => !!element?.isConnected && !element.closest('[hidden]') && element.getClientRects().length > 0;
  const record = (id, evidence) => report.checks.push({ id, result: 'passed', evidence });
  const canonical = (value) => typeof value === 'string' && /^\/(?:[^/]+\/)*[^/]+$/.test(value)
    && !/[\x00-\x1f]/.test(value) && !value.split('/').some((part) => part === '.' || part === '..') ? value : null;
  const allowed = new Set(['desktop_review_context', 'desktop_review_capabilities_manifest', 'path_stat', 'read_text_file',
    'write_text_file', 'memory_list', 'memory_get', 'agent_auth_status', 'agent_list_all_sessions',
    'agent_list_pending_interactions', 'agent_session_info', 'marketplace_list', 'plugins_list', 'skills_list', 'commands_list',
    'automations_snapshot', 'automations_save', 'automations_set_status', 'permission_mode_get']);
  const bounded = async (operation, label, timeout = 25000) => {
    report.activeStep = label;
    const remaining = Math.min(timeout, deadline - Date.now());
    assert(remaining > 0, 'Native capabilities review exceeded its 75-minute deadline');
    let timer;
    try { return await Promise.race([Promise.resolve().then(operation), new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${remaining}ms`)), remaining);
    })]); } finally { clearTimeout(timer); }
  };
  const call = (name, args = {}, timeout) => {
    assert(allowed.has(name), `Unexpected capabilities command: ${name}`);
    if (name === 'write_text_file') assert(args.workspaceRoot === report.expected?.cwd
      && ['.capabilities-git-update.json', '.capabilities-git-v2.json', '.capabilities-git-fail.json', '.capabilities-git-recover.json']
        .some((name) => args.path === `${args.workspaceRoot}/${name}`),
    'Only the fixed resource-control/physical-observation handoffs may be written');
    if (name === 'automations_set_status') assert(report.expected?.automations?.some((item) => item.id === args.id)
      && args.status === 'PAUSED', 'Only owned scheduled tasks may be paused');
    return bounded(() => invoke(name, args), `Native IPC: ${name}`, timeout);
  };
  const waitFor = async (check, label, timeout = 25000, interval = 150) => {
    report.steps.push({ step: label, at: new Date().toISOString() });
    const end = Math.min(deadline, Date.now() + timeout);
    while (Date.now() < end) {
      const value = await bounded(check, label, Math.min(25000, end - Date.now()));
      report.activeStep = label;
      if (value) return value;
      await delay(Math.min(interval, Math.max(0, end - Date.now())));
    }
    throw new Error(`Timed out waiting for actual capabilities step: ${label}`);
  };
  const button = (root, label) => [...(root?.querySelectorAll('button') || [])]
    .find((element) => visible(element) && !element.disabled && element.textContent.trim() === label);
  const click = async (root, label) => (await waitFor(() => button(typeof root === 'function' ? root() : root, label), `UI: ${label}`)).click();
  const value = (element, text) => {
    assert(visible(element) && !element.disabled, 'Actual form control is unavailable');
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, text);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  };
  const ensureSidebar = async () => {
    if (document.querySelector('.app__body--collapsed')) {
      const control = await waitFor(() => {
        const element = document.querySelector('button[aria-label="展开侧边栏"]');
        return visible(element) && !element.disabled ? element : null;
      }, 'UI: expand visible sidebar');
      control.click();
      await waitFor(() => !document.querySelector('.app__body--collapsed'), 'UI: sidebar expanded');
    }
  };
  const nav = async (label) => { await ensureSidebar(); await click(() => document.querySelector('.sidebar__nav'), label); };
  const settings = () => document.querySelector('.settings-modal-overlay');
  const memoryPanel = () => settings()?.querySelector('.resources-panel');
  const memoryRow = () => [...(memoryPanel()?.querySelectorAll('.resources-panel__item') || [])]
    .find((element) => element.querySelector('.resources-panel__item-path')?.textContent === 'MEMORY.md'
      && element.querySelector('.resources-panel__item-scope')?.textContent === '全局');
  const openMemory = async () => {
    await ensureSidebar();
    (await waitFor(() => {
      const element = document.querySelector('.sidebar__icon-btn[aria-label="设置"]');
      return visible(element) && !element.disabled ? element : null;
    }, 'UI: Settings entry')).click();
    await click(() => settings()?.querySelector('.settings-navigation'), '记忆');
    await click(() => settings()?.querySelector('[role="group"][aria-label="记忆视图"]'), '个人记忆');
    await waitFor(() => visible(memoryPanel()) && !memoryPanel().querySelector('[role="alert"]')
      && !memoryPanel().textContent.includes('加载中…'), 'UI: personal memory loaded');
    const documents = await waitFor(() => [...memoryPanel().querySelectorAll('[role="tab"]')]
      .find(element => visible(element) && element.textContent.trim().startsWith('长期记忆文档')), 'UI: long-term documents tab');
    if (documents.getAttribute('aria-selected') !== 'true') documents.click();
  };
  const closeSettings = async () => {
    const element = settings()?.querySelector('button[aria-label="关闭设置"]');
    assert(visible(element) && !element.disabled, 'Actual Settings close is unavailable');
    element.click(); await waitFor(() => !visible(settings()), 'UI: Settings closed');
  };
  const confirm = async (title, label) => {
    const dialog = await waitFor(() => [...document.querySelectorAll('[role="alertdialog"]')]
      .find((element) => visible(element) && element.textContent.includes(title)), `UI: confirmation ${title}`);
    await click(dialog, label);
    await waitFor(() => !visible(dialog), `UI: confirmed ${label}`);
  };
  const fixedProof = async () => {
    const proof = await call('desktop_review_capabilities_manifest');
    assert(proof.manifest?.schema === 1 && proof.manifest.home === scope.home
      && proof.manifest.cwd === `${scope.home}/workspaces/default`, 'Fixed manifest changed its owned scope');
    assert(proof.globalMemory?.path === `${scope.home}/memory/MEMORY.md`, 'Refusing to touch unowned global memory');
    assert(proof.pluginStorage?.installRoot === `${scope.home}/installed-plugins`
      && proof.pluginStorage?.cacheRoot === `${scope.home}/marketplace-cache`, 'Actual Runtime managed storage escaped this private profile');
    return proof;
  };
  const memoryEntry = async (content) => {
    const entries = await call('memory_list', { cwd: report.expected.cwd });
    const matches = entries.filter((item) => item.scope === 'global' && item.path === 'MEMORY.md');
    assert(matches.length === 1, 'Owned canonical global memory is missing or ambiguous');
    const entry = matches[0];
    const raw = await call('memory_get', { scope: 'global', path: 'MEMORY.md', cwd: report.expected.cwd });
    assert(entry.scope === 'global' && entry.path === 'MEMORY.md' && entry.content === content && !entry.readOnly,
      'Canonical owned global memory differs from the fixture');
    assert(typeof raw === 'string' && raw === content, 'Actual memory_get content differs from the canonical list entry');
    return entry;
  };
  const panel = () => document.querySelector('.marketplace-panel');
  const sourceRow = () => [...(panel()?.querySelectorAll('.marketplace-source') || [])]
    .find((element) => element.querySelector('.marketplace-source__name')?.textContent === report.expected.marketplaceName);
  const pluginCard = () => [...(sourceRow()?.querySelectorAll('.mp-plugin') || [])]
    .find((element) => element.querySelector('.mp-plugin__name')?.textContent.includes(report.expected.pluginName));
  const ownCatalog = async () => {
    const catalog = await call('marketplace_list', { sessionId: report.expected.sessionId }, 60000);
    const matches = catalog.sources?.filter((item) => item.sourceUrlOrPath === report.expected.sourceUrl) || [];
    assert(matches.length === 1, 'Owned marketplace source is missing or ambiguous');
    const source = matches[0];
    assert(!source.error && source.sourceKind === 'git' && source.sourceName === report.expected.marketplaceName, 'Actual Git source failed or changed identity');
    const matchesPlugin = source.plugins?.filter((item) => item.name === report.expected.pluginName) || [];
    assert(matchesPlugin.length === 1 && source.plugins.length === 1, 'Fixture Git source contains unexpected plugin code');
    const plugin = matchesPlugin[0];
    assert(plugin.relativePath === report.expected.pluginRelativePath && !plugin.hasHooks && !plugin.hasAgents && !plugin.hasMcp
      && plugin.skillCount === 1, 'Fixture acquired unapproved executable components');
    return { source, plugin };
  };
  const ownPlugin = async (version, installed) => {
    const plugins = await call('plugins_list', { sessionId: report.expected.sessionId });
    const matches = plugins.plugins?.filter((item) => item.name === report.expected.pluginName) || [];
    if (!installed) { assert(matches.length === 0, 'Revoked/uninstalled plugin remains registered in the live Runtime'); return null; }
    assert(matches.length === 1, 'Installed plugin was not uniquely loaded in the live Runtime');
    const plugin = matches[0];
    assert(canonical(plugin.root)?.startsWith(`${scope.home}/installed-plugins/`) && plugin.version === version
      && plugin.enabled && plugin.skillCount === 1 && plugin.hookCount === 0 && plugin.mcpServerCount === 0
      && plugin.agentCount === 0, 'Actual plugin components/version/install root differ');
    return { id: plugin.id, root: plugin.root, version: plugin.version, enabled: plugin.enabled, skillCount: plugin.skillCount };
  };
  const ownCommand = async (enabled) => {
    const e = report.expected, skills = await call('skills_list', { cwd: e.cwd });
    const skill = skills.find(item => item.path?.startsWith(`${e.home}/installed-plugins/`) && item.path.includes('/fixture-notes/'));
    const commands = await call('commands_list', { sessionId: e.sessionId, cwd: e.cwd });
    const qualifiedName = `${e.pluginName}:fixture-notes`, source = `plugin:${e.pluginName}`;
    const matches = commands.filter(item => item.source === source && ['fixture-notes', qualifiedName].includes(item.name));
    assert(matches.length <= 1, 'Owned skill command is ambiguous');
    const command = matches[0], name = command?.name ?? qualifiedName;
    assert(enabled ? skill?.enabled && command : !command, `Live installed skill/command availability differs: ${JSON.stringify({
      expected: { name, enabled }, skills: skills.filter(item => item.path?.includes('/fixture-notes'))
        .map(item => ({ name: item.name, path: item.path, enabled: item.enabled, scope: item.scope })),
      commands: commands.filter(item => item.name.includes('fixture-notes')),
    })}`);
    return { name, qualifiedName, source, enabled, skillPath: skill?.path, commandPresent: Boolean(command) };
  };
  const useOwnSkill = async version => {
    const e = report.expected, command = await ownCommand(true);
    await ensureSidebar();
    const selector = `[data-session-id="${CSS.escape(e.sessionId)}"] .sidebar__conv-select`;
    (await waitFor(() => document.querySelector(selector), 'UI: extension source session')).click();
    await waitFor(() => document.querySelector(`${selector}[aria-current="page"]`), 'UI: extension session selected');
    const prompt = `/${command.name} 请只根据本次注入的技能正文回复其中的版本号。不要调用工具、访问网络或修改文件。`;
    const input = await waitFor(() => { const node = document.querySelector('.echo-composer textarea'); return visible(node) && !node.disabled ? node : null; }, 'UI: extension skill composer');
    value(input, prompt);
    (await waitFor(() => { const node = document.querySelector('.echo-composer button[aria-label="发送"]'); return visible(node) && !node.disabled ? node : null; }, 'UI: send installed skill command')).click();
    const answer = await waitFor(async () => {
      const pending = await call('agent_list_pending_interactions', { sessionId: e.sessionId });
      assert(!pending.permissions?.length && !pending.questions?.length && !pending.planApprovals?.length, 'Static skill requested unexpected tool/approval');
      const session = (await call('agent_list_all_sessions', { includeArchived: true })).find(item => item.sessionId === e.sessionId);
      assert(session && !['failed', 'stopped'].includes(session.status), 'Actual installed skill model failed');
      const user = [...document.querySelectorAll('.msg--user')].filter(visible).findLast(node => node.textContent.includes(prompt));
      if (!user || session.status !== 'completed') return null;
      const text = [...document.querySelectorAll('.msg--assistant .msg__body > .markdown-body[data-md-theme="loose"]')]
        .filter(node => visible(node) && (user.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING))
        .map(node => node.innerText).join('\n');
      return text.includes(version) ? text : null;
    }, 'UI/Runtime: installed skill actual version reply', 180000);
    assert([...document.querySelectorAll('.toolcall')].filter(visible).length === 0, 'Static skill used tools');
    await nav('扩展'); await click(() => document.querySelector('[aria-label="扩展管理"]'), '浏览市场');
    await waitFor(() => visible(pluginCard()), 'UI: return to owned marketplace plugin');
    return { ...command, sessionId: e.sessionId, prompt, version, answer: answer.slice(0, 1500), noTools: true };
  };
  const toggleOwnPlugin = async () => {
    await click(() => document.querySelector('[aria-label="扩展管理"]'), '插件');
    const row = () => [...document.querySelectorAll('.plugins-panel__item')].find(node => node.querySelector('.plugins-panel__item-name')?.textContent.includes(report.expected.pluginName));
    const buttonFor = title => row()?.querySelector(`button[title="${title}"]`);
    (await waitFor(() => { const node = buttonFor('禁用'); return visible(node) && !node.disabled ? node : null; }, 'UI: disable owned plugin')).click();
    await waitFor(async () => { const list = await call('plugins_list', { sessionId: report.expected.sessionId }); return list.plugins.find(item => item.name === report.expected.pluginName)?.enabled === false; }, 'Runtime: plugin disabled');
    const disabled = await ownCommand(false);
    (await waitFor(() => { const node = buttonFor('启用'); return visible(node) && !node.disabled ? node : null; }, 'UI: re-enable owned plugin')).click();
    await waitFor(async () => { const list = await call('plugins_list', { sessionId: report.expected.sessionId }); return list.plugins.find(item => item.name === report.expected.pluginName)?.enabled === true; }, 'Runtime: plugin re-enabled');
    const enabled = await ownCommand(true);
    await click(() => document.querySelector('[aria-label="扩展管理"]'), '浏览市场');
    await waitFor(() => visible(pluginCard()), 'UI: return after plugin toggle');
    return { disabled, enabled, ui: true };
  };
  const selectSession = async (run, prompt, reply) => {
    await ensureSidebar();
    const expand = document.querySelector('[aria-controls="sidebar-task-list"][aria-expanded="false"]');
    if (visible(expand)) expand.click();
    const selector = `[data-session-id="${CSS.escape(run.sessionId)}"] .sidebar__conv-select`;
    (await waitFor(() => { const element = document.querySelector(selector); return visible(element) ? element : null; }, 'UI: scheduled session row', 45000)).click();
    await waitFor(() => document.querySelector(`${selector}[aria-current="page"]`), 'UI: scheduled session selected');
    await waitFor(async () => {
      try { const info = await call('agent_session_info', { sessionId: run.sessionId }); return info.cwd === report.expected.cwd ? info : null; }
      catch (error) { if (!String(error).includes('尚未建立可信工作区绑定')) throw error; return null; }
    }, 'Native: scheduled resident workspace', 45000);
    const answer = await waitFor(() => {
      const user = [...document.querySelectorAll('.msg--user')].find((element) => visible(element) && element.textContent.includes(prompt));
      if (!user) return null;
      const text = [...document.querySelectorAll('.msg--assistant .msg__body > .markdown-body[data-md-theme="loose"]')]
        .filter((element) => visible(element) && (user.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING))
        .map((element) => element.innerText || '').join('\n');
      return text.includes(reply) ? text : null;
    }, 'UI: real scheduled Qwen reply', 45000);
    assert([...document.querySelectorAll('.toolcall')].filter(visible).length === 0, 'Safe scheduler prompt unexpectedly invoked tools');
    return { sessionId: run.sessionId, prompt, reply, answer: answer.slice(0, 2000), toolCalls: 0 };
  };
  const ownedRuns = async (task) => (await call('automations_snapshot')).records.filter((item) => item.automationId === task.id);
  const terminalRun = async (task, occurrence, count, timeout = 180000) => waitFor(async () => {
    const records = await ownedRuns(task);
    assert(records.length <= count, 'Scheduler dispatched duplicate or extra occurrences');
    const run = records.find((item) => item.scheduledFor === occurrence);
    if (!run || !['success', 'failed'].includes(run.status)) return null;
    assert(records.length === count && run.status === 'success' && !run.error && run.sessionId && run.cwd === report.expected.cwd
      && run.modelId === modelId && run.automationName === task.name,
    `Actual due execution failed or lost its immutable bindings: ${run.error || run.status}`);
    // The queued snapshot protects crash recovery and is deliberately cleared
    // by finalize_record. Terminal prompt bindings are checked against the real
    // visible session and the independent canonical journal, not queue payload.
    if (run.automationSnapshot != null) assert(run.automationSnapshot.id === task.id
      && run.automationSnapshot.prompt === task.prompt, 'Unexpected retained queue snapshot changed its input');
    return run;
  }, 'Native: genuine automatic scheduled occurrence', timeout, 2000);
  let active = 'cap-isolation';
  (async () => {
    try {
      await waitFor(() => {
        const actualInvoke = window.__TAURI_INTERNALS__?.invoke;
        if (typeof actualInvoke !== 'function') return false;
        invoke = actualInvoke;
        return true;
      }, 'actual native IPC bootstrap', 30000);
      assert(typeof invoke === 'function' && invoke === window.__TAURI_INTERNALS__?.invoke, 'Production Native IPC required');
      assert(canonical(scope?.home) && /\/echo-native-review-capabilities-[a-zA-Z0-9]+$/.test(scope.home)
        && /^[a-f0-9-]{72}$/.test(scope.nonce || ''), 'Dedicated private capabilities scope required');
      const context = await call('desktop_review_context'); report.nativeContext = context; report.phase = context.phase;
      assert(context.home === scope.home && context.capabilitiesRequested === true && context.evaluations === 1
        && Object.hasOwn(required, report.phase), 'Dedicated single-evaluation capabilities context required');
      const restart = report.phase === 'restart', proof = await fixedProof(), manifest = proof.manifest;
      modelId = manifest.modelId ?? modelId;
      assert(['echoagent-ojlab/chat-qwen', 'echoagent-review/claude-opus-5-5'].includes(modelId), 'Unexpected review model');
      assert(/^[a-f0-9]{64}$/.test(manifest.token) && manifest.pluginName === `echo-capabilities-review-${manifest.token.slice(0, 12)}`
        && manifest.marketplaceName === `echo-capabilities-market-${manifest.token.slice(0, 12)}`
        && manifest.pluginRelativePath === `plugins/${manifest.pluginName}`
        && manifest.caPath === `${scope.home}/capabilities-git-resource/ca.crt`
        && /^[a-f0-9]{40}$/.test(manifest.initialCommit), 'Owned Git manifest contains unexpected fields');
      const url = new URL(manifest.sourceUrl);
      assert(url.protocol === 'https:' && url.hostname === '127.0.0.1' && url.port && !url.username && !url.password && !url.search && !url.hash
        && url.pathname === `/${manifest.marketplaceName}.git`, 'Refusing an unowned Git remote');
      const stat = await call('path_stat', { path: manifest.cwd, cwd: manifest.cwd });
      assert(stat.exists && stat.kind === 'directory' && stat.absolute === manifest.cwd, 'Actual authorized workspace is not canonical');
      const saved = localStorage.getItem(markerKey);
      report.expected = restart ? JSON.parse(await call('read_text_file', {
        path: `${manifest.cwd}/.capabilities-restart-expected.json`, cwd: manifest.cwd, maxBytes: 65536,
      })) : { version: 1, ...manifest, sessionId: null, automations: [], records: [], plugins: [] };
      assert(report.expected?.version === 1 && report.expected.home === manifest.home && report.expected.cwd === manifest.cwd
        && report.expected.token === manifest.token && report.expected.sourceUrl === manifest.sourceUrl, 'Capabilities expectations do not match the manifest');
      record(active, { home: scope.home, cwd: manifest.cwd, productionInvoke: true, fixedNativeManifest: true, defaultHomeChanged: false });
      if (restart) {
        await waitFor(async () => { const auth = await call('agent_auth_status');
          return auth.ready && auth.runtimeReady && auth.synchronized && auth.runtimeModels?.includes(modelId);
        }, 'actual restored Runtime readiness', 90000);
        active = 'cap-memory-restored';
        // memory_append normalizes one note (including its outer whitespace).
        // Compare exact resulting bytes, rather than trimming actual readback.
        const entry = await memoryEntry(manifest.memoryRestoredSeed.trim());
        assert(proof.globalMemory.exists && proof.globalMemory.sha256 === entry.revision, 'Actual restored global memory proof differs');
        await openMemory(); await waitFor(() => visible(memoryRow()) && memoryRow().textContent.includes(manifest.token.slice(0, 12)), 'UI: restored owned global memory');
        await closeSettings(); record(active, { path: proof.globalMemory.path, revision: entry.revision, content: entry.content, ui: true });
        active = 'cap-git-revoked-restored';
        const catalog = await call('marketplace_list', { sessionId: null }, 60000);
        assert(!catalog.sources.some((item) => item.sourceUrlOrPath === manifest.sourceUrl), 'Revoked source returned after restart');
        const plugins = await call('plugins_list', { sessionId: null });
        assert(!plugins.plugins.some((item) => item.name === manifest.pluginName), 'Revoked plugin reloaded after restart');
        record(active, { sourceUrl: manifest.sourceUrl, pluginName: manifest.pluginName, absentFromCatalogAndRegistry: true });
        active = 'cap-schedule-restored';
        const snapshot = await call('automations_snapshot');
        assert(snapshot.automations.length === 2 && snapshot.records.length === 3, 'Restart lost or duplicated automatic task/run records');
        for (const task of report.expected.automations) {
          const restored = snapshot.automations.find((item) => item.id === task.id);
          assert(restored?.status === 'PAUSED' && !restored.nextRunAt && restored.prompt === task.prompt && restored.modelId === modelId
            && restored.cwds === manifest.cwd, 'Restored task was activated or changed');
        }
        assert(JSON.stringify([...snapshot.records].sort((a, b) => a.id.localeCompare(b.id))) === JSON.stringify([...report.expected.records].sort((a, b) => a.id.localeCompare(b.id))),
          'Automatic execution records changed during restart');
        record(active, { taskIds: report.expected.automations.map((item) => item.id), recordIds: snapshot.records.map((item) => item.id), noExtraOccurrences: true });
        active = 'cap-schedule-reply-restored';
        const run = report.expected.records.find((item) => item.automationId === report.expected.automations[0].id);
        const task = report.expected.automations[0];
        record(active, await selectSession(run, task.prompt, report.expected.onceReply));
      } else {
        assert(!saved && (await call('automations_snapshot')).automations.length === 0 && (await call('agent_list_all_sessions', { includeArchived: true })).length === 0,
          'Capabilities review requires a fresh private profile');
        active = 'cap-model-session';
        const permission = await call('permission_mode_get', { sessionId: null });
        assert(permission.permissionMode === 'ask', 'Capabilities review requires the ordinary ask permission mode');
        await waitFor(async () => { const auth = await call('agent_auth_status'); return auth.ready && auth.runtimeReady && auth.synchronized
          && auth.runtimeModels?.includes(modelId) ? true : null; }, 'Native: builtin Qwen ready', 60000);
        const composer = await waitFor(() => { const element = document.querySelector('.home .echo-composer'); return visible(element) ? element : null; }, 'UI: actual Home Composer');
        (await waitFor(() => { const element = composer.querySelector('.model-selector__trigger'); return visible(element) && !element.disabled ? element : null; }, 'UI: ready model selector')).click();
        const option = await waitFor(() => [...document.querySelectorAll('.model-selector__item')].find((element) => visible(element)
          && element.querySelector('.model-selector__item-id')?.textContent === modelId), 'UI: exact Qwen model');
        const modelLabel = option.querySelector('.model-selector__item-label')?.textContent; assert(modelLabel, 'Qwen label missing'); option.click();
        await waitFor(() => composer.querySelector('.model-selector__trigger')?.textContent.includes(modelLabel)
          && !composer.querySelector('.model-selector__trigger')?.disabled, 'UI: model switch applied');
        const warmup = `本机扩展验收准备 ${manifest.token.slice(0, 12)}：请只回复“扩展会话已准备”，不要调用工具、读取或修改文件。`;
        const input = await waitFor(() => { const element = composer.querySelector('textarea'); return visible(element) && !element.disabled ? element : null; }, 'UI: Home input');
        value(input, warmup); (await waitFor(() => { const element = composer.querySelector('button[aria-label="发送"]'); return visible(element) && !element.disabled ? element : null; }, 'UI: Home send')).click();
        const selected = () => document.querySelector('[data-session-id] .sidebar__conv-select[aria-current="page"]')?.closest('[data-session-id]')?.dataset.sessionId;
        const session = await waitFor(async () => (await call('agent_list_all_sessions', { includeArchived: true })).find((item) => item.sessionId === selected()), 'Native: real UI-created session');
        report.expected.sessionId = session.sessionId;
        assert(session.cwd === manifest.cwd && session.permissionMode === 'ask', 'Warmup session escaped owned workspace/ask permissions');
        await waitFor(async () => {
          const pending = await call('agent_list_pending_interactions', { sessionId: session.sessionId });
          assert(!pending.permissions?.length && !pending.questions?.length && !pending.planApprovals?.length && !pending.folderTrustRequests?.length, 'No-tool warmup requested tools/approval');
          const current = (await call('agent_list_all_sessions', { includeArchived: true })).find((item) => item.sessionId === session.sessionId);
          assert(current && !['failed', 'stopped'].includes(current.status), 'Actual warmup model failed'); return current.status === 'completed' ? current : null;
        }, 'Native: actual Qwen warmup complete', 180000);
        assert([...document.querySelectorAll('.toolcall')].filter(visible).length === 0, 'No-tool warmup used tools');
        record(active, { sessionId: session.sessionId, modelId, selectedViaUi: true, noTools: true });
        active = 'cap-memory-seed';
        const entry = await memoryEntry(manifest.memorySeed);
        assert(proof.globalMemory.exists && proof.globalMemory.sha256 === manifest.memorySeedSHA256
          && entry.revision === manifest.memorySeedSHA256, 'Owned memory bytes do not match the prelaunch seed; refusing deletion');
        await openMemory(); await waitFor(() => visible(memoryRow()) && memoryRow().textContent.includes(manifest.token.slice(0, 12)), 'UI: owned global memory seed');
        record(active, { path: proof.globalMemory.path, revision: entry.revision, content: entry.content, onlyOwnedSeed: true });
        active = 'cap-memory-delete';
        const remove = memoryRow().querySelector('button[title="删除"]'); assert(visible(remove) && !remove.disabled, 'Actual global memory delete unavailable');
        remove.click(); await confirm('删除全局记忆文件？', '删除记忆');
        await waitFor(async () => !(await fixedProof()).globalMemory.exists && !visible(memoryRow()), 'Native/UI: owned global memory removed');
        let missing; try { await call('memory_get', { scope: 'global', path: 'MEMORY.md', cwd: manifest.cwd }); } catch (error) { missing = String(error); }
        assert(missing, 'Deleted global memory remained readable'); record(active, { path: proof.globalMemory.path, exists: false, missingFeedback: missing.slice(0, 500), ui: true });
        active = 'cap-memory-recreate';
        await click(memoryPanel, '追加记忆到文档');
        const editor = await waitFor(() => [...document.querySelectorAll('[role="dialog"][aria-label="追加记忆到文档"]')].find(visible), 'UI: new memory editor');
        value(editor.querySelector('.memory-editor__meta select'), 'global'); value(editor.querySelector('textarea[aria-label="记忆内容"]'), manifest.memoryRestoredSeed);
        await click(editor, '添加'); await waitFor(() => !visible(editor) && visible(memoryRow()), 'UI: recreated global memory row');
        const recreated = await memoryEntry(manifest.memoryRestoredSeed.trim()), recreatedProof = await fixedProof();
        assert(recreatedProof.globalMemory.exists && recreatedProof.globalMemory.sha256 === recreated.revision, 'Recreated memory did not persist canonical bytes');
        await closeSettings(); record(active, { path: proof.globalMemory.path, revision: recreated.revision, content: recreated.content, ui: true });
        active = 'cap-git-add'; await nav('扩展'); await click(() => document.querySelector('[aria-label="扩展管理"]'), '浏览市场');
        await waitFor(() => visible(panel()) && !panel().querySelector('.panel-inline-error'), 'UI: marketplace loaded', 60000);
        await click(panel, '添加源'); value(panel().querySelector('[aria-label="市场源 Git URL"]'), manifest.sourceUrl); await click(panel, '添加');
        await waitFor(() => visible(sourceRow()) && !panel().querySelector('[aria-label="市场源 Git URL"]'), 'UI: real Git source added', 60000);
        const catalogV1 = await ownCatalog(); assert(catalogV1.plugin.version === '1.0.0' && catalogV1.plugin.installStatus !== 'installed', 'Initial Git fixture/catalog differs');
        record(active, { sourceUrl: manifest.sourceUrl, sourceName: manifest.marketplaceName, version: '1.0.0', ui: true, tlsVerified: true });
        active = 'cap-git-install'; await click(pluginCard, '安装');
        await waitFor(() => pluginCard()?.classList.contains('mp-plugin--installed') && !pluginCard()?.querySelector('.mp-plugin__busy'), 'UI: actual plugin installed', 60000);
        const v1 = await ownPlugin('1.0.0', true); report.expected.plugins.push(v1);
        const toggle = await toggleOwnPlugin(), runtimeUse = await useOwnSkill('1.0.0');
        record(active, { ...v1, toggle, runtimeUse, ui: true });
        active = 'cap-git-refresh-recovery';
        const resourceAvailability = async mode => {
          const request = { schema: 1, token: manifest.token, sourceUrl: manifest.sourceUrl, mode };
          await call('write_text_file', { path: `${manifest.cwd}/.capabilities-git-${mode}.json`, workspaceRoot: manifest.cwd,
            content: JSON.stringify(request) });
          return waitFor(async () => {
            const path = `${manifest.cwd}/.capabilities-git-${mode}-ack.json`;
            if (!(await call('path_stat', { path, cwd: manifest.cwd })).exists) return null;
            const ack = JSON.parse(await call('read_text_file', { path, cwd: manifest.cwd }));
            assert(JSON.stringify(ack) === JSON.stringify(request), 'Owned resource availability handoff differs'); return ack;
          }, `Owned Git resource ${mode}`, 45000);
        };
        await resourceAvailability('fail');
        const sourceRefresh = () => sourceRow()?.querySelector('button[title="刷新此源"]');
        assert(visible(sourceRefresh()) && !sourceRefresh().disabled, 'Source refresh unavailable'); sourceRefresh().click();
        const refreshFailure = await waitFor(() => {
          const toast = [...document.querySelectorAll('[role="status"], .toast')].filter(visible)
            .find(node => node.textContent.includes('刷新失败：') && node.textContent.includes('503'));
          return toast?.textContent;
        }, 'UI: actual failed Git refresh feedback', 60000);
        assert(visible(sourceRow()) && pluginCard()?.classList.contains('mp-plugin--installed'), 'Failed refresh removed the source/install');
        await waitFor(() => sourceRefresh() && !sourceRefresh().disabled, 'UI: failed source can retry');
        await resourceAvailability('recover'); sourceRefresh().click();
        await waitFor(() => [...document.querySelectorAll('[role="status"], .toast')].filter(visible)
          .some(node => node.textContent.includes(`已刷新「${manifest.marketplaceName}」`)), 'UI: real Git refresh retry succeeded', 60000);
        assert((await ownCatalog()).plugin.installedVersion === '1.0.0', 'Retry lost the installed version');
        record(active, { sourceUrl: manifest.sourceUrl, failedFeedback: refreshFailure, recovered: true, retainedInstalledVersion: '1.0.0', ui: true });
        active = 'cap-git-update';
        const handoff = { schema: 1, token: manifest.token, sourceUrl: manifest.sourceUrl, pluginName: manifest.pluginName, initialCommit: manifest.initialCommit, installedRoot: v1.root };
        await call('write_text_file', { path: `${manifest.cwd}/.capabilities-git-update.json`, workspaceRoot: manifest.cwd, content: JSON.stringify(handoff) });
        const ackPath = `${manifest.cwd}/.capabilities-git-update-ack.json`;
        const ack = await waitFor(async () => {
          if (!(await call('path_stat', { path: ackPath, cwd: manifest.cwd })).exists) return null;
          const bytes = await call('read_text_file', { path: ackPath, cwd: manifest.cwd });
          assert(typeof bytes === 'string', 'Actual resource handoff read returned invalid content');
          const parsed = JSON.parse(bytes);
          assert(parsed.schema === 1 && parsed.token === manifest.token && parsed.sourceUrl === manifest.sourceUrl
            && /^[a-f0-9]{40}$/.test(parsed.commit) && parsed.commit !== manifest.initialCommit, 'Resource advance handoff changed scope'); return parsed;
        }, 'Owned HTTPS Git fixture actually advanced to v2', 45000);
        const refresh = sourceRow().querySelector('button[title="刷新此源"]'); assert(visible(refresh) && !refresh.disabled, 'Source refresh unavailable'); refresh.click();
        await waitFor(() => visible(button(pluginCard(), '更新')), 'UI: actual newer Git plugin advertised', 60000); await click(pluginCard, '更新');
        await waitFor(() => pluginCard()?.classList.contains('mp-plugin--installed') && !button(pluginCard(), '更新') && !pluginCard()?.querySelector('.mp-plugin__busy'), 'UI: plugin update complete', 60000);
        const v2 = await ownPlugin('2.0.0', true), updated = await ownCatalog();
        assert(updated.plugin.installedVersion === '2.0.0' && updated.plugin.version === '2.0.0', 'Runtime/catalog update did not actually synchronize');
        report.expected.plugins.push(v2); report.expected.version2Commit = ack.commit; record(active, { ...v2, commit: ack.commit, runtimeUse: await useOwnSkill('2.0.0'), ui: true });
        await call('write_text_file', { path: `${manifest.cwd}/.capabilities-git-v2.json`, workspaceRoot: manifest.cwd,
          content: JSON.stringify({ schema: 1, token: manifest.token, sourceUrl: manifest.sourceUrl, installedRoot: v2.root, commit: ack.commit }) });
        await waitFor(async () => {
          const path = `${manifest.cwd}/.capabilities-git-v2-ack.json`;
          if (!(await call('path_stat', { path, cwd: manifest.cwd })).exists) return null;
          const bytes = await call('read_text_file', { path, cwd: manifest.cwd });
          assert(typeof bytes === 'string', 'Physical v2 receipt returned invalid content');
          const receipt = JSON.parse(bytes);
          assert(receipt.schema === 1 && receipt.token === manifest.token && receipt.installedRoot === v2.root && receipt.commit === ack.commit
            && /^[a-f0-9]{64}$/.test(receipt.manifestSha256) && /^[a-f0-9]{64}$/.test(receipt.skillSha256), 'Physical v2 receipt changed scope');
          return receipt;
        }, 'Node: actual installed v2 manifest/skill independently inspected', 45000);
        active = 'cap-git-uninstall'; await click(pluginCard, '卸载'); await confirm(`卸载插件“${manifest.pluginName}”？`, '卸载');
        await waitFor(() => visible(button(pluginCard(), '安装')), 'UI: plugin uninstalled', 60000); await ownPlugin(null, false); record(active, { pluginName: manifest.pluginName, liveRegistryAbsent: true, ui: true });
        active = 'cap-git-reinstall'; await click(pluginCard, '安装');
        await waitFor(() => pluginCard()?.classList.contains('mp-plugin--installed') && !pluginCard()?.querySelector('.mp-plugin__busy'), 'UI: own plugin reinstalled', 60000);
        const reinstall = await ownPlugin('2.0.0', true); report.expected.plugins.push(reinstall); record(active, { ...reinstall, ui: true });
        active = 'cap-git-remove'; const sourceRemove = sourceRow().querySelector('button[title="移除源"]');
        assert(visible(sourceRemove) && !sourceRemove.disabled, 'Actual source remove unavailable'); sourceRemove.click();
        await confirm(`移除市场源“${manifest.marketplaceName}”？`, '移除源'); await waitFor(() => !visible(sourceRow()), 'UI: own source removed', 60000);
        const removedCatalog = await call('marketplace_list', { sessionId: session.sessionId }, 60000);
        assert(!removedCatalog.sources.some((item) => item.sourceUrlOrPath === manifest.sourceUrl), 'Removed source still appears in actual catalog');
        await ownPlugin(null, false); record(active, { sourceUrl: manifest.sourceUrl, pluginName: manifest.pluginName, liveRegistryAbsent: true, ui: true });
        active = 'cap-schedule-config';
        const empty = await call('automations_snapshot'); assert(empty.automations.length === 0 && empty.records.length === 0, 'Refusing to mutate existing automations');
        const firstDue = new Date(Math.ceil((Date.now() + 90000) / 60000) * 60000), pad = (n) => String(n).padStart(2, '0');
        assert(firstDue.getHours() < 23, 'Two genuine hourly occurrences require a same-day window; no clock or cadence substitution permitted');
        const date = `${firstDue.getFullYear()}-${pad(firstDue.getMonth() + 1)}-${pad(firstDue.getDate())}`, time = `${pad(firstDue.getHours())}:${pad(firstDue.getMinutes())}`;
        report.expected.onceReply = `单次到点成功 ${manifest.token.slice(0, 12)}`;
        report.expected.recurringReply = `周期到点成功 ${manifest.token.slice(0, 12)}`;
        for (const [kind, reply] of [['once', report.expected.onceReply], ['recurring', report.expected.recurringReply]]) {
          const task = { id: '', name: `真实到点${kind}-${manifest.token.slice(0, 12)}`,
            prompt: `本机真实到点验收：请只回复“${reply}”。不要调用工具、读取文件、联系他人或修改任何数据。`,
            cwds: manifest.cwd, status: 'ACTIVE', modelId, modelIsThinking: false, skills: [], connectorIds: [], permissionMode: 'default',
            scheduleType: kind, schedule: { freq: 'HOURLY', interval: 1, intervalHours: 1, byday: ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'],
              bymonthday: [], bymonth: [], byhour: firstDue.getHours(), byminute: firstDue.getMinutes() },
            scheduledDate: kind === 'once' ? date : null, scheduledTime: kind === 'once' ? time : null,
            pushToWeChat: false, createdAt: '' };
          const savedTask = await call('automations_save', { automation: task }); report.expected.automations.push(savedTask);
          assert(savedTask.id && savedTask.status === 'ACTIVE' && savedTask.cwds === manifest.cwd && savedTask.modelId === modelId
            && Date.parse(savedTask.nextRunAt) === firstDue.getTime() && savedTask.prompt === task.prompt, 'Actual scheduler saved unexpected configuration/due time');
        }
        report.expected.firstDueAt = firstDue.toISOString(); localStorage.setItem(markerKey, JSON.stringify(report.expected));
        record(active, { automationIds: report.expected.automations.map((item) => item.id), firstDueAt: report.expected.firstDueAt,
          actualClock: new Date().toISOString(), manualRunRequested: false, intervalHours: 1 });
        const once = report.expected.automations[0], recurring = report.expected.automations[1];
        active = 'cap-schedule-once-due'; const firstTimeout = firstDue.getTime() - Date.now() + 150000;
        const onceRun = await terminalRun(once, once.nextRunAt, 1, firstTimeout);
        const onceTask = (await call('automations_snapshot')).automations.find((item) => item.id === once.id);
        assert(onceTask.status === 'PAUSED' && !onceTask.nextRunAt, 'One-time task did not pause after its actual due occurrence');
        const onceReply = await selectSession(onceRun, once.prompt, report.expected.onceReply); report.expected.records.push(onceRun); record(active, { record: onceRun, ...onceReply });
        active = 'cap-schedule-recurring-first'; const recurringRun = await terminalRun(recurring, recurring.nextRunAt, 1);
        const currentRecurring = (await call('automations_snapshot')).automations.find((item) => item.id === recurring.id);
        assert(currentRecurring.status === 'ACTIVE' && Date.parse(currentRecurring.nextRunAt) === firstDue.getTime() + 3600000,
          'Recurring task did not retain its actual next hourly occurrence');
        report.expected.secondDueAt = currentRecurring.nextRunAt;
        const firstReply = await selectSession(recurringRun, recurring.prompt, report.expected.recurringReply); report.expected.records.push(recurringRun); record(active, { record: recurringRun, nextRunAt: currentRecurring.nextRunAt, ...firstReply });
        active = 'cap-schedule-recurring-second';
        const secondRun = await terminalRun(recurring, currentRecurring.nextRunAt, 2, Date.parse(currentRecurring.nextRunAt) - Date.now() + 150000);
        assert(secondRun.id !== recurringRun.id && secondRun.sessionId !== recurringRun.sessionId
          && Date.parse(secondRun.scheduledFor) - Date.parse(recurringRun.scheduledFor) === 3600000, 'Second recurring run was duplicated or manually substituted');
        const secondReply = await selectSession(secondRun, recurring.prompt, report.expected.recurringReply); report.expected.records.push(secondRun); record(active, { record: secondRun, realHourlyIntervalMs: 3600000, ...secondReply });
        active = 'cap-schedule-pause'; await call('automations_set_status', { id: recurring.id, status: 'PAUSED' });
        const final = await call('automations_snapshot'); assert(final.automations.length === 2 && final.records.length === 3
          && final.automations.every((item) => item.status === 'PAUSED' && !item.nextRunAt), 'Owned automatic tasks did not pause cleanly');
        report.expected.automations = final.automations;
        report.expected.records = final.records;
        localStorage.setItem(markerKey, JSON.stringify(report.expected)); record(active, { statuses: final.automations.map((item) => ({ id: item.id, status: item.status, nextRunAt: item.nextRunAt })), automaticRunCount: 3 });
      }
      assert(report.checks.length === required[report.phase].length && required[report.phase].every((id) => report.checks.filter((item) => item.id === id).length === 1), 'Missing actual capabilities acceptance gates');
      report.passed = true;
    } catch (error) {
      report.errors.push({ check: active, activeStep: report.activeStep, error: String(error?.message || error).slice(0, 2000) });
      report.checks.push({ id: active, result: 'failed', evidence: { activeStep: report.activeStep } });
      // Best-effort production pause is limited to IDs returned by this review.
      // It never clears failed records or changes a task into a passing state.
      for (const item of report.expected?.automations || []) {
        try { await call('automations_set_status', { id: item.id, status: 'PAUSED' }); }
        catch (pauseError) { report.errors.push({ check: 'owned-task-cleanup', error: String(pauseError).slice(0, 500) }); }
      }
    } finally {
      report.finishedAt = new Date().toISOString();
      if (report.expected) localStorage.setItem(markerKey, JSON.stringify(report.expected));
      await invoke('desktop_review_complete', { report });
    }
  })();
})
