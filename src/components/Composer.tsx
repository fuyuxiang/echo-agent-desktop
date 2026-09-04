import { useEffect, useMemo, useRef, useState } from "react";
import { Mic, X, type LucideIcon } from "lucide-react";
import { ChevronDownIcon, SendPlaneIcon } from "@/foundation/components/Icon/icons";
import { ModelSelector, type ModelOption } from "./ModelSelector";
import { ThumbImg } from "./experts-panel/shared/ThumbImg";
import { ContextUsagePill } from "./ContextUsagePill";
import { estimateSendCost } from "@/lib/token-estimate";
import {
  blocks,
  assemblePrompt,
  blockLabel,
} from "@/lib/content-blocks";
import {
  createInputHistory,
  pushHistory,
  navigateHistory,
  type InputHistory,
} from "@/lib/input-history";
import { WorkspacePicker } from "./WorkspacePicker";
import { PermissionPicker } from "./PermissionPicker";
import { SlashCommands, type SlashCommandsHandle } from "./SlashCommands";
import {
  isClientSlashCommand,
  parseSlashInvocation,
  replaceSlashToken,
  slashTokenAtCursor,
  type SlashCommandInvocation,
} from "@/lib/slash-commands";
import { InputAddMenu } from "./InputAddMenu";
import {
  registerAsrProvider,
  getActiveAsr,
  createWebSpeechAsrProvider,
} from "@/lib/voice-contract";
import type { AgentEntry } from "@/lib/types";
import { filesystemPickFiles, type WorkspaceInfo } from "@/lib/agent-client";

/**
 * EchoAgent 风格输入卡片(圆角16):左下 +,右下 Auto 下拉/麦克风/发送;
 * showMeta 时卡片内部底部显示"选择工作空间/默认权限"。
 * showDisclaimer 时卡片下方渲染免责声明行。
 * apiReady=false 时输入禁用,点击卡片引导打开设置。
 */
