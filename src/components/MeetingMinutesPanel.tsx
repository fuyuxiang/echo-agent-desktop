import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CircleStop,
  Clock3,
  Copy,
  Download,
  FileAudio,
  FileText,
  Loader2,
  Mic,
  Pause,
  Play,
  RefreshCw,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import { filesystemPickFiles } from "@/lib/agent-client";
import {
  formatMeetingDuration,
  meetingDelete,
  meetingExport,
  meetingGet,
  meetingImportAudio,
  meetingJobActive,
  meetingList,
  meetingOpenAudio,
  meetingProcess,
  meetingRecorder,
  meetingRegenerateMinutes,
  meetingUpdate,
  type MeetingRecord,
  type TranscriptSegment,
} from "@/lib/meeting-minutes";
import type { ModelOption } from "./ModelSelector";
import { Markdown } from "./markdown/Markdown";

interface MeetingMinutesPanelProps {
  modelId?: string;
  models: ModelOption[];
  onToast?: (message: string) => void;
  onOpenModelSettings?: () => void;
}

type DetailTab = "minutes" | "transcript" | "audio";

const STATUS_LABELS: Record<string, string> = {
  recording: "录音中",
  paused: "已暂停",
  importing: "正在导入",
  recorded: "等待转写",
  transcribing: "正在转写",
  summarizing: "正在生成纪要",
  transcribed: "转写已完成",
  partial: "部分转写失败",
  failed: "处理失败",
  completed: "已完成",
};

const NATIVE_JOB_STATUSES = ["importing", "transcribing", "summarizing"];

function errorText(error: unknown): string {
  return String(error).replace(/^Error:\s*/, "");
}

function defaultMeetingTitle(): string {
  return `会议 ${new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date())}`;
}

