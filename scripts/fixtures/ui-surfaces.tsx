// Development-only visual fixture. Native calls use isolated in-memory data;
// this module is never imported by the production entry point.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "../../src/components/ThemeProvider";
import { SettingsPanel, type SettingsSectionId } from "../../src/components/SettingsPanel";
import { PlaceholderPage } from "../../src/components/PlaceholderPage";
import { WorkbenchIdentity } from "../../src/features/coding/shell/WorkbenchIdentity";
import { ProjectSwitcher } from "../../src/features/coding/shell/ProjectSwitcher";
import "../../src/styles/global.css";
import "../../src/styles/app.css";
import "../../src/styles/automation-echo.css";
import "../../src/styles/visual-polish.css";
import "../../src/styles/form-controls.css";
import "../../src/styles/coding-workbench.css";

const query = new URLSearchParams(location.search);
localStorage.setItem("echoagent.theme", query.get("theme") ?? "light");
let memory = { enabled: true, initialInjectionEnabled: true, saveOnEnd: true, watcherEnabled: true,
  autoFlushEnabled: true, dreamEnabled: true, retrievalMode: "local", revision: "1",
  retrievalSummary: "仅在本机进行全文检索；摘要和整理仍使用会话模型" };
let providers: unknown[] = [];
let channels: unknown[] = [];
let agents: unknown[] = [];
let rules: unknown[] = [];
const callbacks = new Map();
Object.assign(window, {
  __TAURI_INTERNALS__: {
    transformCallback: (callback: unknown) => { const id = callbacks.size + 1; callbacks.set(id, callback); return id; },
    unregisterCallback: (id: number) => callbacks.delete(id),
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    invoke: async (command: string, args: any = {}) => {
      switch (command) {
        case "memory_config_get": return memory;
        case "memory_config_save": memory = { ...memory, ...args.memory }; return memory;
        case "permission_list": return rules;
        case "permission_save": rules = args.rules; return;
        case "automation_capabilities": return { browser: { available: true, browserName: "Chrome" }, computer: { available: true, platform: "macos", screenCapture: true, inputControl: true } };
        case "storage_providers_list": return providers;
        case "storage_provider_upsert": providers = [args.config]; return;
        case "notify_channels_list": return channels;
        case "notify_channel_upsert": channels = [...channels, args.channel]; return;
        case "notify_channel_test": return { ok: true };
        case "experts_default_root": return "";
        case "agents_list": return agents;
        case "agents_template": return JSON.stringify(args);
        case "agents_save": {
          const entry = { ...JSON.parse(args.raw), name: args.name, path: `/review/${args.name}.md`, scope: "user", raw: args.raw };
          agents = [...agents, entry]; return entry;
        }
        case "marketplace_list": return { sources: [], plugins: [] };
        case "plugins_list": return { plugins: [] };
        case "plugin:event|listen": return callbacks.size;
        case "plugin:event|unlisten": return;
        default: return [];
      }
    },
  },
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
});

function Fixture() {
  const surface = query.get("surface") ?? "memory";
  const [label, setLabel] = useState("专家·技能·连接器");
  const [cwd, setCwd] = useState("/review/EchoAgent");
  if (surface === "capabilities") return <PlaceholderPage label={label} onNavigate={setLabel} />;
  if (surface === "coding") return <div className="app--macos" style={{ height: "100%" }}><div className="coding-workbench coding-workbench--theia">
    <header className="coding-workbench__topbar"><WorkbenchIdentity onExit={() => {}}>
      <ProjectSwitcher activeCwd={cwd} projects={[{ cwd: "/review/EchoAgent" }, { cwd: "/review/一个名称很长但仍然可以完整查看路径的项目" }]} onSelect={setCwd} onRemove={() => {}} onOpenFolder={() => {}} />
    </WorkbenchIdentity><div /></header>
  </div></div>;
  return <SettingsPanel open initialSection={surface as SettingsSectionId} onClose={() => {}} />;
}
createRoot(document.getElementById("root")!).render(<ThemeProvider><Fixture /></ThemeProvider>);
