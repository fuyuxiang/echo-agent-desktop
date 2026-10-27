import { useState } from "react";
import { ActionMenu } from "../../src/components/ActionMenu";
import { ModelSelector } from "../../src/components/ModelSelector";
import { WorkspacePicker } from "../../src/components/WorkspacePicker";

const models = [
  { id: "review/long-model-20261027", label: "用于核验很长模型名称的完整显示和自动换行".repeat(3) },
  { id: "review/short-model", label: "常用模型" },
];
export function ContentMenusReview() {
  const [expanded, setExpanded] = useState(false);
  const [modelId, setModelId] = useState(models[0].id);
  const [cwd, setCwd] = useState("/review/当前项目");
  return <div style={{ padding: 24, height: "100%", background: "var(--echo-bg-primary)", color: "var(--echo-text-strong)" }}>
    <div style={{ display: "grid", gap: 24, width: "min(100%, 360px)", marginLeft: "auto" }}>
      <h2>菜单宽度检查</h2>
      <ActionMenu label="操作菜单示例" menuLabel="操作菜单示例" trigger="操作菜单"
        contentKey={expanded ? "expanded" : "short"} onBack={expanded ? () => setExpanded(false) : undefined}
        menuClassName={`topbar-actions__menu${expanded ? " msg__export-menu" : ""}`}>
        {() => expanded ? <>
          <button type="button" role="menuitem" className="topbar-actions__item" onClick={() => setExpanded(false)}>返回</button>
          <p className="msg__export-note">含长说明的导出面板保留阅读宽度，返回简单菜单后应恢复紧凑宽度。</p>
          <button type="button" role="menuitem" className="topbar-actions__item">导出文件</button>
        </> : <>
          <button type="button" role="menuitem" className="topbar-actions__item">重命名</button>
          <button type="button" role="menuitem" className="topbar-actions__item" onClick={() => setExpanded(true)}>查看导出格式</button>
        </>}
      </ActionMenu>
      <ModelSelector modelId={modelId} models={models} onModelChange={setModelId} ariaLabel="示例模型" />
      <p data-testid="selected-model">{modelId}</p>
      <WorkspacePicker cwd={cwd} onSelectWorkspace={setCwd} workspaces={[
        { cwd: "/review/当前项目", sessionCount: 2 },
        { cwd: `/review/${"用于检查长目录名称的项目".repeat(6)}`, sessionCount: 12 },
      ]} />
    </div>
  </div>;
}