export function MeetingMinutesPanel({
  modelId,
  models,
  onToast,
  onOpenModelSettings,
}: MeetingMinutesPanelProps) {
  const selectedModel = models.find((model) => model.id === modelId);
  const capable = selectedModel?.providerKind === "minimax" && Boolean(selectedModel.providerId);
  const [records, setRecords] = useState<MeetingRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<MeetingRecord | null>(null);
  const [title, setTitle] = useState(defaultMeetingTitle);
  const [tab, setTab] = useState<DetailTab>("minutes");
  const [busy, setBusy] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draftTranscript, setDraftTranscript] = useState<TranscriptSegment[]>([]);
  const [recorder, setRecorder] = useState(meetingRecorder.current());
  const [activeJobs, setActiveJobs] = useState<Record<string, boolean | undefined>>({});

  const refreshJobState = useCallback(async (record: MeetingRecord) => {
    if (!NATIVE_JOB_STATUSES.includes(record.status)) {
      setActiveJobs((current) => ({ ...current, [record.id]: false }));
      return;
    }
    setActiveJobs((current) => ({ ...current, [record.id]: undefined }));
    try {
      const active = await meetingJobActive(record.id);
      setActiveJobs((current) => ({ ...current, [record.id]: active }));
    } catch {
      setActiveJobs((current) => ({ ...current, [record.id]: false }));
    }
  }, []);

  const refreshList = useCallback(async (preferId?: string | null) => {
    try {
      const next = await meetingList();
      setRecords(next);
      setLoadError(null);
      const target = preferId === null ? next[0]?.id : preferId ?? selectedId ?? next[0]?.id;
      if (target) {
        const record = next.find((item) => item.id === target) ?? await meetingGet(target);
        setSelectedId(record.id);
        setSelected(record);
        setDraftTranscript(record.transcript);
        void refreshJobState(record);
      } else {
        setSelectedId(null);
        setSelected(null);
        setDraftTranscript([]);
      }
    } catch (error) {
      setLoadError(errorText(error));
    }
  }, [refreshJobState, selectedId]);

  useEffect(() => {
    void refreshList();
  // Initial native hydration only. Selection changes are loaded explicitly.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => meetingRecorder.subscribe((snapshot) => {
    setRecorder(snapshot);
    if (snapshot.meeting) {
      setSelectedId(snapshot.meeting.id);
      setSelected(snapshot.meeting);
      setDraftTranscript(snapshot.meeting.transcript);
      void refreshJobState(snapshot.meeting);
      setRecords((current) => {
        const without = current.filter((item) => item.id !== snapshot.meeting!.id);
        return [snapshot.meeting!, ...without];
      });
    }
  }), [refreshJobState]);

  useEffect(() => {
    const processing = selected && NATIVE_JOB_STATUSES.includes(selected.status);
    const selectedJobActive = selected ? activeJobs[selected.id] : false;
    if ((!processing || selectedJobActive === false) && !busy?.startsWith("process:")) return;
    const timer = window.setInterval(() => {
      if (!selectedId) return;
      void meetingGet(selectedId).then((record) => {
        setSelected(record);
        setDraftTranscript(record.transcript);
        setRecords((current) => current.map((item) => item.id === record.id ? record : item));
        void refreshJobState(record);
      }).catch(() => {});
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [activeJobs, busy, refreshJobState, selected, selectedId]);

  const chooseRecord = async (record: MeetingRecord) => {
    setSelectedId(record.id);
    setSelected(record);
    setDraftTranscript(record.transcript);
    void refreshJobState(record);
    setTab(record.minutes ? "minutes" : record.transcript.length > 0 ? "transcript" : "audio");
  };

  const requireProvider = () => {
    if (capable && modelId && selectedModel?.providerId) {
      return { modelId, providerId: selectedModel.providerId };
    }
    onToast?.("请先选择并配置 MiniMax 模型");
    onOpenModelSettings?.();
    return null;
  };

  const startRecording = async () => {
    const provider = requireProvider();
    if (!provider) return;
    setBusy("start");
    try {
      const record = await meetingRecorder.start(title, provider.modelId, provider.providerId);
      await refreshList(record.id);
      setTab("audio");
      onToast?.("录音已开始；离开此页面也会继续保存");
    } catch (error) {
      await refreshList(null);
      onToast?.(`开始录音失败：${errorText(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const importAudio = async () => {
    const provider = requireProvider();
    if (!provider) return;
    const [source] = await filesystemPickFiles({
      title: "选择会议录音",
      extensions: ["wav", "aiff", "flac", "alac", "m4a", "mp3", "aac", "ogg"],
      multiple: false,
      maxFiles: 1,
    });
    if (!source) return;
    setBusy("import");
    try {
      const record = await meetingImportAudio(source, title, provider.modelId, provider.providerId);
      await refreshList(record.id);
      setTitle(defaultMeetingTitle());
      setTab("audio");
      onToast?.("录音已导入，可以开始转写");
    } catch (error) {
      await refreshList(null);
      onToast?.(`导入录音失败：${errorText(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const stopRecording = async () => {
    setBusy("stop");
    try {
      const record = await meetingRecorder.stop();
      await refreshList(record.id);
      setTitle(defaultMeetingTitle());
      onToast?.("录音已保存，可以开始转写");
    } catch (error) {
      onToast?.(`结束录音失败：${errorText(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const processMeeting = async (record: MeetingRecord) => {
    setBusy(`process:${record.id}`);
    setActiveJobs((current) => ({ ...current, [record.id]: undefined }));
    setSelected({ ...record, status: "transcribing", error: undefined });
    setTab("transcript");
    try {
      const completed = await meetingProcess(record.id);
      await refreshList(completed.id);
      setTab("minutes");
      onToast?.("转写和会议纪要已生成");
    } catch (error) {
      await refreshList(record.id);
      onToast?.(`处理失败：${errorText(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const regenerate = async () => {
    if (!selected) return;
    setBusy("regenerate");
    try {
      const record = await meetingRegenerateMinutes(selected.id);
      await refreshList(record.id);
      setTab("minutes");
      onToast?.("会议纪要已重新生成");
    } catch (error) {
      onToast?.(`重新生成失败：${errorText(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const saveTranscript = async () => {
    if (!selected) return;
    setBusy("save-transcript");
    try {
      const record = await meetingUpdate(selected.id, { transcript: draftTranscript });
      await refreshList(record.id);
      onToast?.("转写校对已保存，请重新生成会议纪要");
    } catch (error) {
      onToast?.(`保存转写失败：${errorText(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const doExport = async (kind: "audio" | "minutes" | "transcript" | "srt") => {
    if (!selected) return;
    try {
      const path = await meetingExport(selected.id, kind);
      if (path) onToast?.(`已导出到 ${path}`);
    } catch (error) {
      onToast?.(`导出失败：${errorText(error)}`);
    }
  };

  const removeMeeting = async () => {
    if (!selected || meetingRecorder.current().meeting?.id === selected.id && meetingRecorder.current().active) {
      onToast?.("请先结束正在进行的录音");
      return;
    }
    if (!window.confirm(`确定删除《${selected.title}》及其本地录音吗？文件会移入系统回收站。`)) return;
    try {
      await meetingDelete(selected.id);
      setSelectedId(null);
      setSelected(null);
      await refreshList(null);
      onToast?.("会议记录已移入回收站");
    } catch (error) {
      onToast?.(`删除失败：${errorText(error)}`);
    }
  };

  const completedChunks = selected?.chunks.filter((chunk) => chunk.status === "completed").length ?? 0;
  const processingProgress = selected?.chunks.length
    ? Math.round(completedChunks / selected.chunks.length * 100)
    : 0;
  const recordingThis = recorder.active && recorder.meeting?.id === selected?.id;
  const selectedJobActive = selected ? activeJobs[selected.id] : false;
  const interruptedProcessing = Boolean(
    selected
    && ["transcribing", "summarizing"].includes(selected.status)
    && selectedJobActive === false,
  );
  const interruptedImport = Boolean(
    selected?.status === "importing" && selectedJobActive === false,
  );
  const speakerNames = useMemo(
    () => [...new Set(draftTranscript.map((segment) => segment.speaker))],
    [draftTranscript],
  );

  return (
    <div className="meeting-panel">
      <header className="meeting-panel__header">
        <div>
          <h1>录音转写</h1>
          <p>本地保存完整录音，使用 MiniMax 进行说话人转写并生成可追溯的会议纪要。</p>
        </div>
        <div className={`meeting-panel__provider${capable ? " is-ready" : ""}`}>
          <span>{capable ? "MiniMax 已就绪" : "需要 MiniMax 模型"}</span>
          {!capable && <button type="button" onClick={onOpenModelSettings}>配置模型</button>}
        </div>
      </header>

      <section className="meeting-panel__create">
        <label>
          <span>会议名称</span>
          <input value={title} maxLength={100} onChange={(event) => setTitle(event.target.value)} disabled={recorder.active} />
        </label>
        <button className="meeting-primary" type="button" onClick={() => void startRecording()} disabled={!capable || recorder.active || busy !== null}>
          {busy === "start" ? <Loader2 className="meeting-spin" size={17} /> : <Mic size={17} />}
          开始录音
        </button>
        <button className="meeting-secondary" type="button" onClick={() => void importAudio()} disabled={!capable || recorder.active || busy !== null}>
          {busy === "import" ? <Loader2 className="meeting-spin" size={17} /> : <Upload size={17} />}
          导入录音
        </button>
        <small className="meeting-panel__privacy">录音默认仅保存在本机；开始前请确认已获得参会者同意。转写时仅向 MiniMax 上传不超过 7 分钟的分片。</small>
      </section>

      {recorder.active && recorder.meeting && (
        <section className="meeting-recorder" aria-live="polite">
          <div className="meeting-recorder__pulse" style={{ transform: `scale(${0.8 + recorder.level * 0.5})` }}><Mic size={20} /></div>
          <div className="meeting-recorder__main">
            <strong>{recorder.paused ? "录音已暂停" : "正在录音并自动保存"}</strong>
            <span>{recorder.meeting.title} · {formatMeetingDuration(recorder.meeting.durationSeconds)}</span>
            {recorder.error && <em>{recorder.error}</em>}
          </div>
          <button className="meeting-secondary" type="button" onClick={() => void meetingRecorder.setPaused(!recorder.paused)} disabled={busy !== null}>
            {recorder.paused ? <Play size={16} /> : <Pause size={16} />}{recorder.paused ? "继续" : "暂停"}
          </button>
          <button className="meeting-danger" type="button" onClick={() => void stopRecording()} disabled={busy !== null}>
            {busy === "stop" ? <Loader2 className="meeting-spin" size={16} /> : <CircleStop size={16} />}结束并保存
          </button>
        </section>
      )}

      <div className="meeting-panel__body">
        <aside className="meeting-list">
          <div className="meeting-list__heading"><span>最近会议</span><button type="button" aria-label="刷新会议列表" onClick={() => void refreshList()}><RefreshCw size={14} /></button></div>
          {loadError && <div className="meeting-empty is-error">{loadError}</div>}
          {!loadError && records.length === 0 && <div className="meeting-empty"><FileAudio size={30} /><span>还没有会议记录</span></div>}
          {records.map((record) => (
            <button key={record.id} type="button" className={`meeting-list__item${selectedId === record.id ? " is-active" : ""}`} onClick={() => void chooseRecord(record)}>
              <span className="meeting-list__title">{record.title}</span>
              <span className="meeting-list__meta"><Clock3 size={12} />{formatMeetingDuration(record.durationSeconds)} · {STATUS_LABELS[record.status] ?? record.status}</span>
              {record.status === "recording" && <i />}
            </button>
          ))}
        </aside>

        <main className="meeting-detail">
          {!selected && <div className="meeting-detail__empty"><Mic size={42} /><h2>记录每一次重要讨论</h2><p>开始录音或导入已有音频。两小时以上会议会在本地自动分段处理。</p></div>}
          {selected && (
            <>
              <header className="meeting-detail__header">
                <div>
                  <h2>{selected.title}</h2>
                  <p>{new Date(selected.createdAt).toLocaleString("zh-CN")} · {formatMeetingDuration(selected.durationSeconds)} · {STATUS_LABELS[selected.status] ?? selected.status}</p>
                </div>
                <div className="meeting-detail__actions">
                  <button type="button" onClick={() => void meetingOpenAudio(selected.id)}><Play size={14} />系统播放器</button>
                  <button type="button" onClick={() => void doExport("audio")}><Download size={14} />下载录音</button>
                  <button className="is-danger" type="button" onClick={() => void removeMeeting()} disabled={NATIVE_JOB_STATUSES.includes(selected.status) && selectedJobActive !== false} aria-label="删除会议记录"><Trash2 size={14} /></button>
                </div>
              </header>

              {(["recording", "paused", "recorded", "partial"].includes(selected.status) || interruptedProcessing) && !recordingThis && (
                <div className="meeting-callout">
                  <div><Sparkles size={20} /><span><strong>{interruptedProcessing ? "上次处理已中断" : "录音已安全保存"}</strong><small>{interruptedProcessing ? "已完成的分片仍保存在本机，可以从断点继续。" : "将按 7 分钟切片转写，完成后自动生成会议纪要。"}</small></span></div>
                  <button className="meeting-primary" type="button" onClick={() => void processMeeting(selected)} disabled={busy !== null}>{interruptedProcessing ? "继续处理" : "开始转写并生成纪要"}</button>
                </div>
              )}

              {NATIVE_JOB_STATUSES.includes(selected.status) && selectedJobActive !== false && (
                <div className="meeting-progress">
                  <div><Loader2 className="meeting-spin" size={18} /><span>{selected.status === "importing" ? "正在导入并转换录音…" : selected.status === "summarizing" ? "正在生成会议纪要…" : `正在转写录音… ${processingProgress}%`}</span></div>
                  <div className="meeting-progress__bar"><i style={{ width: `${selected.status === "summarizing" ? 95 : processingProgress}%` }} /></div>
                  <small>可以离开此页面，录音和已完成的转写不会丢失。</small>
                </div>
              )}

              {interruptedImport && <div className="meeting-error">录音导入被意外中断，请删除这条未完成记录后重新导入。</div>}

              {selected.error && <div className="meeting-error">{selected.error}</div>}

              <nav className="meeting-tabs" aria-label="会议内容">
                <button type="button" className={tab === "minutes" ? "is-active" : ""} onClick={() => setTab("minutes")}>会议纪要</button>
                <button type="button" className={tab === "transcript" ? "is-active" : ""} onClick={() => setTab("transcript")}>完整转写 <span>{selected.transcript.length || ""}</span></button>
                <button type="button" className={tab === "audio" ? "is-active" : ""} onClick={() => setTab("audio")}>录音</button>
              </nav>

              <div className="meeting-tab-content">
                {tab === "minutes" && (
                  selected.minutes ? (
                    <div className="meeting-minutes">
                      <div className="meeting-content-toolbar">
                        <button type="button" onClick={() => void navigator.clipboard.writeText(selected.minutes!)}><Copy size={14} />复制</button>
                        <button type="button" onClick={() => void doExport("minutes")}><Download size={14} />导出 Markdown</button>
                        <button type="button" onClick={() => void regenerate()} disabled={busy !== null}><RefreshCw size={14} />重新生成</button>
                      </div>
                      <Markdown complete markdownTheme="loose">{selected.minutes}</Markdown>
                    </div>
                  ) : (
                    <div className="meeting-tab-empty"><Sparkles size={34} /><h3>尚未生成会议纪要</h3><p>完成录音转写后，会自动整理结论、待办、风险和未决问题。</p>{selected.transcript.length > 0 && <button className="meeting-primary" type="button" onClick={() => void regenerate()}>生成会议纪要</button>}</div>
                  )
                )}

                {tab === "transcript" && (
                  draftTranscript.length > 0 ? (
                    <div className="meeting-transcript">
                      <div className="meeting-content-toolbar">
                        <span>{speakerNames.length} 位说话人 · 可直接校对</span>
                        <button type="button" onClick={() => void doExport("transcript")}><Download size={14} />TXT</button>
                        <button type="button" onClick={() => void doExport("srt")}><Download size={14} />SRT</button>
                        <button className="meeting-primary" type="button" onClick={() => void saveTranscript()} disabled={busy !== null}>保存校对</button>
                      </div>
                      <div className="meeting-transcript__rows">
                        {draftTranscript.map((segment, index) => (
                          <div className="meeting-transcript__row" key={`${segment.id}-${index}`}>
                            <button type="button" className="meeting-transcript__time" title="在系统播放器中打开录音" onClick={() => void meetingOpenAudio(selected.id)}>{formatMeetingDuration(segment.start)}</button>
                            <input aria-label={`第 ${index + 1} 段说话人`} value={segment.speaker} onChange={(event) => {
                              const previous = segment.speaker;
                              const next = event.target.value;
                              setDraftTranscript((current) => current.map((item) => item.speaker === previous ? { ...item, speaker: next } : item));
                            }} />
                            <textarea aria-label={`第 ${index + 1} 段转写`} value={segment.text} rows={Math.max(1, Math.ceil(segment.text.length / 60))} onChange={(event) => setDraftTranscript((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, text: event.target.value } : item))} />
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="meeting-tab-empty"><FileText size={34} /><h3>尚未生成转写</h3><p>录音保存在本地，开始转写后才会上传分片到 MiniMax。</p></div>
                  )
                )}

                {tab === "audio" && (
                  <div className="meeting-audio">
                    <div className="meeting-audio__icon"><FileAudio size={36} /></div>
                    <div><h3>完整录音已保存在本地</h3><p>{selected.originalFileName ? `原始文件：${selected.originalFileName} · ` : ""}标准化副本：16 kHz 单声道 WAV · {formatMeetingDuration(selected.durationSeconds)}</p></div>
                    <button className="meeting-secondary" type="button" onClick={() => void meetingOpenAudio(selected.id)}><Play size={15} />打开播放</button>
                    <button className="meeting-primary" type="button" onClick={() => void doExport("audio")}><Download size={15} />下载录音</button>
                  </div>
                )}
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
