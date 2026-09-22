// vitest 全局 setup:为每个测试注册 jest-dom matchers 与 DOM cleanup。
// testing-library v16 在检测到 vitest afterEach 时会自动 cleanup,
// 但显式导入确保跨版本一致。
import "@testing-library/jest-dom/vitest";

// monaco-editor 0.52 的 editor.main.js 间接加载 editor.all.js,
// 后者在模块顶层就调用 document.queryCommandSupported 探测剪贴板命令。
// jsdom 没有这个 API,加载 monaco 会抛 TypeError,补 noop 让探测返回 false。
if (typeof document !== "undefined" && typeof document.queryCommandSupported !== "function") {
  document.queryCommandSupported = () => false;
}
