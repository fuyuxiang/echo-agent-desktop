// Fixed WK child factory. Uses actual cached services; never supplies a service,
// production bridge response, arbitrary path, JavaScript, shell text, or model.
((scope) => {
  if (!scope || scope.kind !== 'ide-git-boundary' || scope.schema !== 1 || !/^[a-f0-9]{32}$/.test(scope.generation ?? '')
    || typeof scope.nonce !== 'string' || scope.nonce.length < 24 || window.parent === window
    || location.protocol !== 'http:' || location.hostname !== '127.0.0.1') return;
  let bootstrap;
  try { bootstrap = window.name.startsWith('echo-embed:') ? JSON.parse(window.name.slice(11)) : null; } catch { return; }
  if (!bootstrap?.parentOrigin || !bootstrap.bridgeToken || !bootstrap.embedToken) return;
  const parentOrigin = bootstrap.parentOrigin, instance = crypto.randomUUID(), resolvedServices = {};
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const declared = (value, name, getter = false) => {
    const seen = new Set();
    for (let current = value; current && !seen.has(current); current = Object.getPrototypeOf(current)) {
      seen.add(current); const descriptor = Object.getOwnPropertyDescriptor(current, name);
      if (descriptor) return getter ? typeof descriptor.get === 'function' : typeof descriptor.value === 'function';
    }
    return false;
  };
  const interfaces = {
    WorkspaceService: value => declared(value, 'tryGetRoots') && declared(value, 'getWorkspaceRootUri')
      && declared(value, 'isWorkspaceFile') && declared(value, 'roots', true),
    EditorManager: value => declared(value, 'open') && declared(value, 'getByUri') && declared(value, 'onActiveEditorChanged')
      && ['code-editor-opener', 'editor-preview-widget'].includes(value.id),
    CommandRegistry: value => declared(value, 'executeCommand') && declared(value, 'getCommand')
      && declared(value, 'registerCommand') && declared(value, 'commandIds', true),
    TerminalService: value => declared(value, 'newTerminal') && declared(value, 'open')
      && declared(value, 'getByTerminalId') && declared(value, 'getDefaultShell'),
    ScmService: value => declared(value, 'registerScmProvider') && declared(value, 'findRepository')
      && declared(value, 'repositories', true) && declared(value, 'selectedRepository', true),
  };
  const service = name => {
    const matches = new Set(), inspected = new Set(), containers = new Set(); let rejected = 0;
    for (let current = window.theia?.container; current && !containers.has(current); current = current.parent) {
      containers.add(current);
      current._bindingDictionary?.traverse((_key, bindings) => {
        for (const { cache } of bindings) {
          if (!cache || typeof cache !== 'object' || inspected.has(cache)) continue;
          inspected.add(cache); try { if (interfaces[name](cache)) matches.add(cache); } catch { rejected++; }
        }
      });
    }
    assert(matches.size === 1, `Cached ${name} has ${matches.size} matching instances; ${rejected} unsafe introspections rejected`);
    resolvedServices[name] = { matchingInstances: 1, rejectedIntrospectionCandidates: rejected,
      resolvedFrom: 'actual container cache and stable public interfaces' };
    return [...matches][0];
  };
  const wait = async (check, label, milliseconds = 30000) => {
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(100); }
    throw new Error(`Actual IDE operation timed out: ${label}`);
  };
  let editor, worktreeEditor, busy = false;
  const roots = async (allowManagedWorktree = false) => {
    await wait(() => window.theia?.container && document.querySelector('#theia-app-shell'), 'IDE shell');
    const values = await service('WorkspaceService').roots;
    const path = values[0]?.resource.path.fsPath();
    const managed = typeof path === 'string' && path.startsWith(`${scope.home}/coding-worktrees/`)
      && /^[a-f0-9-]{36}\/worktree$/.test(path.slice(`${scope.home}/coding-worktrees/`.length));
    assert(values.length === 1 && (path === scope.cwd || (allowManagedWorktree && managed)), 'Actual IDE workspace differs from the fixed fixture');
    return values;
  };
  const editorState = () => {
    assert(editor?.editor?.uri.path.fsPath() === `${scope.cwd}/${scope.file}`, 'Editor escaped the fixed file');
    const model = editor.editor.getControl().getModel(); assert(model, 'Actual Monaco model missing');
    return { text: model.getValue(), dirty: editor.saveable?.dirty ?? editor.editor.document.dirty,
      path: editor.editor.uri.path.fsPath(), visible: editor.node.getClientRects().length > 0 };
  };
  const gitRepository = () => {
    const repositories = service('ScmService').repositories.filter(repository => {
      try { return decodeURIComponent(new URL(repository.provider.rootUri).pathname) === scope.cwd; } catch { return false; }
    });
    assert(repositories.length === 1 && repositories[0].provider.id === 'git', 'No unique actual Git provider for the fixed repository');
    return repositories[0];
  };
  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.origin !== parentOrigin || event.data?.type !== 'echo/native-ide-git-operation'
      || event.data.nonce !== scope.nonce || event.data.generation !== scope.generation || typeof event.data.id !== 'string' || busy) return;
    const request = event.data; busy = true;
    void (async () => {
      try {
        const actualRoots = await roots(request.action.startsWith('worktree-')), commands = service('CommandRegistry'); let value;
        if (request.action === 'metadata') {
          const required = ['git.refresh', 'git.openChange', 'git.stageAll', 'git.commitStaged'];
          await wait(() => required.every(id => commands.getCommand(id)), 'actual Git command registration', 60000);
          const repository = await wait(() => { try { return gitRepository(); } catch { return null; } }, 'actual Git SCM provider', 60000);
          await wait(() => commands.getActiveHandler('git.refresh'), 'actual Git handler activation', 60000);
          await commands.executeCommand('git.refresh');
          value = { root: scope.cwd, gitCommands: required, provider: { id: repository.provider.id, label: repository.provider.label,
            rootUri: repository.provider.rootUri }, resolvedServices };
        } else if (request.action === 'worktree-metadata') {
          const path = actualRoots[0].resource.path.fsPath();
          assert(path !== scope.cwd, 'Application did not switch into an isolated worktree');
          value = { root: path, filesVisible: !!document.querySelector('#files'), resolvedServices };
        } else if (['worktree-open', 'worktree-open-saved', 'worktree-dirty', 'worktree-state'].includes(request.action)) {
          const root = actualRoots[0].resource.path.fsPath();
          assert(root !== scope.cwd, 'Expected an actual managed worktree');
          if (request.action.startsWith('worktree-open')) {
            worktreeEditor = await service('EditorManager').open(actualRoots[0].resource.resolve(scope.file));
          }
          assert(worktreeEditor?.editor?.uri.path.fsPath() === `${root}/${scope.file}`, 'Worktree editor escaped the exact fixture');
          const control = worktreeEditor.editor.getControl();
          await wait(() => control.getModel(), 'actual worktree Monaco model');
          if (request.action === 'worktree-dirty') {
            assert(control.getModel().getValue() === scope.version2, 'Worktree must start at committed version2');
            control.executeEdits('private-worktree-switch', [{ range: control.getModel().getFullModelRange(), text: scope.version1, forceMoveMarkers: true }]);
            await wait(() => worktreeEditor.editor.document.dirty, 'actual worktree dirty edit');
          }
          value = { root, path: worktreeEditor.editor.uri.path.fsPath(), text: control.getModel().getValue(),
            dirty: worktreeEditor.editor.document.dirty, visible: worktreeEditor.node.getClientRects().length > 0 };
          if (request.action === 'worktree-open') assert(value.text === scope.version2 && !value.dirty, 'Worktree included uncommitted source edits');
          if (request.action === 'worktree-open-saved') assert(value.text === scope.version1 && !value.dirty, 'Saved worktree file did not reopen');
        } else if (request.action === 'open' || request.action === 'open-saved') {
          editor = await service('EditorManager').open(actualRoots[0].resource.resolve(scope.file));
          await wait(() => editor?.editor?.getControl()?.getModel(), 'real Monaco model');
          value = editorState(); assert(value.text === (request.action === 'open-saved' ? scope.version3 : scope.version2), 'Fixture has a different real editor version');
        } else if (request.action === 'search') {
          await commands.executeCommand('search-in-workspace.open');
          const input = await wait(() => document.querySelector('#search-input-field'), 'search input');
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, `IDE_CONTENT_${scope.generation}`);
          input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
          const result = await wait(() => {
            const node = document.querySelector('#search-in-workspace');
            return node?.textContent.includes(scope.file) && node.textContent.includes(`IDE_CONTENT_${scope.generation}`) ? node : null;
          }, 'real workspace content search result');
          value = { query: `IDE_CONTENT_${scope.generation}`, filename: scope.file, visible: result.getClientRects().length > 0,
            text: result.textContent.slice(-1500) };
        } else if (request.action === 'terminal') {
          const terminals = service('TerminalService');
          const terminal = await terminals.newTerminal({ title: 'Private IDE boundary terminal', cwd: scope.cwd,
            shellPath: '/bin/sh', shellArgs: [], destroyTermOnClose: true,
            env: { ENV: null, BASH_ENV: null, NODE_OPTIONS: null, NODE_PATH: null } });
          // onData is keyboard input; onOutput is actual shell output.
          // The parent additionally checks the physical process proof.
          let output = ''; const observer = terminal.onOutput(data => { output = (output + data).slice(-12000); });
          try {
            await terminal.start(); await terminals.open(terminal); terminal.sendText('node ide-terminal-proof.cjs\r');
            await wait(() => output.includes(`IDE_TERMINAL_${scope.generation}`), 'actual terminal command');
            value = { processId: await terminal.processId, visible: terminal.node.getClientRects().length > 0,
              command: 'node ide-terminal-proof.cjs', output };
          } finally { observer.dispose(); terminal.dispose(); }
        } else if (request.action === 'git-diff') {
          const repository = gitRepository();
          const resources = repository.provider.groups.flatMap(group => group.resources);
          const changed = resources.filter(resource => resource.sourceUri.path.fsPath() === `${scope.cwd}/${scope.file}`);
          assert(changed.length === 1, 'Expected exactly one real Git change');
          await changed[0].open();
          value = { changedPath: changed[0].sourceUri.path.fsPath(), scmVisible: !!document.querySelector('#scm-view-container'),
            diffVisible: [...document.querySelectorAll('.monaco-diff-editor')].some(node => node.getClientRects().length > 0) };
          assert(value.diffVisible, 'Real Git diff editor is not visible');
        } else if (request.action === 'git-stage') {
          gitRepository(); await commands.executeCommand('git.stageAll'); await commands.executeCommand('git.refresh');
          value = { command: 'git.stageAll', provider: gitRepository().provider.id };
        } else if (request.action === 'git-commit') {
          const repository = gitRepository(); repository.input.value = scope.commitMessage;
          await commands.executeCommand('git.commitStaged'); await commands.executeCommand('git.refresh');
          value = { command: 'git.commitStaged', message: scope.commitMessage, provider: gitRepository().provider.id };
        } else if (request.action === 'preview') {
          const url = new URL(scope.previewUrl);
          assert(url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.pathname === `/ide-preview/${scope.generation}`,
            'Preview escaped its owned endpoint');
          await commands.executeCommand('mini-browser.openUrl', scope.previewUrl);
          const preview = await wait(() => document.querySelector('[id^="mini-browser:"] iframe'), 'actual preview iframe');
          value = { url: preview.src, visible: preview.getClientRects().length > 0 };
          assert(value.visible && value.url === scope.previewUrl, 'Actual preview URL differs');
        } else if (request.action === 'dirty') {
          // Git diff replaces the preview editor and disposes its Monaco
          // model. Reopen the real file through the normal EditorManager.
          editor = await service('EditorManager').open(actualRoots[0].resource.resolve(scope.file));
          await wait(() => editor?.editor?.getControl()?.getModel(), 'real file reopened after Git preview');
          assert(editorState().text === scope.version2, 'Unexpected buffer before the fixed dirty edit');
          const control = editor.editor.getControl(); control.pushUndoStop();
          control.executeEdits('private-ide-boundary', [{ range: control.getModel().getFullModelRange(), text: scope.version3, forceMoveMarkers: true }]);
          control.pushUndoStop(); await wait(() => editorState().dirty && editorState().text === scope.version3, 'real unsaved buffer');
          value = editorState();
        } else if (request.action === 'dirty-again') {
          assert(editorState().text === scope.version3 && !editorState().dirty, 'Expected the saved editor before disconnect');
          const control = editor.editor.getControl(); control.pushUndoStop();
          control.executeEdits('private-ide-disconnect', [{ range: control.getModel().getFullModelRange(), text: scope.version1, forceMoveMarkers: true }]);
          control.pushUndoStop(); await wait(() => editorState().dirty && editorState().text === scope.version1, 'real second unsaved buffer');
          value = editorState();
        } else if (request.action === 'state') value = editorState();
        else throw new Error('Unsupported fixed IDE boundary operation');
        window.parent.postMessage({ type: 'echo/native-ide-git-result', nonce: scope.nonce, generation: scope.generation,
          instance, id: request.id, ok: true, value }, parentOrigin);
      } catch (error) {
        window.parent.postMessage({ type: 'echo/native-ide-git-result', nonce: scope.nonce, generation: scope.generation,
          instance, id: request.id, ok: false, error: String(error) }, parentOrigin);
      } finally { busy = false; }
    })();
  });
})
