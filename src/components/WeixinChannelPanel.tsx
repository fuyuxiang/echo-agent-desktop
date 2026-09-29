import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import QRCode from "qrcode";
import { useAppDialog } from "./AppDialog";
import {
  weixinDisconnect, weixinQrPoll, weixinQrStart, weixinRevokeSession, weixinSetWorkspaces, weixinStatus,
  type WeixinStatus,
} from "@/lib/weixin-client";
import "./WeixinChannelPanel.css";

interface Workspace { cwd: string; sessionCount?: number }

const STATUS: Record<string, string> = {
  wait: "等待扫码…", scaned: "已扫码，请在微信确认", confirmed: "绑定成功",
  need_verifycode: "请填写微信显示的配对码", verify_code_blocked: "配对码尝试受限，请重新获取二维码",
  expired: "二维码已过期，请刷新", binded_redirect: "此 Bot 已绑定其他客户端，请先在微信解除原绑定后重试",
  scaned_but_redirect: "正在连接微信服务…",
};

export function WeixinChannelPanel({ onToast }: { onToast?: (message: string) => void }) {
  const [status, setStatus] = useState<WeixinStatus | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [qrUrl, setQrUrl] = useState("");
  const [qrImage, setQrImage] = useState("");
  const [qrStatus, setQrStatus] = useState("");
  const [verifyCode, setVerifyCode] = useState("");
  const [checkingCode, setCheckingCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const pollingGeneration = useRef<number | null>(null);
  const { requestConfirmation, dialog } = useAppDialog();

  useEffect(() => {
    let active = true;
    void Promise.all([weixinStatus(), invoke<Workspace[]>("agent_list_workspaces")])
      .then(([next, spaces]) => {
        if (!active) return;
        setStatus(next);
        setSelected(next.allowedWorkspaces);
        setWorkspaces(spaces);
      })
      .catch((cause) => { if (active) setError(String(cause)); });
    return () => { active = false; generation.current += 1; };
  }, []);

  useEffect(() => {
    if (!status?.connected) return;
    const timer = window.setInterval(() => {
      void weixinStatus().then(setStatus).catch(() => {});
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [status?.connected]);

  useEffect(() => {
    if (!qrUrl) { setQrImage(""); return; }
    let active = true;
    void QRCode.toDataURL(qrUrl, { margin: 2, width: 232 })
      .then((image) => { if (active) setQrImage(image); })
      .catch(() => { if (active) setError("二维码绘制失败，请重新获取"); });
    return () => { active = false; };
  }, [qrUrl]);

  const start = async () => {
    const current = ++generation.current;
    pollingGeneration.current = null;
    setBusy(true);
    setError("");
    setQrUrl("");
    setQrStatus("");
    setVerifyCode("");
    setCheckingCode(false);
    try {
      const result = await weixinQrStart();
      if (current !== generation.current) return;
      setQrUrl(result.qrUrl);
      setQrStatus("wait");
      void poll(current);
    } catch (cause) { if (current === generation.current) setError(String(cause)); }
    finally { if (current === generation.current) setBusy(false); }
  };

  const poll = async (current: number, code?: string) => {
    if (pollingGeneration.current === current) return;
    pollingGeneration.current = current;
    if (code) setCheckingCode(true);
    try {
      while (current === generation.current) {
        try {
          const result = await weixinQrPoll(code);
          if (current !== generation.current) return;
          setError("");
          setQrStatus(result.status);
          if (result.connected) {
            const next = await weixinStatus();
            if (current !== generation.current) return;
            setStatus(next);
            setSelected(next.allowedWorkspaces);
            setQrUrl("");
            onToast?.("微信已绑定，可以交接已有任务");
            return;
          }
          if (["expired", "verify_code_blocked", "binded_redirect"].includes(result.status)) return;
          if (result.status === "need_verifycode") return;
          code = undefined;
          if (result.status !== "wait") await new Promise((resolve) => setTimeout(resolve, 1000));
        } catch (cause) {
          if (current !== generation.current) return;
          setQrStatus("连接暂时中断，正在重试…");
          await new Promise((resolve) => setTimeout(resolve, 3000));
          if (current !== generation.current) return;
          setError(String(cause));
        }
      }
    } finally {
      if (pollingGeneration.current === current) pollingGeneration.current = null;
      if (current === generation.current) setCheckingCode(false);
    }
  };

  const submitCode = () => {
    if (!/^\d{1,32}$/.test(verifyCode)) { setError("请输入微信显示的数字配对码"); return; }
    setError("");
    void poll(generation.current, verifyCode);
  };

  const saveWorkspaces = async () => {
    setBusy(true); setError("");
    try {
      const next = await weixinSetWorkspaces(selected);
      setStatus(next);
      setSelected(next.allowedWorkspaces);
      onToast?.("微信可访问的工作区已保存");
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };

  const revokeSession = async (sessionId: string) => {
    setBusy(true); setError("");
    try {
      setStatus(await weixinRevokeSession(sessionId));
      onToast?.("已撤销该任务的单独交接授权");
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };

  const disconnect = () => requestConfirmation({
    title: "解除微信绑定？",
    description: "本机将停止接收微信指令，并删除本机的绑定凭据。之后可重新扫码绑定。",
    confirmLabel: "解除绑定", danger: true,
    action: async () => {
      generation.current += 1;
      pollingGeneration.current = null;
      await weixinDisconnect();
      setStatus({ connected: false, allowedWorkspaces: [], sharedSessions: [], pendingReplies: 0, online: false });
      setSelected([]); setQrUrl("");
      onToast?.("微信已解除绑定");
    },
    onError: (cause) => setError(String(cause)),
  });

  return <div className="weixin-channel">
    <div className="weixin-channel__intro">
      <p>在微信继续桌面上的已授权任务。桌面与微信共用会话记录；本机运行时处理指令，断线后自动重连并补发排队中的文字回复。</p>
    </div>
    {error && <div className="panel-inline-error" role="alert">{error}<button type="button" onClick={() => setError("")}>关闭</button></div>}
    {!status && !error && <p>正在读取绑定状态…</p>}
    {status && !status.connected && <section className="weixin-channel__card">
      <h3>绑定微信</h3>
      <p>用手机微信扫描二维码，在微信内完成确认。二维码仅在本机显示。</p>
      {qrImage && <img className="weixin-channel__qr" src={qrImage} alt="微信绑定二维码" />}
      {qrUrl && <p aria-live="polite">{STATUS[qrStatus] ?? qrStatus}</p>}
      {qrStatus === "need_verifycode" && <div className="weixin-channel__code"><input aria-label="微信配对码" inputMode="numeric" value={verifyCode} onChange={(event) => setVerifyCode(event.target.value)} placeholder="微信显示的配对码" disabled={checkingCode} /><button type="button" onClick={submitCode} disabled={checkingCode}>{checkingCode ? "正在验证…" : "提交配对码"}</button></div>}
      <button type="button" onClick={() => void start()} disabled={busy}>{busy ? "正在获取…" : qrUrl ? "刷新二维码" : "获取绑定二维码"}</button>
    </section>}
    {status?.connected && <>
      <section className="weixin-channel__card"><h3>{status.online ? "已连接" : "已绑定，连接中"}</h3>
        <p>连接状态：{status.online ? "正在接收微信消息" : "暂时无法接收微信消息，等待自动恢复"}{status.lastError ? ` · ${status.lastError}` : ""}</p>
        {status.pendingReplies > 0 && <p role="status">{status.pendingReplies} 条文字回复待发送，连接恢复后自动重试。</p>}
        <p>微信 Bot：{status.botId}</p>
        <p>当前会话：{status.activeSession ? `${status.activeSessionTitle ?? "任务"} · #${status.activeSession.slice(-8)}` : "尚未选择"}</p>
        <p>在任务列表右键选择“在微信继续”，即可把任意已有任务设为微信当前会话。</p>
      </section>
      <section className="weixin-channel__card"><h3>授权工作区</h3>
        <p>仅所选工作区的会话会出现在微信“任务”列表中。单独交接的会话也可访问。</p>
        {workspaces.length === 0 && <p>暂无已有工作区。先在桌面创建任务。</p>}
        {workspaces.map((space) => <label className="weixin-channel__workspace" key={space.cwd}>
          <input type="checkbox" checked={selected.includes(space.cwd)} onChange={(event) => setSelected((items) => event.target.checked ? [...items, space.cwd] : items.filter((item) => item !== space.cwd))} />
          <span title={space.cwd}>{space.cwd}</span>
          <small>{space.sessionCount ?? 0} 个任务</small>
        </label>)}
        <button type="button" onClick={() => void saveWorkspaces()} disabled={busy || selected.join("\0") === status.allowedWorkspaces.join("\0")}>保存访问范围</button>
      </section>
      <section className="weixin-channel__card"><h3>单独交接的任务</h3>
        <p>这些任务即使取消所属工作区授权仍可在微信访问。撤销后会清除微信当前会话；若所属工作区仍获授权，还需取消该工作区的授权。已开始的执行需在桌面停止。</p>
        {status.sharedSessions.length === 0 && <p>暂无单独交接的任务。</p>}
        {status.sharedSessions.map((session) => <div className="weixin-channel__shared" key={session.sessionId}>
          <div><strong>{session.title}</strong><small>#{session.sessionId.slice(-8)}{session.cwd && ` · ${session.cwd}`}</small></div>
          <button type="button" onClick={() => void revokeSession(session.sessionId)} disabled={busy} aria-label={`撤销 ${session.title} 的微信授权`}>撤销</button>
        </div>)}
      </section>
      <section className="weixin-channel__card"><h3>微信指令</h3>
        <div className="weixin-channel__commands"><span>任务 / 任务 2</span><span>分页查看可继续的会话</span><span>切换 #编号</span><span>进入已有会话</span><span>工作区</span><span>查看新任务可用目录</span><span>新任务：内容</span><span>在默认工作区新建任务</span><span>新任务 2：内容</span><span>在指定工作区新建任务</span><span>状态 / 停止</span><span>查看或停止当前任务</span></div>
        <p>发送“/文件 相对路径”，可取回当前任务工作区内不超过 20 MB 的文件。</p>
        <p>直接发送文字、语音转写或图片和文档，会继续当前会话。任务沿用桌面设置的权限模式；需要确认时，会收到带编号的请求。</p>
      </section>
      <button type="button" className="weixin-channel__disconnect" onClick={disconnect}>解除绑定</button>
    </>}
    {dialog}
  </div>;
}
