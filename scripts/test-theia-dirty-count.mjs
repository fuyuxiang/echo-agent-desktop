// Execute the exact production method compiled with TypeScript. Saveable
// discovery is a unit adapter; native buffer/save evidence is separate.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
const require = createRequire(import.meta.url), ts = require('typescript');
const path = 'vendor/theia-platform/examples/echo-coding-bridge/src/browser/echo-frontend-contribution.ts';
const text = readFileSync(path, 'utf8'), source = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true);
let method;
function visit(node) {
  if (ts.isMethodDeclaration(node) && node.name.getText(source) === 'dirtyCount') method = node.getText(source);
  ts.forEachChild(node, visit);
}
visit(source); assert(method, 'Actual dirtyCount method missing');
const compiled = ts.transpileModule(`class ActualContribution { ${method} }; ActualContribution`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const Saveable = { get: widget => widget.saveable, getDirty: widget => widget.saveable?.dirty ? widget.saveable : undefined,
  isDirty: widget => !!widget.saveable?.dirty };
function count(widgets) { const ActualContribution = runInNewContext(compiled, { Saveable });
  const instance = new ActualContribution(); instance.shell = widgets == null ? undefined : { widgets }; return instance.dirtyCount(); }
test('same dirty document in file and diff widgets counts as one saveable', () => {
  const shared = { dirty: true }; assert.equal(count([{ saveable: shared }, { saveable: shared }]), 1);
});
test('independent dirty documents retain independent counts', () => {
  assert.equal(count([{ saveable: { dirty: true } }, { saveable: { dirty: true } }, { saveable: { dirty: false } }, {}]), 2);
});
test('empty or uninitialized shells have no dirty saveable', () => {
  assert.equal(count([]), 0); assert.equal(count(undefined), 0);
});
