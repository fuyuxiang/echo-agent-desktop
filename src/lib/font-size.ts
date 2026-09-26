export const FONT_SIZE_KEY = "echoagent.fontSize";
export const DEFAULT_FONT_SIZE = 13;
export const MIN_FONT_SIZE = 11;
export const MAX_FONT_SIZE = 18;

export function normalizeFontSize(value: unknown): number {
  const size = Number(value);
  return Number.isInteger(size) && size >= MIN_FONT_SIZE && size <= MAX_FONT_SIZE
    ? size
    : DEFAULT_FONT_SIZE;
}

export function readFontSize(): number {
  try {
    return normalizeFontSize(localStorage.getItem(FONT_SIZE_KEY));
  } catch {
    return DEFAULT_FONT_SIZE;
  }
}

export function applyFontSize(size: number): void {
  // Existing typography was authored against a 16px root and a 13px body.
  // rem-based font sizes keep those exact defaults while scaling every view.
  document.documentElement.style.fontSize = `${(16 * normalizeFontSize(size)) / DEFAULT_FONT_SIZE}px`;
}

export function saveFontSize(size: number): void {
  const normalized = normalizeFontSize(size);
  applyFontSize(normalized);
  try {
    localStorage.setItem(FONT_SIZE_KEY, String(normalized));
  } catch {
    // Keep the active preference usable when storage is unavailable.
  }
}
