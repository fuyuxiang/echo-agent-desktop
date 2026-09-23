import { useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Popover } from "@/components/workspace-panel/Overlay";

export interface FooterStatusBarProps {
  cursor: { line: number; column: number } | null;
  eol: "LF" | "CRLF" | null;
  language: string | null;
  indent: { kind: "space" | "tab"; size: number };
  editorEditable?: boolean;
  onEolChange: (next: "LF" | "CRLF") => void;
  onIndentChange: (next: { kind: "space" | "tab"; size: number }) => void;
  onLanguageChange: (next: string) => void;
  onOpenProblems?: () => void;
  taskSummary: string;
  problemCount: number;
  indexing: boolean;
  changeSetMode: "filesystem" | "git" | "ready";
}

const LANGUAGE_LABEL: Record<string, string> = {
  plaintext: "纯文本",
  typescript: "TypeScript",
  javascript: "JavaScript",
  typescriptreact: "TypeScript React",
  javascriptreact: "JavaScript React",
  python: "Python",
  rust: "Rust",
  go: "Go",
  java: "Java",
  kotlin: "Kotlin",
  csharp: "C#",
  markdown: "Markdown",
  json: "JSON",
  yaml: "YAML",
  ini: "INI / TOML",
  shell: "Shell",
  sql: "SQL",
  html: "HTML",
  css: "CSS",
  scss: "SCSS",
  less: "Less",
  xml: "XML / SVG",
  c: "C",
  cpp: "C++",
};

const LANGUAGE_OPTIONS = Object.entries(LANGUAGE_LABEL);

function languageLabel(id: string): string {
  return LANGUAGE_LABEL[id] ?? id.toUpperCase();
}

export function FooterStatusBar({
  cursor,
  eol,
  language,
  indent,
  editorEditable = true,
  onEolChange,
  onIndentChange,
  onLanguageChange,
  onOpenProblems,
  taskSummary,
  problemCount,
  indexing,
  changeSetMode,
}: FooterStatusBarProps) {
  const [menu, setMenu] = useState<"eol" | "indent" | "language" | null>(null);
  const eolRef = useRef<HTMLButtonElement | null>(null);
  const indentRef = useRef<HTMLButtonElement | null>(null);
  const languageRef = useRef<HTMLButtonElement | null>(null);
  const cursorText = cursor ? `第 ${cursor.line} 行，第 ${cursor.column} 列` : "——";
  const eolText = eol ?? "——";
  const langText = language ? languageLabel(language) : "——";
  const indentText = indent.kind === "tab"
    ? `Tab 缩进`
    : `Spaces: ${indent.size}`;

  return (
    <footer className="coding-workbench__status" aria-label="工作台状态">
      <span role="status" aria-label="任务状态" aria-live="polite">{taskSummary}</span>
      {problemCount > 0 && (
        <button type="button" className="coding-workbench__status-problem" onClick={onOpenProblems}>
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
      <span title="光标位置" className="coding-workbench__status-chip coding-workbench__status-chip--readonly">
        {cursorText}
      </span>
      <button
        ref={eolRef}
        type="button"
        aria-label="选择换行符"
        aria-haspopup="menu"
        aria-expanded={menu === "eol"}
        className="coding-workbench__status-chip"
        disabled={!editorEditable}
        onClick={() => setMenu(menu === "eol" ? null : "eol")}
      >
        {eolText} <ChevronDown size={10} />
      </button>
      <Popover open={menu === "eol"} onClose={() => setMenu(null)} anchorRef={eolRef} role="menu" ariaLabel="换行符">
        <div className="coding-status-menu">
          {(["LF", "CRLF"] as const).map((value) => (
            <button key={value} type="button" role="menuitemradio" aria-checked={eol === value} onClick={() => { onEolChange(value); setMenu(null); }}>
              {value}
            </button>
          ))}
        </div>
      </Popover>
      <button
        ref={indentRef}
        type="button"
        aria-label="选择缩进设置"
        aria-haspopup="menu"
        aria-expanded={menu === "indent"}
        className="coding-workbench__status-chip"
        disabled={!editorEditable}
        onClick={() => setMenu(menu === "indent" ? null : "indent")}
      >
        {indentText} <ChevronDown size={10} />
      </button>
      <Popover open={menu === "indent"} onClose={() => setMenu(null)} anchorRef={indentRef} role="menu" ariaLabel="缩进设置">
        <div className="coding-status-menu">
          <button type="button" role="menuitemradio" aria-checked={indent.kind === "tab"} onClick={() => { onIndentChange({ kind: "tab", size: indent.size }); setMenu(null); }}>Tab 缩进</button>
          {[2, 4, 8].map((size) => (
            <button key={size} type="button" role="menuitemradio" aria-checked={indent.kind === "space" && indent.size === size} onClick={() => { onIndentChange({ kind: "space", size }); setMenu(null); }}>Spaces: {size}</button>
          ))}
        </div>
      </Popover>
      <button
        ref={languageRef}
        type="button"
        aria-label="选择语言模式"
        aria-haspopup="menu"
        aria-expanded={menu === "language"}
        className="coding-workbench__status-chip"
        disabled={!editorEditable}
        onClick={() => setMenu(menu === "language" ? null : "language")}
      >
        {langText} <ChevronDown size={10} />
      </button>
      <Popover open={menu === "language"} onClose={() => setMenu(null)} anchorRef={languageRef} role="menu" ariaLabel="语言模式">
        <div className="coding-status-menu coding-status-menu--languages">
          {LANGUAGE_OPTIONS.map(([id, label]) => (
            <button key={id} type="button" role="menuitemradio" aria-checked={language === id} onClick={() => { onLanguageChange(id); setMenu(null); }}>{label}</button>
          ))}
        </div>
      </Popover>
      <span title="文件编码" className="coding-workbench__status-chip coding-workbench__status-chip--readonly">UTF-8</span>
    </footer>
  );
}
