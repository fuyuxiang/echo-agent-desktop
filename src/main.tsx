import ReactDOM from "react-dom/client";
import { restoreUiBeforeBootstrap } from "./lib/backup-client";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { GlobalTooltip } from "./components/GlobalTooltip";
import { initializeTheme } from "./components/ThemeProvider";
import "./styles/global.css";
import "./styles/app.css";
import "./styles/automation-echo.css";
import "./styles/visual-polish.css";

async function bootstrap() {
  await restoreUiBeforeBootstrap();
  initializeTheme();
  const { default: App } = await import("./App");
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <AppErrorBoundary>
      <App />
      <GlobalTooltip />
    </AppErrorBoundary>
  );
}
void bootstrap().catch((error) => {
  const root = document.getElementById("root")!;
  const panel = document.createElement("main");
  panel.style.cssText = "padding:48px;max-width:720px;margin:auto;font:16px system-ui";
  const heading = document.createElement("h1"); heading.textContent = "启动未完成";
  const detail = document.createElement("p"); detail.textContent = `${String(error)}。请检查本机存储空间后重试；未完成的数据恢复会在下次启动时继续。`;
  const retry = document.createElement("button"); retry.textContent = "重试"; retry.onclick = () => location.reload();
  panel.append(heading, detail, retry); root.replaceChildren(panel);
});
