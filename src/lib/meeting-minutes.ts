import { invoke } from "@tauri-apps/api/core";

export type MeetingStatus =
  | "recording"
  | "paused"
  | "interrupted"
  | "importing"
  | "recorded"
  | "transcribing"
  | "summarizing"
  | "transcribed"
  | "partial"
  | "failed"
  | "completed";

export type RecordingSource = "microphone" | "system" | "both";

export interface CaptureSupport {
  systemAudio: boolean;
  detail?: string;
}

export interface CaptureStatus {
  meetingId: string;
  active: boolean;
  paused: boolean;
  level: number;
  recordedSamples: number;
  error?: string;
  pendingSave?: boolean;
}

export interface TranscriptSegment {
  id: number;
  start: number;
  end: number;
  speaker: string;
  text: string;
}

export interface MeetingChunk {
  index: number;
  start: number;
  end: number;
  status: string;
  traceId?: string;
  error?: string;
}

export interface MeetingRecord {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  status: MeetingStatus;
  modelId: string;
  providerId: string;
  durationSeconds: number;
  recordedSamples: number;
  audioPath: string;
  originalFileName?: string;
  captureSource?: RecordingSource | "imported";
  transcript: TranscriptSegment[];
  transcriptText?: string;
  minutes?: string;
  chunks: MeetingChunk[];
  error?: string;
}

export interface MeetingEditBase {
  transcript: TranscriptSegment[];
  minutes: string | null;
}

export function meetingCreate(title: string, modelId: string, providerId: string, captureSource: RecordingSource = "microphone"): Promise<MeetingRecord> {
  return invoke("meeting_create", { title, modelId, providerId, captureSource });
}

export function meetingCaptureSupport(): Promise<CaptureSupport> {
  return invoke("meeting_capture_support");
}

export function meetingCaptureStatus(): Promise<CaptureStatus | null> {
  return invoke("meeting_capture_status");
}

export function meetingCaptureStart(meetingId: string, mode: "system" | "both"): Promise<CaptureStatus> {
  return invoke("meeting_capture_start", { meetingId, mode });
}

export function meetingCapturePause(meetingId: string, paused: boolean): Promise<MeetingRecord> {
  return invoke("meeting_capture_pause", { meetingId, paused });
}

export function meetingCaptureStop(meetingId: string): Promise<MeetingRecord> {
  return invoke("meeting_capture_stop", { meetingId });
}

export function meetingCheckConnection(modelId: string, providerId: string): Promise<void> {
  return invoke("meeting_check_connection", { modelId, providerId });
}

export function isMiniMaxMeetingModel(model: {
  id: string;
  remoteModelId?: string;
}): boolean {
  const slug = model.remoteModelId?.trim() || model.id;
  return /minimax/i.test(slug);
}

export function meetingAppendPcm(meetingId: string, samples: number[]): Promise<MeetingRecord> {
  return invoke("meeting_append_pcm", { meetingId, samples });
}

export function meetingSetPaused(meetingId: string, paused: boolean): Promise<MeetingRecord> {
  return invoke("meeting_set_paused", { meetingId, paused });
}

export function meetingFinishRecording(meetingId: string): Promise<MeetingRecord> {
  return invoke("meeting_finish_recording", { meetingId });
}

export function meetingImportAudio(
  sourcePath: string,
  title: string,
  modelId: string,
  providerId: string,
): Promise<MeetingRecord> {
  return invoke("meeting_import_audio", { sourcePath, title, modelId, providerId });
}

export interface MeetingModelBinding {
  modelId: string;
  providerId: string;
}

export function meetingProcess(meetingId: string, binding?: MeetingModelBinding): Promise<MeetingRecord> {
  return invoke("meeting_process", {
    meetingId,
    modelId: binding?.modelId ?? null,
    providerId: binding?.providerId ?? null,
  });
}

export function meetingRegenerateMinutes(meetingId: string, binding?: MeetingModelBinding): Promise<MeetingRecord> {
  return invoke("meeting_regenerate_minutes", {
    meetingId,
    modelId: binding?.modelId ?? null,
    providerId: binding?.providerId ?? null,
  });
}

export function meetingUpdate(
  meetingId: string,
  update: { title?: string; transcript?: TranscriptSegment[]; minutes?: string; expectedContent?: MeetingEditBase },
): Promise<MeetingRecord> {
  return invoke("meeting_update", {
    meetingId,
    title: update.title ?? null,
    transcript: update.transcript ?? null,
    minutes: update.minutes ?? null,
    expectedContent: update.expectedContent ?? null,
  });
}

export function meetingList(): Promise<MeetingRecord[]> {
  return invoke("meeting_list");
}

