import "../../src/styles/index.css";
// Isolated browser review with the production sidebar shell and tooltip layers.
// No native data or application startup is needed to exercise resizing.
import React, { useEffect, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Sidebar } from "../../src/components/Sidebar";
import { SidebarResizeHandle } from "../../src/components/SidebarResizeHandle";
import { GlobalTooltip } from "../../src/components/GlobalTooltip";
import { ThemeProvider } from "../../src/components/ThemeProvider";
import { TitleBar } from "../../src/components/TitleBar";
import { SidebarLayoutContext, SIDEBAR_WIDTH_KEY, useAppSidebarLayout } from "../../src/lib/sidebar-layout";
import { useSessionsStore } from "../../src/stores/sessions-store";
import { useModalFocus } from "../../src/lib/use-modal-focus";

const query = new URLSearchParams(location.search);
const mac = query.get("platform") !== "other";
localStorage.setItem("echoagent.theme", query.get("theme") ?? "light");
localStorage.setItem(SIDEBAR_WIDTH_KEY, query.get("width") ?? "264");
document.documentElement.style.fontSize = `${Number(query.get("font") ?? 16)}px`;
useSessionsStore.setState({ independent: [], loading: false });

// TitleBar only reads window state; event subscriptions remain in memory.
let callbackId = 0;
Object.assign(window, {
  __TAURI_INTERNALS__: {
    transformCallback: () => ++callbackId,
    unregisterCallback: () => {},
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    invoke: async (command: string) => command.includes("is_maximized") ? false : command.includes("listen") ? ++callbackId : [],
  },
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
});

function ReviewModal({ onClose }: { onClose: () => void }) {
  const ref = useModalFocus<HTMLDivElement>(true, onClose);
  return <div ref={ref} role="dialog" aria-modal="true" aria-label="验证弹窗" tabIndex={-1}
    style={{ position: "fixed", inset: 80, zIndex: 10000, background: "white" }}>
    <button type="button" onClick={onClose}>关闭弹窗</button>
  </div>;
}

function Fixture() {
  const layout = useAppSidebarLayout();
  const [modalOpen, setModalOpen] = useState(false);
  useEffect(() => {
    const open = () => setModalOpen(true);
    window.addEventListener("review-open-modal", open);
    return () => window.removeEventListener("review-open-modal", open);
  }, []);
  useLayoutEffect(() => {
    if (query.get("collapsed") === "1") layout.setCollapsed(true);
  }, [layout.setCollapsed]);
  return <div className={`app${mac ? " app--macos" : ""}`}>
    {!mac && <TitleBar hideMenus onPlaceholder={() => {}} />}
    <SidebarLayoutContext.Provider value={layout.context}>
      <div ref={layout.bodyRef} style={layout.style} className={`app__body${layout.collapsed ? " app__body--collapsed" : ""}${layout.resizing ? " app__body--sidebar-resizing" : ""}`}>
        <Sidebar activeNav="新建任务" onNewSession={() => {}} onSelect={() => {}} onNavigate={() => {}}
          onOpenSettings={() => {}} onOpenSearch={() => {}} onToggleCollapse={() => layout.setCollapsed(true)} />
        <SidebarResizeHandle layout={layout} />
        <main className="app__main">
          {layout.collapsed && <header className="main-page-controls">
            <button className="main-topbar__btn" aria-label="展开侧边栏" onClick={() => layout.setCollapsed(false)}>☰</button>
          </header>}
          <button type="button" data-review-focus-target title="内容区帮助" style={{ position: "absolute", right: 20, bottom: 20 }}>内容区</button>
        </main>
      </div>
    </SidebarLayoutContext.Provider>
    {modalOpen && <ReviewModal onClose={() => setModalOpen(false)} />}
    <GlobalTooltip />
  </div>;
}

createRoot(document.getElementById("root")!).render(<ThemeProvider><Fixture /></ThemeProvider>);