export function Composer({
  streaming,
  cancelling = false,
  disabled,
  onSend,
  onCancel,
  placeholder,
  apiReady = true,
  setupHint = "请先配置 API Key 开始使用",
  onOpenSettings,
  onToast,
  showMeta = false,
  showDisclaimer = false,
  permissionInline = false,
  // Model picker
  modelId,
  models,
  onModelChange,
  // Workspace picker
  cwd,
  workspaces,
  onSelectWorkspace,
  // Seed text (from HomePage chips). Consumed once, then cleared via callback.
  initialText,
  onInitialTextConsumed,
  // 不可编辑的"操作类型"标签(首页选中能力分类时插入),显示在输入框内首行。
  sceneTag,
  onClearSceneTag,
  // 受控填充:externalTextNonce 变化时把 externalText 写入输入框(用于点击模板)。
  externalText,
  externalAttachments,
  externalTextNonce,
  // 按会话持久化的草稿:切换 sessionId 时按 draft 回填,每次输入回写 store。
  // 不传这三者时退化为纯组件内 state(向后兼容旧调用方/测试)。
  draft,
  draftKey,
  onDraftChange,
  onSelectExpert,
  onSelectSkill,
  onNavigateConnectors,
  // Slash-command context and desktop-owned command execution.
  commandSessionId,
  commandRefreshKey,
  onClientSlashCommand,
  /** 流式时把「发送」改为「加入待发送队列」(对齐 EchoAgent message-queue)。
   *  传入后:流式且文本非空时,在停止按钮左侧显示「入队」按钮。 */
  onEnqueue,
  /** Name of the expert currently bound to this session (shown as badge in footer). */
  activeExpertName,
  /** Local avatar path for the expert badge. */
  activeExpertAvatar,
  /** Session id powering the context-usage pill (omit on the home page). */
  usageSessionId,
  usageMsgCount,
}: {
  streaming: boolean;
  /** A cancellation request is in flight; keep the stop action single-shot. */
  cancelling?: boolean;
  disabled?: boolean;
  onSend: (text: string, attachments?: string[]) => boolean | void | Promise<boolean | void>;
  onCancel: () => boolean | void | Promise<boolean | void>;
  placeholder?: string;
  apiReady?: boolean;
  /** Message shown when the composer is unavailable. */
  setupHint?: string;
  onOpenSettings?: () => void;
  onPlaceholder?: (label: string) => void;
  /** Surface transient feedback (permission rule save errors, etc.). */
  onToast?: (msg: string) => void;
  showMeta?: boolean;
  /** Show "内容由 AI 生成" disclaimer below card (chat page). */
  showDisclaimer?: boolean;
  /** 把权限选择器放进卡片内 footer（+ 之后），匹配 EchoAgent 本地助理页；为 true 时不再渲染卡片外 meta 行。 */
  permissionInline?: boolean;
  /** Currently selected model id (shown on the model trigger). */
  modelId?: string;
  /** Available models for the picker. */
  models?: ModelOption[];
  onModelChange?: (id: string) => void;
  /** Currently active working directory. */
  cwd?: string;
  workspaces?: WorkspaceInfo[];
  onSelectWorkspace?: (cwd: string) => void;
  /** Optional initial text to seed the input (one-shot, then cleared). */
  initialText?: string;
  onInitialTextConsumed?: () => void;
  /**
   * 首页"操作类型"标签(复刻 EchoAgent 的 scene tag):选中能力分类后插入
   * 到输入框内首行的黑色标签,带图标与 × 删除按钮。发送时作为上下文前缀。
   */
  sceneTag?: { label: string; icon: LucideIcon } | null;
  /** 点击标签 × 时清空该标签(并清空相关输入)。 */
  onClearSceneTag?: () => void;
  /** 受控填充的内容(通常是某个模板对应的完整 prompt)。 */
  externalText?: string;
  /** Files restored together with externalText (for edit-and-resend). */
  externalAttachments?: string[];
  /** 递增的 nonce;变化时把 externalText 写入输入框并聚焦。 */
  externalTextNonce?: number;
  /**
   * 持久化草稿:切到某会话时(draftKey 变化)把 draft 回填到输入框。
   * 与 externalText 不同,这是"用户已经敲下的字",回填时不触发 onDraftChange。
   */
  draft?: string;
  /** 草稿作用域标识(通常是 sessionId 或哨兵)。变化时触发回填。 */
  draftKey?: string | number;
  /** 用户输入时回调,父组件据此把草稿写回 store。 */
  onDraftChange?: (text: string) => void;
  /** 加号菜单:选择专家。 */
  onSelectExpert?: (agent: AgentEntry) => void;
  /** 加号菜单:选择技能(插入 /skillName)。 */
  onSelectSkill?: (skillName: string) => void;
  /** 加号菜单:跳转到连接器管理面板。 */
  onNavigateConnectors?: () => void;
  /** Current session used to request the runtime's context-aware command catalog. */
  commandSessionId?: string;
  /** Incremented when the runtime publishes available_commands_update. */
  commandRefreshKey?: number;
  /** Execute commands owned by the desktop shell (/new, /settings, /plan, ...). */
  onClientSlashCommand?: (
    invocation: SlashCommandInvocation,
  ) => boolean | void | Promise<boolean | void>;
  /** 流式时把「发送」改为「加入待发送队列」(对齐 EchoAgent message-queue)。 */
  onEnqueue?: (text: string, attachments?: string[]) => void;
  /** Name of the expert currently bound to this session (shown as badge in footer). */
  activeExpertName?: string;
  /** Local avatar path for the expert badge. */
  activeExpertAvatar?: string;
  /** Session id powering the context-usage pill (omit on the home page). */
  usageSessionId?: string;
  /** Triggers pill re-fetch when messages change. */
  usageMsgCount?: number;
}) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  // 发送前成本预估(对齐 EchoAgent credit-estimate):纯本地 token 估算。
  // ctxUsed/ctxTotal 由 ContextUsagePill 异步获取,这里不耦合;徽章在占比未知时
  // 仍显示 +N(新增 token),有占比信息时叠加(此处保守不取,避免与 pill 抢请求)。
  const cost = useMemo(() => estimateSendCost(text), [text]);
  // 输入历史(arrow-key recall,对齐 EchoAgent use-input-history):内存中按发送追加,
  // ↑/↓ 在输入框回溯。draftRef 暂存「回到输入框」时恢复的草稿。
  const histRef = useRef<InputHistory>(createInputHistory(50));
  const histCursorRef = useRef<number>(0);
  const draftRef = useRef<string>("");
  // 多块提示预览(对齐 EchoAgent content-blocks):仅显示专家/技能
  // 引用。附件在下方有可删除的独立 chip，不再重复渲染一份。
  const blockList = useMemo(() => {
    const list = [];
    if (activeExpertName) list.push(blocks.expert({ name: activeExpertName, path: "", scope: "local", raw: "" }));
    if (sceneTag) list.push(blocks.skill(sceneTag.label));
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeExpertName, sceneTag]);
  const hasRefs = blockList.length > 0;
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<VoiceRecognition | null>(null);
  const mountedRef = useRef(true);
  const onDraftChangeRef = useRef(onDraftChange);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    onDraftChangeRef.current = onDraftChange;
  }, [onDraftChange]);

  // 统一更新入口:每次写入输入框内容时同步把草稿推给父组件(若启用持久化)。
  // 回填(draftKey 变化)时不走这里,避免把"恢复出来的字"再当成用户输入回写。
  const updateText = (next: string | ((prev: string) => string)) => {
    setText((prev) => {
      const value = typeof next === "function" ? (next as (p: string) => string)(prev) : next;
      onDraftChangeRef.current?.(value);
      return value;
    });
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }, [text]);

  // One-shot seed: when the parent supplies initialText, fill the textarea and
  // focus it so the user can immediately edit/send.
  useEffect(() => {
    if (initialText !== undefined && initialText !== null) {
      updateText(initialText);
      setCursorPos(initialText.length);
      onInitialTextConsumed?.();
      requestAnimationFrame(() => ref.current?.focus());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialText]);

  // 受控填充:点击模板/切换标签时由父组件驱动,把内容写入输入框并聚焦。
  // 用 nonce 而不是 externalText 本身做依赖,这样连续点同一个模板也能重新触发。
  useEffect(() => {
    if (externalTextNonce === undefined) return;
    const next = externalText ?? "";
    updateText(next); // 同步草稿:模板写入也算当前草稿内容。
    if (externalAttachments !== undefined) {
      setAttachments([...new Set(externalAttachments)]);
    }
    setCursorPos(next.length);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.selectionStart = el.selectionEnd = next.length;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalTextNonce]);

  // 持久化草稿回填:切到另一个会话(draftKey 变化)时,把该会话保存的草稿
  // 写回输入框。注意:这里直接用 setText 而非 updateText,因为这是"恢复"
  // 而不是"用户输入",不该触发 onDraftChange 把同样的内容再写一遍 store。
  // 依赖只看 draftKey(通常是 sessionId),draft 值变化不重新触发——否则用户
  // 每敲一个字都会被这个 effect 重置光标。
  useEffect(() => {
    if (draftKey === undefined) return;
    const recognition = recognitionRef.current;
    if (recognition?.abort) recognition.abort();
    else recognition?.stop();
    recognitionRef.current = null;
    const next = draft ?? "";
    setText(next);
    // Attachments are session-scoped. Never carry an unsent local file into
    // another conversation when ChatView reuses the same Composer instance.
    setAttachments([]);
    setCursorPos(next.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);

  // Voice input uses the provider-agnostic ASR registry, with Web Speech as
  // the built-in browser implementation.
  const toggleVoice = async () => {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    // 优先走 provider-agnostic 注册表(对齐 EchoAgent asr:* 契约):外部 provider
    // 注册后优先级更高；非桌面环境回落到内建 Web Speech。
    ensureWebSpeechAsrRegistered();
    const provider = getActiveAsr();
    if (provider) {
      const baseText = text;
      const separator = baseText && !/\s$/.test(baseText) ? " " : "";
      let committedText = "";
      const stop = provider.listen("zh-CN", {
        onInterim: (interim) => {
          updateText(`${baseText}${separator}${committedText}${interim}`);
        },
        onFinal: (finalDelta) => {
          committedText += finalDelta;
          updateText(`${baseText}${separator}${committedText}`);
        },
        onError: (reason) => {
          setListening(false);
          const msg = reason === "not-allowed" || reason === "service-not-allowed"
            ? "未授予麦克风或语音识别权限"
            : reason === "audio-capture"
              ? "未检测到可用麦克风"
              : reason === "no-speech"
                ? "没有检测到语音，请重试"
                : `语音识别错误：${reason}`;
          onToast?.(msg);
        },
        onEnd: () => setListening(false),
      });
      // 用 recognitionRef 持有 stop 句柄,与既有「再次点击停止」逻辑兼容。
      recognitionRef.current = {
        lang: "zh-CN",
        interimResults: true,
        continuous: false,
        start: () => {},
        stop,
      } as VoiceRecognition;
      setListening(true);
      return;
    }
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      onToast?.("当前环境不支持语音输入");
      return;
    }
    const rec = new Ctor();
    rec.lang = "zh-CN";
    rec.interimResults = true;
    rec.continuous = false;
    const baseText = text;
    const separator = baseText && !/\s$/.test(baseText) ? " " : "";
    let committedText = "";
    rec.onresult = (event: SpeechRecognitionEventLike) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i];
        if (r.isFinal) committedText += r[0].transcript;
        else interim += r[0].transcript;
      }
      // Replace the trailing interim segment on every update; finalized text
      // is accumulated separately and therefore cannot be duplicated.
      updateText(`${baseText}${separator}${committedText}${interim}`);
    };
    rec.onerror = (e: SpeechRecognitionErrorEventLike) => {
      setListening(false);
      const msg = e.error === "not-allowed"
        ? "未授予麦克风权限"
        : `语音识别错误：${e.error}`;
      onToast?.(msg);
    };
    rec.onend = () => setListening(false);
    recognitionRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      onToast?.("无法启动语音识别");
    }
  };

  useEffect(() => {
    return () => {
      const recognition = recognitionRef.current;
      if (recognition?.abort) recognition.abort();
      else recognition?.stop();
    };
  }, []);

  const [sending, setSending] = useState(false);

  const finishAcceptedSubmission = (submittedText: string) => {
    if (submittedText.trim()) {
      histRef.current = pushHistory(histRef.current, submittedText);
      histCursorRef.current = histRef.current.items.length;
      draftRef.current = "";
    }
    if (mountedRef.current) {
      updateText("");
      setAttachments([]);
    } else {
      // Navigation commands and accepted new-session sends may unmount this
      // Composer before their promise settles. Clear the persisted draft too.
      onDraftChangeRef.current?.("");
    }
    onClearSceneTag?.();
  };

  const send = async () => {
    const t = text.trim();
    // A scene tag is contextual metadata, not a user prompt. Require actual
    // text or at least one attachment for every submission path.
    if ((!t && attachments.length === 0) || streaming || sending || disabled || !apiReady) return;

    // Desktop-owned slash commands never enter the model transcript. Runtime
    // commands and Skills deliberately fall through to onSend/ACP unchanged.
    const invocation = parseSlashInvocation(t);
    if (invocation && isClientSlashCommand(invocation.name)) {
      if (!onClientSlashCommand) {
        onToast?.(`当前页面无法执行 /${invocation.name}`);
        return;
      }
      setSending(true);
      try {
        const result = onClientSlashCommand(invocation);
        const accepted = result && typeof (result as PromiseLike<boolean | void>).then === "function"
          ? await result
          : result;
        if (accepted === false) return;
        finishAcceptedSubmission(t);
      } catch (error) {
        onToast?.(`命令执行失败：${String(error).replace(/^Error:\s*/, "")}`);
      } finally {
        if (mountedRef.current) setSending(false);
      }
      return;
    }

    let body = t;
    // 把"操作类型"标签作为上下文前缀一并发出(后端正文仍是可运行的 prompt)。
    if (sceneTag) {
      body = body ? `【${sceneTag.label}】${body}` : `【${sceneTag.label}】`;
    }
    setSending(true);
    try {
      const result = onSend(body || "请分析附件。", attachments);
      const accepted = result && typeof (result as PromiseLike<boolean | void>).then === "function"
        ? await result
        : result;
      if (accepted === false) return;
    } catch (error) {
      onToast?.(`发送失败：${String(error).replace(/^Error:\s*/, "")}`);
      return;
    } finally {
      if (mountedRef.current) setSending(false);
    }
    finishAcceptedSubmission(body);
  };

  /** 流式时入队(对齐 EchoAgent message-queue):文本或附件任一非空即可入队。 */
  const enqueue = () => {
    const t = text.trim();
    if ((!t && attachments.length === 0) || disabled || !apiReady) return;
    let body = t;
    if (sceneTag) body = body ? `【${sceneTag.label}】${body}` : `【${sceneTag.label}】`;
    onEnqueue?.(body || "请分析附件。", attachments);
    updateText("");
    setAttachments([]);
    onClearSceneTag?.();
  };

  const pickFiles = async () => {
    try {
      const paths = await filesystemPickFiles({ maxFiles: 20 });
      if (paths.length === 0) return;
      setAttachments((prev) => {
        const set = new Set(prev);
        paths.forEach((p) => set.add(p));
        return [...set];
      });
    } catch (error) {
      onToast?.(`选择附件失败：${String(error).replace(/^Error:\s*/, "")}`);
    }
  };

  // Cursor tracking for slash-command autocomplete.
  const [cursorPos, setCursorPos] = useState(0);
  const slashCommandsRef = useRef<SlashCommandsHandle>(null);
  // Slash completion is limited to the first token, matching runtime command
  // resolution. The shared parser supports qualified names such as
  // `/plugin-name:skill-name`.
  const slashVisible = !!slashTokenAtCursor(text, cursorPos) && apiReady && !streaming;

  const handleSlashPick = (command: string) => {
    const replacement = replaceSlashToken(text, cursorPos, command);
    if (!replacement) return;
    updateText(replacement.text);
    setCursorPos(replacement.cursor);
    // Refocus + put caret at the insertion point.
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.selectionStart = el.selectionEnd = replacement.cursor;
    });
  };

  const showModelPicker = !!onModelChange && !!models;
  const showWorkspacePicker = !!onSelectWorkspace && !!workspaces;

  const composerCls = [
    "echo-composer",
    !apiReady && "echo-composer--disabled",
    showMeta && "echo-composer--home",
  ].filter(Boolean).join(" ");

  return (
    <div
      className={
        "echo-composer-wrap" + (showMeta ? " echo-composer-wrap--home" : "")
      }
    >
      <section
        className={composerCls}
        onClick={() => {
          if (!apiReady) onOpenSettings?.();
        }}
      >
        {!apiReady && (
          <div className="echo-composer__setup-hint" role="button" tabIndex={0}>
            {setupHint}
          </div>
        )}

        {/* 多块提示预览(对齐 EchoAgent content-blocks):引用块 chip 行 */}
        {hasRefs && (
          <div className="composer-blocks" title={assemblePrompt(blockList)}>
            {blockList.map((b) => (
              <span key={b.id} className="composer-blocks__chip">
                {blockLabel(b)}
              </span>
            ))}
          </div>
        )}

        {/* Attachment chips */}
        {attachments.length > 0 && (
          <div className="composer-attachments">
            {attachments.map((path) => (
              <span key={path} className="composer-attachments__chip" title={path}>
                <span className="composer-attachments__chip-name">
                  {path.replace(/\\/g, "/").split("/").pop()}
                </span>
                <button
                  type="button"
                  className="composer-attachments__chip-remove"
                  onClick={(e) => {
                    e.stopPropagation();
                    setAttachments((prev) => prev.filter((p) => p !== path));
                  }}
                  aria-label="移除附件"
                >
                  <X size={12} strokeWidth={2} />
                </button>
              </span>
            ))}
          </div>
        )}

        {/* "操作类型"黑色标签(首页选中能力分类后插入,× 可删除) */}
        {sceneTag && (
          <div className="echo-composer__scene-tag" role="group" aria-label={`操作类型 ${sceneTag.label}`}>
            <span className="echo-composer__scene-tag-icon" aria-hidden="true">
              <sceneTag.icon size={14} />
            </span>
            <span className="echo-composer__scene-tag-text">{sceneTag.label}</span>
            <button
              type="button"
              className="echo-composer__scene-tag-remove"
              aria-label={`移除 ${sceneTag.label}`}
              onClick={(e) => {
                e.stopPropagation();
                onClearSceneTag?.();
              }}
            >
              <X size={12} strokeWidth={2} />
            </button>
          </div>
        )}

        <textarea
          ref={ref}
          className="echo-composer__input"
          rows={1}
          value={text}
          disabled={!apiReady}
          placeholder={
            apiReady
              ? sceneTag
                ? "" // 有操作类型标签时不显示占位文案(匹配 EchoAgent)
                : placeholder ?? "今天帮你做些什么? @ 引用对话文件,/ 调用技能与指令"
              : setupHint
          }
          onChange={(e) => {
            updateText(e.target.value);
            setCursorPos(e.target.selectionStart ?? e.target.value.length);
            // 手动输入时把历史游标重置回末尾(回到「输入框」态)。
            histCursorRef.current = histRef.current.items.length;
          }}
          onSelect={(e) =>
            setCursorPos((e.target as HTMLTextAreaElement).selectionStart ?? cursorPos)
          }
          onClick={(e) =>
            setCursorPos((e.target as HTMLTextAreaElement).selectionStart ?? cursorPos)
          }
          onKeyUp={(e) =>
            setCursorPos((e.target as HTMLTextAreaElement).selectionStart ?? cursorPos)
          }
          onKeyDown={(e) => {
            if (
              !e.nativeEvent.isComposing
              && slashCommandsRef.current?.handleKeyDown(e)
            ) {
              return;
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
              return;
            }
            // 输入历史 arrow-key recall(对齐 EchoAgent use-input-history)。
            // 仅在未组合输入(中文输入法)且非 slash 菜单可见时响应。
            if (!slashVisible && !e.nativeEvent.isComposing) {
              const el = e.target as HTMLTextAreaElement;
              const atFirstLine = el.selectionStart === 0 || text.length === 0;
              const atLastLine = el.selectionStart === text.length;
              // 已在历史导航中(cursor < items.length)时,↑/↓ 持续翻页,不受光标位置约束。
              const navigating = histCursorRef.current < histRef.current.items.length;
              if (e.key === "ArrowUp" && (atFirstLine || navigating)) {
                if (histCursorRef.current === histRef.current.items.length) {
                  draftRef.current = text; // 进入历史前暂存当前草稿
                }
                const r = navigateHistory(histRef.current, histCursorRef.current, "up", draftRef.current);
                if (r.text !== text) {
                  e.preventDefault();
                  histCursorRef.current = r.cursor;
                  updateText(r.text);
                  requestAnimationFrame(() => {
                    const t = ref.current;
                    if (t) {
                      t.selectionStart = t.selectionEnd = r.text.length;
                    }
                  });
                }
              } else if (e.key === "ArrowDown" && (atLastLine || navigating)) {
                const r = navigateHistory(histRef.current, histCursorRef.current, "down", draftRef.current);
                if (r.cursor !== histCursorRef.current) {
                  e.preventDefault();
                  histCursorRef.current = r.cursor;
                  updateText(r.text);
                  requestAnimationFrame(() => {
                    const t = ref.current;
                    if (t) {
                      t.selectionStart = t.selectionEnd = r.text.length;
                    }
                  });
                }
              }
            }
          }}
        />
        {/* Slash-command autocomplete */}
        {apiReady && !streaming && (
          <SlashCommands
            ref={slashCommandsRef}
            text={text}
            cursor={cursorPos}
            sessionId={commandSessionId}
            cwd={cwd}
            refreshKey={commandRefreshKey}
            onPick={handleSlashPick}
          />
        )}
        <div className="echo-composer__footer">
          <InputAddMenu
            onPickFiles={pickFiles}
            onSelectExpert={onSelectExpert}
            onSelectSkill={(name) => {
              onSelectSkill?.(name);
              if (!onSelectSkill) {
                updateText((prev) => {
                  const prefix = prev.endsWith(" ") || prev === "" ? "" : " ";
                  return prev + prefix + `/${name} `;
                });
                requestAnimationFrame(() => ref.current?.focus());
              }
            }}
            onNavigateConnectors={onNavigateConnectors}
          />
          {activeExpertName && (
            <span className="echo-composer__expert-badge" title={`当前专家：${activeExpertName}`}>
              <ThumbImg name={activeExpertName} local={activeExpertAvatar} size={18} shape="circle" />
              {activeExpertName}
            </span>
          )}
          {permissionInline && (
            <PermissionPicker onToast={onToast} />
          )}
          <div className="echo-composer__spacer" />
          {/* 发送前成本预估徽章(对齐 EchoAgent credit-estimate):纯本地 token 估算,
              仅在文本非空时显示。不依赖计费后端(BYOK 无计费通道)。 */}
          {text.trim() && (
            <span
              className={"echo-composer__cost echo-composer__cost--" + cost.severity}
              title={`预计新增约 ${cost.newTokens} token${
                cost.projectedPct > 0 ? ` · 占上下文 ${cost.projectedPct}%` : ""
              }`}
            >
              {cost.label}
            </span>
          )}
          {usageSessionId && <ContextUsagePill sessionId={usageSessionId} onRefreshSignal={usageMsgCount} />}
          {showModelPicker ? (
            <ModelSelector
              modelId={modelId}
              models={models!}
              onModelChange={onModelChange!}
            />
          ) : (
            <button
              className="echo-composer__model"
              onClick={(e) => {
                e.stopPropagation();
                onOpenSettings?.();
              }}
            >
              Auto <ChevronDownIcon size="sm" />
            </button>
          )}
          <button
            className={
              "echo-composer__tool" + (listening ? " echo-composer__tool--active" : "")
            }
            onClick={(e) => {
              e.stopPropagation();
              void toggleVoice();
            }}
            aria-label="语音输入"
            title={listening ? "正在聆听…点击停止" : "语音输入"}
          >
            <Mic size={16} />
          </button>
          {streaming ? (
            <>
              {/* 流式时可加入待发送队列(对齐 EchoAgent message-queue)。 */}
              {onEnqueue && (text.trim() !== "" || attachments.length > 0) && (
                <button
                  className="echo-composer__send echo-composer__send--enqueue"
                  onClick={(e) => {
                    e.stopPropagation();
                    enqueue();
                  }}
                  disabled={disabled || !apiReady}
                  aria-label="加入待发送队列"
                  title="加入待发送队列(agent 完成后自动发送)"
                >
                  +
                </button>
              )}
              <button
                className="echo-composer__send echo-composer__send--stop"
                onClick={(e) => {
                  e.stopPropagation();
                  if (!cancelling) void onCancel();
                }}
                disabled={cancelling}
                aria-label={cancelling ? "正在停止生成" : "停止生成"}
                title={cancelling ? "正在停止生成…" : "停止生成"}
              >
                ■
              </button>
            </>
          ) : (
            <button
              className={
                "echo-composer__send" +
                (text.trim() === "" && attachments.length === 0
                  ? " echo-composer__send--empty"
                  : "")
              }
              onClick={(e) => {
                e.stopPropagation();
                send();
              }}
              disabled={disabled || !apiReady || sending || (text.trim() === "" && attachments.length === 0)}
              aria-label="发送"
              title={!apiReady ? setupHint : sending ? "正在发送" : "发送消息"}
            >
              <SendPlaneIcon size="md" />
            </button>
          )}
        </div>
      </section>
      {/* EchoAgent: meta 行在白卡外下方,透明背景,与卡片间距4px(仅首页) */}
      {showMeta && !permissionInline && (
        <div className="echo-composer-meta">
          {showWorkspacePicker ? (
            <WorkspacePicker
              cwd={cwd}
              workspaces={workspaces!}
              onSelectWorkspace={onSelectWorkspace!}
            />
          ) : null}
          <PermissionPicker onToast={onToast} />
        </div>
      )}
      {showDisclaimer && (
        <div className="echo-composer__disclaimer">
          内容由 AI 生成，请核实重要信息
        </div>
      )}
    </div>
  );
}

