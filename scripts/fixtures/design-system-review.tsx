import { useState } from "react";
import { Button, IconButton } from "../../src/components/Button";

/** Exercises the production controls and compatibility classes; no test CSS. */
export function DesignSystemReview() {
  const [loading, setLoading] = useState(false);
  return <div className="app"><main style={{ padding: 24, display: "flex", alignItems: "start", flexDirection: "column", gap: 16 }}>
    <Button variant="primary" loading={loading} onClick={() => setLoading(true)}>保存这段较长的说明</Button>
    <button className="btn btn--primary">保存</button>
    <button className="form-button form-button--primary">保存</button>
    <button className="capability-button capability-button--primary">保存</button>
    <button className="settings-btn settings-btn--primary">保存</button>
    <button className="atm-btn atm-btn--primary">保存</button>
    <Button size="compact">行内操作</Button>
    <Button size="large" variant="brand">品牌操作</Button>
    <Button disabled>不可用</Button>
    <Button variant="danger">删除记录</Button>
    <IconButton label="关闭面板">×</IconButton>
    <input className="form-control" aria-label="名称" placeholder="输入名称" />
    <select className="form-control" aria-label="工作区"><option>团队共享文档与项目交付存储工作区</option></select>
    <input className="form-control" aria-label="只读名称" readOnly value="已保存的工作区" />
    <input className="form-control" aria-label="错误名称" aria-invalid="true" defaultValue="需要修正的名称" />
  </main></div>;
}
