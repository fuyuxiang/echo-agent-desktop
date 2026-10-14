// Synthetic guards for the review driver, NOT actual desktop acceptance.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const script = readFileSync(process.argv[2] || new URL('./fixtures/native-coding-frame-review.js', import.meta.url), 'utf8');
const scope = { home: '/private/tmp/isolated-native-code', nonce: 'isolated-code-guard-0123456789' };
const parentOrigin = 'tauri://localhost';
const make = ({ main = false, hostname = '127.0.0.1', bootstrap = true, config = scope, caches } = {}) => {
  const listeners = [];
  const responses = [];
  const parent = { postMessage: (message, origin) => responses.push({ message, origin }) };
  const window = { parent, name: bootstrap ? `echo-embed:${JSON.stringify({ parentOrigin, bridgeToken: 'real-bridge-scope' })}` : '',
    addEventListener: (type, listener) => listeners.push({ type, listener }) };
  if (main) window.parent = window;
  if (caches) window.theia = { container: { _bindingDictionary: {
    traverse: (callback) => caches.forEach((cache, index) => callback(Symbol(`service-${index}`), [{ cache }])),
  }, get: () => { throw new Error('A review resolver must not instantiate arbitrary bindings'); } } };
  const context = vm.createContext({ window, location: { protocol: 'http:', hostname }, setTimeout, Date,
    document: { querySelector: () => caches ? {} : null } });
  vm.runInContext(script, context)(config);
  return { listeners, responses, parent,
    send: async (data, overrides = {}) => {
      for (const { listener } of listeners) listener({ source: parent, origin: parentOrigin, data, ...overrides });
      await new Promise((resolve) => setTimeout(resolve, 0));
    } };
};

for (const options of [{ main: true }, { hostname: 'evil.example' }, { bootstrap: false },
  { config: null }, { config: { ...scope, nonce: 'short' } }]) {
  assert.equal(make(options).listeners.length, 0);
}
const frame = make();
assert.equal(frame.listeners.length, 1);
const request = { type: 'echo/native-coding-operation', nonce: scope.nonce, id: 'guard-1', action: 'open', root: '/outside' };
await frame.send({ ...request, nonce: 'wrong' });
await frame.send(request, { origin: 'https://evil.example' });
await frame.send(request, { source: {} });
assert.equal(frame.responses.length, 0);
await frame.send({ type: 'echo/before-mutation', token: 'real-bridge-scope', id: 'real-production-request' });
assert.equal(frame.responses.length, 0, 'The review helper must never replace a production host approval');
await frame.send(request);
assert.equal(frame.responses.length, 1);
assert.equal(frame.responses[0].message.ok, false);
assert.match(frame.responses[0].message.error, /outside the isolated review home/);
assert.equal(frame.responses[0].message.type, 'echo/native-coding-result');
await frame.send({ ...request, id: 'guard-2', root: `${scope.home}/../escape` });
assert.equal(frame.responses.at(-1).message.ok, false);
assert(frame.responses.every(({ message }) => message.type !== 'echo/response'));

