// Execute the production Rust-embedded DOM snapshot in jsdom. This verifies
// label semantics; it does not certify CDP, native approvals or real Chrome.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
const source = readFileSync('src-tauri/src/automation/browser.rs', 'utf8');
const snapshotSource = source.slice(source.indexOf('pub async fn snapshot('));
const script = snapshotSource.match(/const SCRIPT: &str = r#"([\s\S]*?)"#;/)?.[1];
assert(script, 'Actual production snapshot script missing');
function snapshot(html) {
  const dom = new JSDOM(html, { url: 'https://example.invalid/owned', runScripts: 'outside-only' });
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 100, height: 30 });
  // jsdom supplies textContent while a rendered browser additionally has innerText.
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', { get() { return this.textContent; } });
  try { return JSON.parse(JSON.stringify(dom.window.eval(script))); } finally { dom.window.close(); }
}
test('associated for label names a Chinese input and remains stable after typing', () => {
  for (const value of ['', 'private entered text']) {
    const result = snapshot(`<label for="review-text">本次验收文本</label><input id="review-text" value="${value}">`);
    assert.equal(result.elements[0].name, '本次验收文本');
    assert.equal(result.elements[0].tag, 'input');
  }
});
test('wrapped labels name textarea and select controls', () => {
  const result = snapshot('<label>会议说明<textarea></textarea></label><label>保存范围<select><option>个人</option></select></label>');
  assert.equal(result.elements[0].name, '会议说明');
  assert.equal(result.elements[1].name, '保存范围个人');
});
test('aria-labelledby supports multiple ids and takes precedence over aria-label', () => {
  const result = snapshot('<span id="a">审批</span><span id="b">目标</span><input aria-labelledby="missing a b" aria-label="fallback">');
  assert.equal(result.elements[0].name, '审批 目标');
});
test('existing aria-label, button text and password protections remain intact', () => {
  const result = snapshot('<label for="x">implicit</label><input id="x" aria-label="explicit"><button>确认发送</button><label for="secret">密码</label><input id="secret" type="password" value="never-leak-password">');
  assert.equal(result.elements[0].name, 'explicit');
  assert.equal(result.elements[1].name, '确认发送');
  assert.equal(result.elements[2].type, 'password');
  assert.equal(result.elements[2].value, undefined);
  assert(!JSON.stringify(result).includes('never-leak-password'));
});
test('unrelated and hidden labels do not invent interactive elements', () => {
  const result = snapshot('<label for="missing">unused</label><input aria-label="visible"><input style="display:none" aria-label="hidden">');
  assert.equal(result.elements.length, 1);
  assert.equal(result.elements[0].name, 'visible');
});
