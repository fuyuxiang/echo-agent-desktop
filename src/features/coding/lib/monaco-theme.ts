import type * as Monaco from "monaco-editor";

export const ECHO_MONACO_THEMES = {
  light: "echo-light",
  dark: "echo-dark",
  highContrastLight: "echo-hc-light",
  highContrastDark: "echo-hc-dark",
} as const;

export type EchoMonacoTheme = (typeof ECHO_MONACO_THEMES)[keyof typeof ECHO_MONACO_THEMES];

interface ThemePalette {
  base: Monaco.editor.BuiltinTheme;
  foreground: string;
  background: string;
  comment: string;
  keyword: string;
  string: string;
  type: string;
  number: string;
  invalid: string;
  property: string;
  callable: string;
  delimiter: string;
  cursor: string;
  selection: string;
  selectionForeground?: string;
  inactiveSelection: string;
  selectionHighlight: string;
  lineNumber: string;
  activeLineNumber: string;
  lineHighlight: string;
  whitespace: string;
  indentGuide: string;
  activeIndentGuide: string;
  focusBorder: string;
}

const palettes: Record<EchoMonacoTheme, ThemePalette> = {
  [ECHO_MONACO_THEMES.light]: {
    base: "vs",
    foreground: "#24292F",
    background: "#FFFFFF",
    comment: "#57606A",
    keyword: "#CF222E",
    string: "#0A3069",
    type: "#8250DF",
    number: "#0550AE",
    invalid: "#B42318",
    property: "#953800",
    callable: "#116329",
    delimiter: "#57606A",
    cursor: "#111827",
    selection: "#B4D7FF",
    inactiveSelection: "#DCEBFA",
    selectionHighlight: "#DDEBFA99",
    lineNumber: "#6E7781",
    activeLineNumber: "#24292F",
    lineHighlight: "#F6F8FA",
    whitespace: "#8C959F66",
    indentGuide: "#D0D7DE",
    activeIndentGuide: "#8C959F",
    focusBorder: "#0969DA",
  },
  [ECHO_MONACO_THEMES.dark]: {
    base: "vs-dark",
    foreground: "#D4D4D4",
    background: "#1E1E1E",
    comment: "#6A9955",
    keyword: "#C586C0",
    string: "#CE9178",
    type: "#4EC9B0",
    number: "#B5CEA8",
    invalid: "#F44747",
    property: "#9CDCFE",
    callable: "#DCDCAA",
    delimiter: "#A0A0A0",
    cursor: "#FFFFFF",
    selection: "#264F78",
    inactiveSelection: "#333A42",
    selectionHighlight: "#264F7866",
    lineNumber: "#858585",
    activeLineNumber: "#C6C6C6",
    lineHighlight: "#2A2D2E",
    whitespace: "#E3E4E229",
    indentGuide: "#404040",
    activeIndentGuide: "#707070",
    focusBorder: "#007FD4",
  },
  [ECHO_MONACO_THEMES.highContrastLight]: {
    base: "hc-light",
    foreground: "#000000",
    background: "#FFFFFF",
    comment: "#3B3B3B",
    keyword: "#0000C0",
    string: "#7A1A00",
    type: "#5900A6",
    number: "#005A24",
    invalid: "#B00020",
    property: "#7A3600",
    callable: "#005A24",
    delimiter: "#000000",
    cursor: "#000000",
    selection: "#99C7FF",
    selectionForeground: "#000000",
    inactiveSelection: "#C8DDF5",
    selectionHighlight: "#99C7FF80",
    lineNumber: "#292929",
    activeLineNumber: "#000000",
    lineHighlight: "#F0F5FA",
    whitespace: "#595959",
    indentGuide: "#767676",
    activeIndentGuide: "#000000",
    focusBorder: "#0F4A85",
  },
  [ECHO_MONACO_THEMES.highContrastDark]: {
    base: "hc-black",
    foreground: "#FFFFFF",
    background: "#000000",
    comment: "#9CDC8C",
    keyword: "#6CB6FF",
    string: "#FFD580",
    type: "#D2A8FF",
    number: "#B5F4A5",
    invalid: "#FF7B72",
    property: "#79C0FF",
    callable: "#FFF68F",
    delimiter: "#E6E6E6",
    cursor: "#FFFFFF",
    selection: "#005FB8",
    selectionForeground: "#FFFFFF",
    inactiveSelection: "#173B5E",
    selectionHighlight: "#005FB880",
    lineNumber: "#D0D0D0",
    activeLineNumber: "#FFFFFF",
    lineHighlight: "#151515",
    whitespace: "#BFBFBF",
    indentGuide: "#6B6B6B",
    activeIndentGuide: "#FFFFFF",
    focusBorder: "#F38518",
  },
};