export function meetingGet(meetingId: string): Promise<MeetingRecord> {
  return invoke("meeting_get", { meetingId });
}

export function meetingJobActive(meetingId: string): Promise<boolean> {
  return invoke("meeting_job_active", { meetingId });
}

export function meetingExport(meetingId: string, kind: "audio" | "minutes" | "minutes_docx" | "minutes_pdf" | "transcript" | "srt"): Promise<string | null> {
  return invoke("meeting_export", { meetingId, kind });
}

export function meetingDelete(meetingId: string): Promise<void> {
  return invoke("meeting_delete", { meetingId });
}

export function meetingOpenAudio(meetingId: string): Promise<void> {
  return invoke("meeting_open_audio", { meetingId });
}

export function formatMeetingDuration(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  return [Math.floor(value / 3600), Math.floor((value % 3600) / 60), value % 60]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

interface RecorderSnapshot {
  meeting: MeetingRecord | null;
  active: boolean;
  paused: boolean;
  level: number;
  error: string | null;
  source: RecordingSource | null;
  pendingSave: boolean;
}

type RecorderListener = (snapshot: RecorderSnapshot) => void;

/**
 * Process-lifetime recorder. It lives outside React so navigating away from
 * the workbench does not silently stop a long meeting.
 */
class MeetingRecorder {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private listeners = new Set<RecorderListener>();
  private pending: number[] = [];
  private writeQueue: number[][] = [];
  private uploadChain: Promise<void> = Promise.resolve();
  private lastWriteError: Error | null = null;
  private phase = 0;
  private aggregate = 0;
  private aggregateCount = 0;
  private nativePoll: number | null = null;
  private nativePollBusy = false;
  private starting = false;
  private startOperation: Promise<MeetingRecord> | null = null;
  private startAttempt: { cancelled: boolean } | null = null;
  private exitPreparing = false;
  private stopOperation: Promise<MeetingRecord> | null = null;
  private pauseOperation: Promise<void> | null = null;
  private snapshot: RecorderSnapshot = {
    meeting: null,
    active: false,
    paused: false,
    level: 0,
    error: null,
    source: null,
    pendingSave: false,
  };

  subscribe(listener: RecorderListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  current(): RecorderSnapshot {
    return this.snapshot;
  }

  private publish(update: Partial<RecorderSnapshot>) {
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) listener(this.snapshot);
  }

  start(title: string, modelId: string, providerId: string, source: RecordingSource = "microphone"): Promise<MeetingRecord> {
    if (this.exitPreparing) return Promise.reject(new Error("应用正在准备退出，暂不能开始录音"));
    if (this.snapshot.active || this.starting || this.stopOperation) return Promise.reject(new Error("已有会议正在录音，请先结束当前录音"));
    const attempt = { cancelled: false };
    this.startAttempt = attempt;
    this.starting = true;
    this.startOperation = this.startRecording(title, modelId, providerId, source, attempt).finally(() => {
      this.starting = false;
      this.startOperation = null;
      this.startAttempt = null;
    });
    return this.startOperation;
  }

  /** Freeze admission before inspecting the snapshot, then settle any startup. */
  async prepareForExit(): Promise<void> {
    this.exitPreparing = true;
    if (this.startAttempt) this.startAttempt.cancelled = true;
    await this.startOperation?.catch(() => undefined);
  }

  resumeAfterExitFailure(): void {
    this.exitPreparing = false;
  }

  private ensureStartAllowed(attempt: { cancelled: boolean }): void {
    if (attempt.cancelled || this.exitPreparing) throw new Error("录音启动已取消：应用正在准备退出");
  }

  private async startRecording(title: string, modelId: string, providerId: string, source: RecordingSource, attempt: { cancelled: boolean }): Promise<MeetingRecord> {
    this.publish({ error: null });
    // A connection may have changed since the panel's readiness check.
    await meetingCheckConnection(modelId, providerId);
    this.ensureStartAllowed(attempt);
    if (source !== "microphone") {
      let meeting: MeetingRecord | null = null;
      try {
        meeting = await meetingCreate(title, modelId, providerId, source);
        this.ensureStartAllowed(attempt);
        const status = await meetingCaptureStart(meeting.id, source);
        this.publish({ meeting, active: true, paused: status.paused, level: status.level, error: status.error ?? null, source, pendingSave: status.pendingSave ?? false });
        this.startNativePolling();
        return meeting;
      } catch (error) {
        if (meeting) await meetingDelete(meeting.id).catch(() => undefined);
        throw error;
      }
    }
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("当前系统不支持麦克风录音");
    return this.startMicrophone(title, modelId, providerId, attempt);
  }

  private async startMicrophone(title: string, modelId: string, providerId: string, attempt: { cancelled: boolean }): Promise<MeetingRecord> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    let meeting: MeetingRecord | null = null;
    try {
      this.ensureStartAllowed(attempt);
      meeting = await meetingCreate(title, modelId, providerId, "microphone");
      this.ensureStartAllowed(attempt);
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      // ScriptProcessor remains the most consistently available PCM callback
      // in WKWebView and WebView2. Small five-second native writes bound memory.
      const processor = context.createScriptProcessor(4096, source.channelCount || 1, 1);
      processor.onaudioprocess = (event) => this.consume(event.inputBuffer);
      source.connect(processor);
      processor.connect(context.destination);
      this.stream = stream;
      this.context = context;
      this.source = source;
      this.processor = processor;
      this.pending = [];
      this.writeQueue = [];
      this.lastWriteError = null;
      this.phase = 0;
      this.aggregate = 0;
      this.aggregateCount = 0;
      this.uploadChain = Promise.resolve();
      this.publish({ meeting, active: true, paused: false, level: 0, error: null, source: "microphone" });
      return meeting;
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      if (meeting && meeting.recordedSamples === 0) {
        await meetingDelete(meeting.id).catch(() => undefined);
      }
      throw error;
    }
  }

  async syncNative(): Promise<void> {
    if (this.snapshot.active || this.starting || this.exitPreparing) return;
    const status = await meetingCaptureStatus();
    if (!status) return;
    const meeting = await meetingGet(status.meetingId);
    if (this.snapshot.active || this.starting || this.exitPreparing) return;
    const source = meeting.captureSource === "both" ? "both" : "system";
    this.publish({ meeting, active: true, paused: status.paused, level: status.level, error: status.error ?? null, source, pendingSave: status.pendingSave ?? false });
    this.startNativePolling();
  }

  private startNativePolling() {
    if (this.nativePoll !== null) window.clearInterval(this.nativePoll);
    this.nativePoll = window.setInterval(() => void this.pollNative(), 500);
  }

  private async pollNative() {
    if (this.nativePollBusy || !this.snapshot.active || this.snapshot.source === "microphone") return;
    this.nativePollBusy = true;
    try {
      const status = await meetingCaptureStatus();
      if (!status || status.meetingId !== this.snapshot.meeting?.id) return;
      this.publish({ paused: status.paused, level: status.level, error: status.error ?? null, pendingSave: status.pendingSave ?? false });
      if (status.recordedSamples !== this.snapshot.meeting.recordedSamples) {
        const meeting = await meetingGet(status.meetingId);
        if (this.snapshot.active && this.snapshot.meeting?.id === status.meetingId) this.publish({ meeting });
      }
    } catch (error) {
      this.publish({ error: String(error).replace(/^Error:\s*/, "") });
    } finally {
      this.nativePollBusy = false;
    }
  }

  private stopNativePolling() {
    if (this.nativePoll !== null) window.clearInterval(this.nativePoll);
    this.nativePoll = null;
  }

  private consume(buffer: AudioBuffer) {
    if (!this.snapshot.active || this.snapshot.paused) return;
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
    let peak = 0;
    for (let index = 0; index < buffer.length; index += 1) {
      let mono = 0;
      for (const channel of channels) mono += channel[index] ?? 0;
      mono /= channels.length || 1;
      peak = Math.max(peak, Math.abs(mono));
      this.aggregate += mono;
      this.aggregateCount += 1;
      this.phase += 16_000;
      while (this.phase >= buffer.sampleRate) {
        const averaged = this.aggregateCount > 0 ? this.aggregate / this.aggregateCount : mono;
        this.pending.push(Math.round(Math.max(-1, Math.min(1, averaged)) * 32767));
        this.phase -= buffer.sampleRate;
        this.aggregate = 0;
        this.aggregateCount = 0;
        if (buffer.sampleRate >= 16_000) break;
      }
    }
    this.publish({ level: Math.min(1, peak * 2.5) });
    if (this.pending.length >= 16_000 * 5) this.flush();
  }

  private flush() {
    const meetingId = this.snapshot.meeting?.id;
    if (!meetingId) return;
    if (this.pending.length > 0) this.writeQueue.push(this.pending.splice(0, this.pending.length));
    if (this.writeQueue.length === 0) return;
    if (this.writeQueue.length >= 3) {
      this.publish({ paused: true, level: 0, error: "录音写入较慢，已暂停；请等待写入完成后继续" });
    }
    this.uploadChain = this.uploadChain
      .then(async () => {
        while (this.writeQueue.length > 0) {
          try {
            const meeting = await meetingAppendPcm(meetingId, this.writeQueue[0]);
            this.writeQueue.shift();
            this.lastWriteError = null;
            this.publish({ meeting, error: null });
          } catch (error) {
            this.lastWriteError = error instanceof Error ? error : new Error(String(error));
            this.publish({ paused: true, level: 0, error: String(error).replace(/^Error:\s*/, "") });
            return;
          }
        }
      });
  }

  private async ensureFlushed(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      this.flush();
      await this.uploadChain;
      if (this.writeQueue.length === 0 && this.pending.length === 0) return;
      await new Promise((resolve) => window.setTimeout(resolve, 200 * (attempt + 1)));
    }
    throw this.lastWriteError ?? new Error("录音写入失败，请检查磁盘空间后重试");
  }

  setPaused(paused: boolean): Promise<void> {
    if (this.stopOperation) return Promise.reject(new Error("正在结束录音，请稍后重试"));
    if (this.pauseOperation) return Promise.reject(new Error("正在切换录音状态，请稍后重试"));
    this.pauseOperation = this.applyPaused(paused).finally(() => { this.pauseOperation = null; });
    return this.pauseOperation;
  }

  private async applyPaused(paused: boolean): Promise<void> {
    const meeting = this.snapshot.meeting;
    if (!meeting || !this.snapshot.active) return;
    if (this.snapshot.pendingSave) throw new Error("录音已停止，请先重试保存");
    if (this.snapshot.source !== "microphone") {
      const updated = await meetingCapturePause(meeting.id, paused);
      this.publish({ meeting: updated, paused, level: 0, error: null });
      return;
    }
    const previousPaused = this.snapshot.paused;
    if (paused) this.publish({ paused: true, level: 0 });
    try {
      if (paused || this.writeQueue.length > 0 || this.pending.length > 0) await this.ensureFlushed();
      const updated = await meetingSetPaused(meeting.id, paused);
      this.publish({ meeting: updated, paused, level: 0, error: null });
    } catch (error) {
      this.publish({ paused: previousPaused || this.writeQueue.length > 0 || this.lastWriteError !== null, error: String(error).replace(/^Error:\s*/, "") });
      throw error;
    }
  }

  stop(): Promise<MeetingRecord> {
    // A toolbar action and a controlled exit may stop the same recording.
    // Share one native finalization so the second caller cannot see a removed
    // capture or race a pending disk write.
    this.stopOperation ??= Promise.resolve()
      .then(async () => {
        await this.startOperation?.catch(() => undefined);
        if (this.pauseOperation) await this.pauseOperation.catch(() => undefined);
        return this.finishRecording();
      })
      .finally(() => { this.stopOperation = null; });
    return this.stopOperation;
  }

  private async finishRecording(): Promise<MeetingRecord> {
    const meeting = this.snapshot.meeting;
    if (!meeting || !this.snapshot.active) throw new Error("当前没有正在进行的录音");
    if (this.snapshot.source !== "microphone") {
      try {
        const completed = await meetingCaptureStop(meeting.id);
        this.stopNativePolling();
        this.publish({ meeting: completed, active: false, paused: false, level: 0, error: null, source: null, pendingSave: false });
        return completed;
      } catch (error) {
        const status = await meetingCaptureStatus().catch(() => null);
        if (status) {
          this.publish({ paused: status.paused, pendingSave: status.pendingSave ?? false, level: 0, error: String(error).replace(/^Error:\s*/, "") });
        } else {
          this.stopNativePolling();
          const latest = await meetingGet(meeting.id).catch(() => meeting);
          this.publish({ meeting: latest, active: false, paused: false, level: 0, error: String(error), source: null });
        }
        throw error;
      }
    }
    // Stop accepting PCM before releasing the microphone. Keep the buffered
    // audio and its recovery entry until every native write has succeeded.
    this.publish({ paused: true, pendingSave: true, level: 0 });
    this.processor?.disconnect();
    this.source?.disconnect();
    this.processor = null;
    this.source = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    await this.context?.close().catch(() => undefined);
    this.context = null;
    try {
      await this.ensureFlushed();
      if (!this.snapshot.meeting?.recordedSamples) {
        await meetingDelete(meeting.id);
        this.publish({ meeting: null, active: false, paused: false, level: 0, source: null, pendingSave: false });
        throw new Error("未录到音频，空记录已移除，请重新开始录音");
      }
      const completed = await meetingFinishRecording(meeting.id);
      this.publish({ meeting: completed, active: false, paused: false, level: 0, source: null, pendingSave: false, error: null });
      return completed;
    } catch (error) {
      this.publish({ level: 0, error: String(error).replace(/^Error:\s*/, "") });
      throw error;
    }
  }
}

export const meetingRecorder = new MeetingRecorder();
