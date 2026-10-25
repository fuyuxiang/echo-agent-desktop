import { useCallback, useEffect, useRef, useState } from "react";
import { agentSessionWorkspaceStatus, filesystemPickDirectory, type SessionWorkspaceStatus } from "./agent-client";
import { isTauriAvailable } from "./tauri-kb-reader";
import { friendlyError } from "./error-format";

/** Checks metadata and access only; never enumerates the task's files. */
export function useSessionWorkspace(sessionId: string | null, cwd: string | undefined, refreshSignal: unknown,
  onReload?: (cwd: string) => Promise<void>, onToast?: (message: string) => void) {
  const key = `${sessionId ?? ""}:${cwd ?? ""}`;
  const owner = useRef(key);
  owner.current = key;
  const sequence = useRef(0);
  const [result, setResult] = useState<{ key: string; value: SessionWorkspaceStatus }>();
  const [recovering, setRecovering] = useState(new Set<string>());
  const operations = useRef(new Set<string>());
  const callbacks = useRef({ onReload, onToast });
  callbacks.current = { onReload, onToast };
  const check = useCallback(async (claimedCwd = cwd) => {
    if (!sessionId || !cwd || !isTauriAvailable()) return true;
    const request = ++sequence.current;
    try {
      const value = await agentSessionWorkspaceStatus(sessionId, claimedCwd!);
      if (!value || !["ready", "missing", "unavailable"].includes(value.status)) throw new Error("无法获取任务目录状态，请重试");
      if (owner.current !== key || request !== sequence.current) return false;
      setResult({ key, value: value.status === "ready" && value.loaded === false
        ? { ...value, status: "unavailable", message: "工作目录可用，请点击重试连接，重新加载本会话" }
        : value });
      return value.status === "ready";
    } catch (error) {
      if (owner.current === key && request === sequence.current) {
        setResult({ key, value: { cwd, status: "unavailable", message: friendlyError(error) } });
      }
      return false;
    }
  }, [sessionId, cwd, key]);

  useEffect(() => {
    void check();
    const focus = () => { if (!operations.current.has(key)) void check(); };
    window.addEventListener("focus", focus);
    return () => { ++sequence.current; window.removeEventListener("focus", focus); };
  }, [check, refreshSignal, key]);

  const recover = async (authorize = false) => {
    if (operations.current.has(key) || !cwd) return;
    operations.current.add(key);
    setRecovering(new Set(operations.current));
    const { onReload, onToast } = callbacks.current;
    const originalCwd = value?.cwd ?? cwd;
    try {
      if (authorize) {
        const selected = await filesystemPickDirectory(originalCwd);
        if (owner.current !== key || !selected) return;
        if (selected !== originalCwd) {
          onToast?.("请选择本会话的原目录；使用其他目录请新建任务");
          return;
        }
      }
      if (await check(originalCwd) && owner.current === key) {
        await onReload?.(originalCwd);
        if (owner.current === key) await check(originalCwd);
      }
    } catch (error) {
      if (owner.current === key) onToast?.(`恢复目录失败：${friendlyError(error)}`);
    } finally {
      operations.current.delete(key);
      setRecovering(new Set(operations.current));
    }
  };
  const value = result?.key === key ? result.value : undefined;
  const checking = Boolean(sessionId && cwd && isTauriAvailable() && !value);
  return { cwd: value?.cwd ?? cwd, value, checking, busy: recovering.has(key),
    available: !checking && (!value || value.status === "ready"),
    retry: () => recover(), authorize: () => recover(true) };
}