// ---------- SpeechRecognition minimal typing ----------
// The browser SpeechRecognition API isn't in the TS DOM lib by default, and
// vendor prefixes vary. We type only the surface we use and resolve the ctor
// defensively at runtime.
interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string };
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}
interface SpeechRecognitionErrorEventLike {
  error: string;
}
interface VoiceRecognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  abort?: () => void;
  onresult: (e: SpeechRecognitionEventLike) => void;
  onerror: (e: SpeechRecognitionErrorEventLike) => void;
  onend: () => void;
}
type VoiceRecognitionCtor = new () => VoiceRecognition;

function getSpeechRecognitionCtor(): VoiceRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: VoiceRecognitionCtor;
    webkitSpeechRecognition?: VoiceRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * 注册内建 Web Speech ASR provider 到 voice-contract 注册表(provider-agnostic,
 * 对齐 EchoAgent `asr:*` 契约)。外部 provider(如云端 STT)注册后会因其更高
 * 优先级而被优先使用。仅在首次调用时注册一次。
 */
let webSpeechAsrRegistered = false;
function ensureWebSpeechAsrRegistered(): void {
  if (webSpeechAsrRegistered) return;
  webSpeechAsrRegistered = true;
  const Ctor = getSpeechRecognitionCtor();
  if (!Ctor) return;
  registerAsrProvider(
    createWebSpeechAsrProvider({
      isAvailable: () => getSpeechRecognitionCtor() !== null,
      createRecognition: (lang) => {
        const rec = new Ctor();
        rec.lang = lang;
        rec.interimResults = true;
        rec.continuous = false;
        return rec as never;
      },
    }),
  );
}
