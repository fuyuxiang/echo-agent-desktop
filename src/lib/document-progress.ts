export interface DocumentProgress {
  source: string;
  revision: string;
  readRecords: number;
  totalRecords: number;
  checkpointCount: number;
  complete: boolean;
  sourcePath?: string;
  scope?: string;
  readPages?: number;
  totalPages?: number;
  updateSequence?: number;
  checkpointPath?: string;
}

/** Only accept the typed native ReadFile result; never parse model prose. */
export function documentProgressFromRawOutput(raw: unknown): DocumentProgress | undefined {
  if (!raw || typeof raw !== "object") return;
  const output = raw as Record<string, unknown>;
  if (output.type !== "ReadFile") return;
  const native = output.FileContent ?? output.PdfPageImages;
  if (!native || typeof native !== "object") return;
  const value = (native as Record<string, unknown>).document_progress;
  if (!value || typeof value !== "object") return;
  const p = value as Record<string, unknown>;
  if (typeof p.source !== "string" || p.source.length > 1024
    || typeof p.revision !== "string" || !/^[a-f0-9]{64}$/.test(p.revision)
    || !Number.isSafeInteger(p.readRecords) || !Number.isSafeInteger(p.totalRecords)
    || !Number.isSafeInteger(p.checkpointCount)
    || (p.readRecords as number) < 0 || (p.totalRecords as number) < 0
    || (p.readRecords as number) > (p.totalRecords as number)
    || (p.checkpointCount as number) < 0 || typeof p.complete !== "boolean") return;
  if (p.readPages !== undefined || p.totalPages !== undefined) {
    if (!Number.isSafeInteger(p.readPages) || !Number.isSafeInteger(p.totalPages)
      || (p.readPages as number) < 0 || (p.totalPages as number) < 0
      || (p.readPages as number) > (p.totalPages as number)) return;
  }
  const optional: Partial<DocumentProgress> = {};
  for (const key of ["sourcePath", "checkpointPath"] as const) {
    const path = p[key];
    if (typeof path === "string" && path.length <= 4096 && /^(?:\/|[A-Za-z]:[\\/])/.test(path)
      && !/[\u0000-\u001f]/.test(path)) optional[key] = path;
  }
  if (typeof p.scope === "string" && p.scope.length <= 1024) optional.scope = p.scope;
  if (Number.isSafeInteger(p.updateSequence) && (p.updateSequence as number) >= 0) {
    optional.updateSequence = p.updateSequence as number;
  }
  if (p.readPages !== undefined) {
    optional.readPages = p.readPages as number;
    optional.totalPages = p.totalPages as number;
  }
  return {
    source: p.source, revision: p.revision, readRecords: p.readRecords as number,
    totalRecords: p.totalRecords as number, checkpointCount: p.checkpointCount as number,
    complete: p.readRecords === p.totalRecords,
    ...optional,
  };
}

export function documentProgressLabel(p: DocumentProgress): string {
  return `${p.source} · 已读取 ${documentProgressCount(p, true)}`;
}

export function documentProgressCount(p: DocumentProgress, spaced = false): string {
  const [read, total, unit] = p.totalPages !== undefined && p.readPages !== undefined
    ? [p.readPages, p.totalPages, "页"] : [p.readRecords, p.totalRecords, "段内容"];
  return `${read.toLocaleString()}${spaced ? " / " : "/"}${total.toLocaleString()} ${unit}`;
}

/** Prefer the newest native snapshot even when parallel calls finish out of order. */
export function documentProgressSummary(progress: DocumentProgress[]): string | undefined {
  const sources = new Map<string, DocumentProgress>();
  for (const p of progress) {
    const key = p.sourcePath ?? p.source;
    const previous = sources.get(key);
    if (previous) {
      if (p.updateSequence !== undefined && previous.updateSequence !== undefined
        && p.updateSequence < previous.updateSequence) continue;
      if (p.updateSequence === undefined && previous.updateSequence === undefined
        && p.revision === previous.revision && p.readRecords < previous.readRecords) continue;
    }
    sources.set(key, p);
  }
  if (sources.size === 0) return;
  const values = [...sources.values()];
  if (values.length === 1) return `${values[0].source} · 已读取 ${documentProgressCount(values[0])}`;
  return `${values.length} 份资料 · 已读完 ${values.filter(p => p.complete).length} 份`;
}