function withoutHash(color: string): string {
  return color.slice(1);
}

function themeData(palette: ThemePalette): Monaco.editor.IStandaloneThemeData {
  const foreground = withoutHash(palette.foreground);
  const background = withoutHash(palette.background);
  const comment = withoutHash(palette.comment);
  const keyword = withoutHash(palette.keyword);
  const string = withoutHash(palette.string);
  const type = withoutHash(palette.type);
  const number = withoutHash(palette.number);
  const invalid = withoutHash(palette.invalid);
  const property = withoutHash(palette.property);
  const callable = withoutHash(palette.callable);
  const delimiter = withoutHash(palette.delimiter);

  return {
    base: palette.base,
    // A self-contained token map makes the generated `.mtk*` indexes stable.
    // The scoped CSS fallback can therefore preserve syntax colors even when a
    // desktop WebView drops Monaco's dynamically injected theme stylesheet.
    inherit: false,
    encodedTokensColors: [
      palette.foreground,
      palette.background,
      palette.comment,
      palette.keyword,
      palette.string,
      palette.type,
      palette.number,
      palette.invalid,
      palette.property,
      palette.callable,
      palette.delimiter,
    ],
    rules: [
      { token: "", foreground, background },
      { token: "comment", foreground: comment, fontStyle: "italic" },
      { token: "keyword", foreground: keyword },
      { token: "keyword.flow", foreground: keyword },
      { token: "tag", foreground: keyword },
      { token: "string", foreground: string },
      { token: "string.escape", foreground: string },
      { token: "attribute.value", foreground: string },
      { token: "type", foreground: type },
      { token: "type.identifier", foreground: type },
      { token: "annotation", foreground: type },
      { token: "number", foreground: number },
      { token: "constant", foreground: number },
      { token: "regexp", foreground: invalid },
      { token: "invalid", foreground: invalid, fontStyle: "underline" },
      { token: "attribute.name", foreground: property },
      { token: "variable", foreground: property },
      { token: "variable.predefined", foreground: callable },
      { token: "function", foreground: callable },
      { token: "delimiter", foreground: delimiter },
      { token: "delimiter.bracket", foreground: delimiter },
      { token: "metatag", foreground: delimiter },
    ],
    colors: {
      "editor.background": palette.background,
      "editor.foreground": palette.foreground,
      "editorCursor.foreground": palette.cursor,
      "editor.selectionBackground": palette.selection,
      ...(palette.selectionForeground
        ? { "editor.selectionForeground": palette.selectionForeground }
        : {}),
      "editor.inactiveSelectionBackground": palette.inactiveSelection,
      "editor.selectionHighlightBackground": palette.selectionHighlight,
      "editor.lineHighlightBackground": palette.lineHighlight,
      "editorLineNumber.foreground": palette.lineNumber,
      "editorLineNumber.activeForeground": palette.activeLineNumber,
      "editorWhitespace.foreground": palette.whitespace,
      "editorIndentGuide.background1": palette.indentGuide,
      "editorIndentGuide.activeBackground1": palette.activeIndentGuide,
      "editorGutter.background": palette.background,
      "editorOverviewRuler.border": palette.indentGuide,
      focusBorder: palette.focusBorder,
    },
  };
}

export function installEchoMonacoThemes(monaco: typeof Monaco): void {
  for (const [name, palette] of Object.entries(palettes)) {
    monaco.editor.defineTheme(name, themeData(palette));
  }
}

export function resolveEchoMonacoTheme(
  appTheme: "light" | "dark",
  forcedColors: boolean,
): EchoMonacoTheme {
  if (forcedColors) {
    return appTheme === "dark"
      ? ECHO_MONACO_THEMES.highContrastDark
      : ECHO_MONACO_THEMES.highContrastLight;
  }
  return appTheme === "dark" ? ECHO_MONACO_THEMES.dark : ECHO_MONACO_THEMES.light;
}

export function hasMonacoRuntimeThemeStyles(root: Document = document): boolean {
  return Array.from(root.querySelectorAll<HTMLStyleElement>("style.monaco-colors"))
    .some((style) => (style.textContent ?? "").includes(".mtk1"));
}
