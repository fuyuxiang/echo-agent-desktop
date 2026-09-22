import { ChevronDown } from "lucide-react";

export interface FooterStatusBarProps {
  cursor: { line: number; column: number } | null;
  eol: "LF" | "CRLF" | null;
  language: string | null;
  indent: { kind: "space" | "tab"; size: number };
  onEolChange: (next: "LF" | "CRLF") => void;
  onIndentChange: (next: { kind: "space" | "tab"; size: number }) => void;
  onLanguageChange: (next: string) => void;
  taskSummary: string;
  problemCount: number;
  indexing: boolean;
  changeSetMode: "filesystem" | "git" | "ready";
}

const LANGUAGE_LABEL: Record<string, string> = {
  typescript: "TypeScript",
  javascript: "JavaScript",
  python: "Python",
  rust: "Rust",
  go: "Go",
  java: "Java",
  kotlin: "Kotlin",
  csharp: "C#",
  markdown: "Markdown",
  json: "JSON",
  yaml: "YAML",
  toml: "TOML",
  shell: "Shell",
  sql: "SQL",
  html: "HTML",
  css: "CSS",
  scss: "SCSS",
};

function languageLabel(id: string): string {
  return LANGUAGE_LABEL[id] ?? id.toUpperCase();
}

export function FooterStatusBar({
  cursor,
  eol,
  language,
  indent,
  onEolChange,
  onIndentChange,
  onLanguageChange,
  taskSummary,
  problemCount,
  indexing,
  changeSetMode,
}: FooterStatusBarProps) {
  const cursorText = cursor ? `第 ${cursor.line} 行，第 ${cursor.column} 列` : "——";
  const eolText = eol ?? "——";
  const langText = language ? languageLabel(language) : "——";
  const indentText = indent.kind === "tab"
    ? `Tab 缩进`
    : `Spaces: ${indent.size}`;

  return (
    <footer className="coding-workbench__status" role="status" aria-label="工作台状态">
      <span>{taskSummary}</span>
      {problemCount > 0 && (
        <button type="button" className="coding-workbench__status-problem">
          {problemCount} 个问题
        </button>
      )}
      <span className="coding-workbench__status-spacer" />
      {indexing && <span>正在建立文件索引…</span>}
      <span>
        {changeSetMode === "filesystem"
          ? "本地检查点"
          : changeSetMode === "git"
            ? "Git 基线"
            : "Agent 就绪"}
      </span>
      <span className="coding-workbench__status-divider" />
      <button type="button" title="光标位置" className="coding-workbench__status-chip">
        {cursorText}
      </button>
      <button
        type="button"
        aria-label="换行符（点击切换）"
        title="点击切换换行符"
        className="coding-workbench__status-chip"
        onClick={() => onEolChange(eol === "CRLF" ? "LF" : "CRLF")}
      >
        {eolText} <ChevronDown size={10} />
      </button>
      <button
        type="button"
        aria-label="缩进设置（点击切换）"
        title="点击切换缩进"
        className="coding-workbench__status-chip"
        onClick={() => {
          const sizes = [2, 4, 8];
          const next = indent.kind === "tab"
            ? { kind: "space" as const, size: 2 }
            : sizes.includes(indent.size)
              ? { kind: "space" as const, size: sizes[(sizes.indexOf(indent.size) + 1) % sizes.length] }
              : { kind: "tab" as const, size: indent.size };
          onIndentChange(next);
        }}
      >
        {indentText} <ChevronDown size={10} />
      </button>
      <button
        type="button"
        title="点击切换语言"
        className="coding-workbench__status-chip"
        onClick={() => onLanguageChange(language ?? "plaintext")}
      >
        {langText} <ChevronDown size={10} />
      </button>
      <button
        type="button"
        title="文件编码"
        className="coding-workbench__status-chip coding-workbench__status-chip--readonly"
      >
        UTF-8
      </button>
    </footer>
  );
}