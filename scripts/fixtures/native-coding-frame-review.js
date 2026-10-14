// WKUserScript used only by a deliberately isolated native review. It drives
// the real Monaco buffer; it never answers Echo's host requests or saves files.
// The native installer invokes this fixed function with a private scope.
((scope) => {
  if (!scope || typeof scope.home !== 'string' || typeof scope.nonce !== 'string'
    || scope.nonce.length < 24
    || window.parent === window || location.protocol !== 'http:'
    || !['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)) return;
  let bootstrap;
  try { bootstrap = window.name.startsWith('echo-embed:') ? JSON.parse(window.name.slice(11)) : null; }
  catch { return; }
  if (!bootstrap || typeof bootstrap.parentOrigin !== 'string' || !bootstrap.bridgeToken) return;
  const parentOrigin = bootstrap.parentOrigin;
  const filename = '原生代码验收.ts';
  const source = (version) => `// EchoAgent 原生代码验收\nexport const 验收值 = ${version};\n// ${'x'.repeat(600)}\n`;
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const acknowledgements = [];
  let root = null;
  let editor = null;
  let busy = false;
  const resolvedServices = {};
  const declaredMember = (value, name, kind = 'method') => {
    const seen = new Set();
    for (let current = value; current && !seen.has(current); current = Object.getPrototypeOf(current)) {
      seen.add(current);
      const descriptor = Object.getOwnPropertyDescriptor(current, name);
      if (descriptor) return kind === 'getter'
        ? typeof descriptor.get === 'function' : typeof descriptor.value === 'function';
    }
    return false;
  };
  const service = (name) => {
    const container = window.theia?.container;
    if (!container?._bindingDictionary?.traverse) throw new Error('Theia container is not ready');
    // Production webpack minifies class/identifier names. Read only already
    // instantiated real services by their stable public API; do not instantiate
    // arbitrary bindings, replace a binding, or provide a fixture service.
    const matches = new Set();
    const inspected = new Set();
    const rejectedIntrospection = new Set();
    const seenContainers = new Set();
    for (let current = container; current && !seenContainers.has(current); current = current.parent) {
      seenContainers.add(current);
      current._bindingDictionary?.traverse((_key, bindings) => {
        for (const binding of bindings) {
          const value = binding.cache;
          if (!value || typeof value !== 'object' || inspected.has(value)) continue;
          inspected.add(value);
          try {
            const workspace = name === 'WorkspaceService'
              && declaredMember(value, 'tryGetRoots') && declaredMember(value, 'getWorkspaceRootUri')
              && declaredMember(value, 'isWorkspaceFile') && declaredMember(value, 'roots', 'getter')
              && declaredMember(value, 'onWorkspaceChanged', 'getter') && typeof value.onWorkspaceChanged === 'function';
            const manager = name === 'EditorManager'
              && declaredMember(value, 'open') && declaredMember(value, 'getByUri')
              && declaredMember(value, 'onCurrentEditorChanged') && declaredMember(value, 'onActiveEditorChanged')
              // editor-preview is enabled in the production browser and
              // rebinds EditorManager to its singleton subclass. Both IDs
              // come from actual bundled factories; uniqueness is required.
              && ['code-editor-opener', 'editor-preview-widget'].includes(value.id);
            if (workspace || manager) matches.add(value);
          } catch {
            // Some unrelated cached preference/RPC proxies reject reflection
            // (including revoked proxies and invalid descriptor traps). They
            // are not safely declared services. Exclude them, without catching
            // errors from the selected real service's roots or editor.open.
            rejectedIntrospection.add(value);
          }
        }
      });
    }
    if (matches.size !== 1) throw new Error(`Theia cached service ${name} has ${matches.size} matching instances; ${rejectedIntrospection.size} candidates rejected unsafe introspection`);
    const value = [...matches][0];
    resolvedServices[name] = { constructorName: value.constructor?.name, matchingInstances: matches.size,
      rejectedIntrospectionCandidates: rejectedIntrospection.size,
      resolvedFrom: 'actual container cache and stable public interfaces' };
    return value;
  };
  const waitFor = async (check, timeout = 30000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const result = await check();
      if (result) return result;
      await delay(100);
    }
    throw new Error('Timed out waiting for the actual Theia editor');
  };
  const state = () => {
    if (!editor) throw new Error('The review editor has not been opened');
    const control = editor.editor.getControl();
    const model = control.getModel();
    if (editor.editor.uri.path.fsPath() !== `${root}/${filename}` || !model) {
      throw new Error('The editor no longer belongs to the isolated review file');
    }
    return { text: model.getValue(), dirty: editor.saveable?.dirty ?? editor.editor.document.dirty,
      path: editor.editor.uri.path.fsPath(), acknowledgements: acknowledgements.slice(-50),
      resolvedServices,
      visible: editor.node.getClientRects().length > 0 };
  };
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.origin !== parentOrigin
      || !event.data || typeof event.data !== 'object') return;
    const message = event.data;
    // Observe the actual product responses. Do not synthesize an approval,
    // replace postMessage, change a service binding, or write to the backend.
    if (message.type === 'echo/response' && message.token === bootstrap.bridgeToken && typeof message.id === 'string') {
      acknowledgements.push({ id: message.id, ok: message.ok === true,
        error: typeof message.error === 'string' ? message.error : undefined });
      return;
    }
    if (message.type !== 'echo/native-coding-operation' || message.nonce !== scope.nonce
      || typeof message.id !== 'string' || busy) return;
    busy = true;
    void (async () => {
      try {
        if (message.action === 'open') {
          if (root) throw new Error('The isolated editor scope has already been bound');
          const requested = message.root;
          if (typeof requested !== 'string' || !requested.startsWith(`${scope.home}/`)
            || requested.includes('..') || requested.includes('\0')) {
            throw new Error('The requested workspace is outside the isolated review home');
          }
          await waitFor(() => window.theia?.container && document.querySelector('#theia-app-shell'));
          const workspace = service('WorkspaceService');
          const roots = await workspace.roots;
          if (roots.length !== 1 || roots[0].resource.path.fsPath() !== requested) {
            throw new Error('Theia opened a different workspace');
          }
          root = requested;
          editor = await service('EditorManager').open(roots[0].resource.resolve(filename));
          await waitFor(() => editor?.editor?.getControl()?.getModel());
          if (state().text !== source(1) && state().text !== source(2)) {
            throw new Error('The existing review file has unexpected contents');
          }
        } else if (message.action === 'edit') {
          if (![2, 3].includes(message.version)) throw new Error('Unsupported review edit');
          const before = state();
          if (before.text !== source(message.version - 1)) throw new Error('Unexpected editor revision before edit');
          const control = editor.editor.getControl();
          control.pushUndoStop();
          control.executeEdits('echo-native-review', [{ range: control.getModel().getFullModelRange(),
            text: source(message.version), forceMoveMarkers: true }]);
          control.pushUndoStop();
          await waitFor(() => state().text === source(message.version));
        } else if (message.action === 'undo-rejected-edit') {
          if (state().text !== source(3)) throw new Error('Only the rejected third revision may be undone');
          await editor.editor.getControl().getModel().undo();
          await waitFor(() => state().text === source(2));
        } else if (message.action !== 'state') throw new Error('Unsupported review action');
        window.parent.postMessage({ type: 'echo/native-coding-result', nonce: scope.nonce,
          id: message.id, ok: true, value: state() }, parentOrigin);
      } catch (error) {
        window.parent.postMessage({ type: 'echo/native-coding-result', nonce: scope.nonce,
          id: message.id, ok: false, error: String(error) }, parentOrigin);
      } finally { busy = false; }
    })();
  });
})
