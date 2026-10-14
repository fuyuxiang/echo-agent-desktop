import type { MeetingRecord, TranscriptSegment } from "./meeting-minutes";

export interface MeetingDraftConflict {
  original: string;
  canKeep: boolean;
}

interface Draft<T> {
  base: T;
  value: T;
  conflict?: MeetingDraftConflict;
}

const copySegments = (segments: TranscriptSegment[]) => segments.map((segment) => ({ ...segment }));
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const transcriptText = (segments: TranscriptSegment[]) => segments
  .map((segment) => `[${segment.start}–${segment.end}] ${segment.speaker}：${segment.text}`).join("\n");

// Segment IDs are renumbered when an earlier failed chunk is recovered.
// Cached ASR timing stays stable; occurrence counts disambiguate equal ranges.
function segmentKeys(segments: TranscriptSegment[]): string[] {
  const counts = new Map<string, number>();
  return segments.map(({ start, end }) => {
    const range = JSON.stringify([start, end]);
    const occurrence = counts.get(range) ?? 0;
    counts.set(range, occurrence + 1);
    return `${range}:${occurrence}`;
  });
}

/** Process-lifetime drafts, rebased against each authoritative content snapshot. */
export function createMeetingDraftStore() {
  const transcripts = new Map<string, Draft<TranscriptSegment[]>>();
  const minutes = new Map<string, Draft<string> & { transcriptBase: string }>();

  const transcript = (record: MeetingRecord): Draft<TranscriptSegment[]> => {
    const draft = transcripts.get(record.id);
    if (!draft) return { base: record.transcript, value: record.transcript };
    // Processing clears the manifest before the new complete/partial result.
    if (record.status === "transcribing" && record.transcript.length === 0) return draft;
    if (same(draft.base, record.transcript)) return draft;

    const baseKeys = segmentKeys(draft.base);
    const valueKeys = segmentKeys(draft.value);
    const incomingKeys = segmentKeys(record.transcript);
    const edited = new Map(valueKeys.map((key, index) => [key, draft.value[index]]));
    const incoming = new Map(incomingKeys.map((key, index) => [key, index]));
    const merged = copySegments(record.transcript);
    let conflicting = false;
    let missing = false;
    draft.base.forEach((base, index) => {
      const local = edited.get(baseKeys[index]);
      if (!local) return;
      const fields = (["text", "speaker"] as const).filter((field) => local[field] !== base[field]);
      if (!fields.length) return;
      const target = incoming.get(baseKeys[index]);
      if (target === undefined) { missing = true; return; }
      for (const field of fields) {
        const latest = merged[target][field];
        if (latest !== base[field] && latest !== local[field]) conflicting = true;
        merged[target][field] = local[field];
      }
    });
    const conflict = draft.conflict || conflicting || missing ? {
      original: draft.conflict?.original ?? transcriptText(draft.value),
      canKeep: !missing && (draft.conflict?.canKeep ?? true),
    } : undefined;
    const next = { base: copySegments(record.transcript), value: merged, conflict };
    if (!conflict && same(merged, record.transcript)) transcripts.delete(record.id);
    else transcripts.set(record.id, next);
    return next;
  };

  const minute = (record: MeetingRecord): Draft<string> => {
    const draft = minutes.get(record.id);
    const latest = record.minutes ?? "";
    if (!draft) return { base: latest, value: latest };
    if (draft.base === latest && draft.transcriptBase === JSON.stringify(record.transcript)) return draft;
    if (draft.value === latest && !draft.conflict) {
      minutes.delete(record.id);
      return { base: latest, value: latest };
    }
    const next = { ...draft, base: latest, transcriptBase: JSON.stringify(record.transcript),
      conflict: draft.conflict ?? { original: draft.value, canKeep: true } };
    minutes.set(record.id, next);
    return next;
  };

  return {
    transcript,
    minutes: minute,
    editTranscript(record: MeetingRecord, value: TranscriptSegment[]) {
      const draft = transcript(record);
      if (!draft.conflict && same(value, record.transcript)) transcripts.delete(record.id);
      else transcripts.set(record.id, { ...draft, base: copySegments(draft.base), value: copySegments(value) });
    },
    editMinutes(record: MeetingRecord, value: string) {
      const draft = minute(record);
      if (!draft.conflict && value === (record.minutes ?? "")) minutes.delete(record.id);
      else minutes.set(record.id, { ...draft, value, transcriptBase: JSON.stringify(record.transcript) });
    },
    acceptTranscript(record: MeetingRecord) {
      const draft = transcript(record);
      if (draft.conflict?.canKeep === false) return;
      transcripts.set(record.id, { base: copySegments(record.transcript), value: copySegments(draft.value) });
    },
    acceptMinutes(record: MeetingRecord) {
      const draft = minute(record);
      minutes.set(record.id, { base: record.minutes ?? "", value: draft.value,
        transcriptBase: JSON.stringify(record.transcript) });
    },
    savedTranscript(record: MeetingRecord, submitted: TranscriptSegment[]) {
      const draft = transcripts.get(record.id);
      if (!draft || same(draft.value, submitted)) transcripts.delete(record.id);
      else transcripts.set(record.id, { ...draft, base: copySegments(record.transcript) });
    },
    savedMinutes(record: MeetingRecord, submitted: string) {
      const draft = minutes.get(record.id);
      if (!draft || draft.value === submitted) minutes.delete(record.id);
      else minutes.set(record.id, { ...draft, base: record.minutes ?? "", transcriptBase: JSON.stringify(record.transcript) });
    },
    hasMinutes: (id: string) => minutes.has(id),
    hasTranscript: (id: string) => transcripts.has(id),
    discardTranscript: (id: string) => { transcripts.delete(id); },
    discardMinutes: (id: string) => { minutes.delete(id); },
    remove(id: string) { transcripts.delete(id); minutes.delete(id); },
    clear() { transcripts.clear(); minutes.clear(); },
  };
}

export const meetingDrafts = createMeetingDraftStore();
