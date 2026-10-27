import { useState } from "react";
import { Toast } from "../../src/components/Toast";
import { useToastQueue } from "../../src/lib/use-toast-queue";

export function ToastReview() {
  const { toasts, enqueueToast, dismissToast, pauseToast } = useToastQueue();
  const [restored, setRestored] = useState(0);
  return <div style={{ height: "100%", background: "var(--echo-bg-primary)", color: "var(--echo-text-primary)", padding: 20 }}>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
      <button onClick={() => enqueueToast("加载失败：TypeError: Failed to fetch\nEndpoint /api/tasks unavailable; ECONNREFUSED at 127.0.0.1:8080")} >模拟连接失败</button>
      <button onClick={() => enqueueToast("已归档", [{ label: "撤销", onClick: () => setRestored(n => n + 1) }])}>归档示例</button>
      <button onClick={() => enqueueToast("对话已删除，部分记忆未能清理，请到记忆页面检查。\nSqliteError { code: BUSY, path: /review/memory }", [{ label: "查看记忆", onClick: () => setRestored(n => n + 1) }])}>模拟部分清理失败</button>
      <button onClick={() => enqueueToast("已归档“HTTP 403 问题排查”", [{ label: "撤销", onClick: () => setRestored(n => n + 1) }], undefined, "info")}>归档特殊标题</button>
      <button onClick={() => enqueueToast("已下载“TypeError.log”（2 KB）")}>下载特殊文件名</button>
    </div>
    <p aria-label="恢复次数">已恢复 {restored} 个任务</p>
    <h1 style={{ marginTop: "20vh", textAlign: "center" }}>操作反馈</h1>
    <div className="toast-stack" aria-label="操作提示">{toasts.map(toast => <Toast key={toast.id}
      message={toast.message} actions={toast.actions} kind={toast.kind} stacked onDismiss={() => dismissToast(toast.id)}
      onPause={paused => pauseToast(toast.id, paused)} onActionError={error => enqueueToast(`操作未完成：${error}`)} />)}</div>
  </div>;
}
