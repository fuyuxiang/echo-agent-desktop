import { invoke } from "@tauri-apps/api/core";

export type MeetingStatus =
  | "recording"
  | "paused"
  | "importing"
  | "recorded"
  | "transcribing"
  | "summarizing"
  | "transcribed"
  | "partial"
  | "failed"
  | "completed";

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
  transcript: TranscriptSegment[];
  transcriptText?: string;
  minutes?: string;
  chunks: MeetingChunk[];
  error?: string;
}

export function meetingCreate(title: string, modelId: string, providerId: string): Promise<MeetingRecord> {
  return invoke("meeting_create", { title, modelId, providerId });
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

export function meetingProcess(meetingId: string): Promise<MeetingRecord> {
  return invoke("meeting_process", { meetingId });
}

export function meetingRegenerateMinutes(meetingId: string): Promise<MeetingRecord> {
  return invoke("meeting_regenerate_minutes", { meetingId });
}

export function meetingUpdate(
  meetingId: string,
  update: { title?: string; transcript?: TranscriptSegment[] },
): Promise<MeetingRecord> {
  return invoke("meeting_update", {
    meetingId,
    title: update.title ?? null,
    transcript: update.transcript ?? null,
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

export function meetingExport(meetingId: string, kind: "audio" | "minutes" | "transcript" | "srt"): Promise<string | null> {
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
  private snapshot: RecorderSnapshot = {
    meeting: null,
    active: false,
    paused: false,
    level: 0,
    error: null,
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

  async start(title: string, modelId: string, providerId: string): Promise<MeetingRecord> {
    if (this.snapshot.active) throw new Error("已有会议正在录音，请先结束当前录音");
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("当前系统不支持麦克风录音");
    this.publish({ error: null });
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
      meeting = await meetingCreate(title, modelId, providerId);
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
      this.publish({ meeting, active: true, paused: false, level: 0, error: null });
      return meeting;
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      if (meeting && meeting.recordedSamples === 0) {
        await meetingDelete(meeting.id).catch(() => undefined);
      }
      throw error;
    }
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
            this.publish({ error: String(error).replace(/^Error:\s*/, "") });
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

  async setPaused(paused: boolean): Promise<void> {
    const meeting = this.snapshot.meeting;
    if (!meeting || !this.snapshot.active) return;
    if (paused) await this.ensureFlushed();
    const updated = await meetingSetPaused(meeting.id, paused);
    this.publish({ meeting: updated, paused, level: 0 });
  }

  async stop(): Promise<MeetingRecord> {
    const meeting = this.snapshot.meeting;
    if (!meeting || !this.snapshot.active) throw new Error("当前没有正在进行的录音");
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
      const completed = await meetingFinishRecording(meeting.id);
      this.publish({ meeting: completed, active: false, paused: false, level: 0 });
      return completed;
    } catch (error) {
      this.publish({ active: false, paused: false, level: 0, error: String(error) });
      throw error;
    }
  }
}

export const meetingRecorder = new MeetingRecorder();
