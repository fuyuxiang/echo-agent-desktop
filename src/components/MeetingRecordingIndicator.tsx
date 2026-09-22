import { useEffect, useState } from "react";
import { CircleStop, Mic, Pause, Play } from "lucide-react";
import { formatMeetingDuration, meetingRecorder } from "@/lib/meeting-minutes";

export function MeetingRecordingIndicator({
  onOpen,
  onToast,
}: {
  onOpen: (modelId?: string) => void;
  onToast?: (message: string) => void;
}) {
  const [snapshot, setSnapshot] = useState(meetingRecorder.current());
  const [pending, setPending] = useState(false);
  useEffect(() => meetingRecorder.subscribe(setSnapshot), []);
  if (!snapshot.active || !snapshot.meeting) return null;

  const toggle = async () => {
    setPending(true);
    try {
      await meetingRecorder.setPaused(!snapshot.paused);
    } catch (error) {
      onToast?.(`切换录音状态失败：${String(error).replace(/^Error:\s*/, "")}`);
    } finally {
      setPending(false);
    }
  };
  const stop = async () => {
    setPending(true);
    try {
      await meetingRecorder.stop();
      onOpen(snapshot.meeting?.modelId);
      onToast?.("录音已保存，可以开始转写");
    } catch (error) {
      onToast?.(`结束录音失败：${String(error).replace(/^Error:\s*/, "")}`);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="meeting-global-recorder" role="status" aria-live="polite">
      <button className="meeting-global-recorder__main" type="button" onClick={() => onOpen(snapshot.meeting?.modelId)} title="打开录音转写工作台">
        <span className="meeting-global-recorder__dot"><Mic size={14} /></span>
        <span><strong>{snapshot.paused ? "录音已暂停" : "正在录音"}</strong><small>{formatMeetingDuration(snapshot.meeting.durationSeconds)}</small></span>
      </button>
      <button type="button" onClick={() => void toggle()} disabled={pending} aria-label={snapshot.paused ? "继续录音" : "暂停录音"}>{snapshot.paused ? <Play size={14} /> : <Pause size={14} />}</button>
      <button type="button" onClick={() => void stop()} disabled={pending} aria-label="结束并保存录音"><CircleStop size={14} /></button>
    </div>
  );
}