const root = `${scope.home}/workspace`;
const file = `${root}/原生代码验收.ts`;
const makeServices = (workspaceRoot = root) => {
  let opened = 0;
  const resource = { path: { fsPath: () => workspaceRoot }, resolve: (name) => `${workspaceRoot}/${name}` };
  // Deliberately minified names and duplicate aliases for the same cached
  // instance. These synthetic services prove only the review resolver guards.
  const workspace = new (class a {
    get roots() { return Promise.resolve([{ resource }]); }
    tryGetRoots() { return [{ resource }]; }
    getWorkspaceRootUri() { return resource; }
    isWorkspaceFile() { return false; }
    get onWorkspaceChanged() { return () => {}; }
  })();
  const manager = new (class b {
    id = 'code-editor-opener';
    onCurrentEditorChanged() {}
    onActiveEditorChanged() {}
    getByUri() {}
    async open(uri) {
      assert.equal(uri, file);
      opened += 1;
      return { node: { getClientRects: () => [{}] }, saveable: { dirty: false }, editor: {
        uri: { path: { fsPath: () => file } },
        getControl: () => ({ getModel: () => ({ getValue: () => `// EchoAgent 原生代码验收\nexport const 验收值 = 1;\n// ${'x'.repeat(600)}\n` }) }),
      } };
    }
  })();
  return { workspace, manager, opened: () => opened };
};
const services = makeServices();
const minified = make({ caches: [services.workspace, services.workspace, services.manager] });
await minified.send({ ...request, id: 'minified-services', root });
assert.equal(minified.responses.at(-1).message.ok, true);
assert.equal(services.opened(), 1);
assert.equal(minified.responses.at(-1).message.value.resolvedServices.WorkspaceService.constructorName, 'a');
assert.equal(minified.responses.at(-1).message.value.resolvedServices.EditorManager.matchingInstances, 1);
// The production browser includes editor-preview, whose frontend module
// rebinds EditorManager to the real singleton EditorPreviewManager.
const previewServices = makeServices();
previewServices.manager.id = 'editor-preview-widget';
const preview = make({ caches: [previewServices.workspace, previewServices.manager, previewServices.manager] });
await preview.send({ ...request, id: 'production-preview-manager', root });
assert.equal(preview.responses.at(-1).message.ok, true, 'The real production preview manager must be accepted');
assert.equal(previewServices.opened(), 1);
assert.equal(preview.responses.at(-1).message.value.resolvedServices.EditorManager.matchingInstances, 1);
const otherPreviewServices = makeServices();
otherPreviewServices.manager.id = 'editor-preview-widget';
const ambiguousEditors = make({ caches: [previewServices.workspace, previewServices.manager, otherPreviewServices.manager] });
await ambiguousEditors.send({ ...request, id: 'ambiguous-preview-managers', root });
assert.equal(ambiguousEditors.responses.at(-1).message.ok, false);
assert.match(ambiguousEditors.responses.at(-1).message.error, /EditorManager has 2 matching instances/);
const ambiguousServices = makeServices();
const ambiguous = make({ caches: [services.workspace, ambiguousServices.workspace, services.manager] });
await ambiguous.send({ ...request, id: 'ambiguous-services', root });
assert.equal(ambiguous.responses.at(-1).message.ok, false);
assert.match(ambiguous.responses.at(-1).message.error, /2 matching instances/);
const wrongRootServices = makeServices(`${scope.home}/other-workspace`);
const wrongRoot = make({ caches: [wrongRootServices.workspace, wrongRootServices.manager] });
await wrongRoot.send({ ...request, id: 'wrong-workspace', root });
assert.equal(wrongRoot.responses.at(-1).message.ok, false);
assert.match(wrongRoot.responses.at(-1).message.error, /opened a different workspace/);
assert.equal(wrongRootServices.opened(), 0);
const missingServices = makeServices();
missingServices.manager.id = 'different-opener';
const missing = make({ caches: [missingServices.workspace, missingServices.manager] });
await missing.send({ ...request, id: 'missing-editor-manager', root });
assert.equal(missing.responses.at(-1).message.ok, false);
assert.match(missing.responses.at(-1).message.error, /EditorManager has 0 matching instances/);
assert.equal(missingServices.opened(), 0);
const rpc = new Proxy({}, { get: () => () => {} });
assert.equal(typeof rpc.tryGetRoots, 'function', 'The old typeof check falsely matches RPC methods');
assert.equal(typeof rpc.onWorkspaceChanged, 'function');
const realWithRpc = makeServices();
const proxyFrame = make({ caches: [...Array.from({ length: 25 }, () => new Proxy({}, { get: () => () => {} })),
  realWithRpc.workspace, realWithRpc.manager] });
await proxyFrame.send({ ...request, id: 'real-and-rpc-services', root });
assert.equal(proxyFrame.responses.at(-1).message.ok, true);
assert.equal(realWithRpc.opened(), 1);
assert.equal(proxyFrame.responses.at(-1).message.value.resolvedServices.WorkspaceService.matchingInstances, 1);
const onlyRpc = make({ caches: [rpc] });
await onlyRpc.send({ ...request, id: 'rpc-only-services', root });
assert.equal(onlyRpc.responses.at(-1).message.ok, false);
assert.match(onlyRpc.responses.at(-1).message.error, /WorkspaceService has 0 matching instances/);
// Theia preference proxies return {} for undeclared descriptors. JavaScript
// rejects that non-configurable descriptor for an absent target property.
const invalidDescriptor = new Proxy({}, { getOwnPropertyDescriptor: () => ({}) });
assert.throws(() => Object.getOwnPropertyDescriptor(invalidDescriptor, 'tryGetRoots'), TypeError);
const revoked = Proxy.revocable({}, {});
revoked.revoke();
const throwingPrototype = new Proxy({}, { getPrototypeOf: () => { throw new TypeError('Unavailable prototype'); } });
for (const [label, unsafe] of [['invalid-descriptor', invalidDescriptor], ['revoked', revoked.proxy],
  ['throwing-prototype', throwingPrototype]]) {
  const actual = makeServices();
  const guarded = make({ caches: [unsafe, unsafe, actual.workspace, actual.manager] });
  await guarded.send({ ...request, id: `real-with-${label}`, root });
  assert.equal(guarded.responses.at(-1).message.ok, true, `${label} must not abort scanning real declared services`);
  assert.equal(actual.opened(), 1);
  assert.equal(guarded.responses.at(-1).message.value.resolvedServices.WorkspaceService.rejectedIntrospectionCandidates, 1);
  assert.equal(guarded.responses.at(-1).message.value.resolvedServices.EditorManager.rejectedIntrospectionCandidates, 1);
}
const unsafeOnly = make({ caches: [invalidDescriptor, revoked.proxy, throwingPrototype] });
await unsafeOnly.send({ ...request, id: 'unsafe-proxies-only', root });
assert.equal(unsafeOnly.responses.at(-1).message.ok, false);
assert.match(unsafeOnly.responses.at(-1).message.error, /WorkspaceService has 0 matching instances; 3 candidates rejected unsafe introspection/);
console.log('Synthetic coding helper guards passed: 23 cases. No native application, real editor, or Rust host was exercised.');
