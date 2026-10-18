import "../../src/styles/index.css";
import ReactDOM from "react-dom/client";
import { useState } from "react";
import { MarkdownPreMermaid } from "../../src/components/markdown/MarkdownPreMermaid";
import { inspectDiagramImage } from "./mermaid-review-inspect.mjs";

const branches = [
  ["文件操作", "write", "grep", "search_replace", "read_file", "list_directory"],
  ["终端与子任务", "run_terminal_command", "get_command_or_subagent_output", "kill_command_or_subagent", "monitor"],
  ["协作与规划", "ask_user_question", "create_plan", "update_plan", "spawn_subagent", "list_tasks", "wait_for_completion"],
  ["浏览器", "browser_open", "browser_screenshot"],
  ["知识检索", "search_knowledge", "query_memory"],
  ["混合标签", "中文English_identifier混排标签", "包含中文与emoji👩‍💻的标签", "**加粗工具名称**", "identifier_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"],
  ["办公文档", "generate_document", "generate_spreadsheet"],
  ["交付", "export_artifact"],
];
const tools = ["mindmap", "  root((Agent 工具))", ...branches.flatMap(([label, ...leaves]) =>
  [`    ${label}`, ...leaves.map(leaf => `      ${leaf}`)])].join("\n");
const labels = ["Agent 工具", ...branches.flat()].map(label => label.replaceAll("**", ""));
const shapes = "mindmap\n  root((节点形状))\n    box[get_command_or_subagent_output]\n    rounded(一个很长的中文与English_identifier混排标签)\n    circle((ask_user_question))\n    cloud)cloud_node_with_a_very_long_identifier(\n    hex{{hexagon_node_with_a_very_long_identifier}}\n    bang))重要提示((";
const shapesLabels = ["节点形状", "get_command_or_subagent_output", "一个很长的中文与English_identifier混排标签", "ask_user_question", "cloud_node_with_a_very_long_identifier", "hexagon_node_with_a_very_long_identifier", "重要提示"];
const flowchart = "flowchart LR\n  A[技术革命] --> B{周期规律}\n  B -->|技术进步| C[慢 · 沉淀 · 复利]\n  B -->|人性波动| D[急 · 投机 · 泡沫]";
const longRoot = "very_long_root_identifier_" + "abcdefghijklmnopqrstuvwxyz".repeat(14);
const longChild = "very_long_child_identifier_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ".repeat(12);
const starEdges = (labels: string[]) => labels.slice(1).map(label => [labels[0], label]);
const circleLabels = [longRoot, longChild, "nearby_circle", "short_card"];
const breakLabels = ["显式换行", "one two three", "第一行 第二行 第三行", "one two three four five six", "nearby"];
const markdownLabels = ["Markdown 多行", "one two three", "加粗标题 第二段内容", "混合 English_identifier 第三行", "nearby"];
const toolsEdges = branches.flatMap(([parent, ...leaves]) => [["Agent 工具", parent],
  ...leaves.map(leaf => [parent, leaf.replaceAll("**", "")])]);
const fixtures = {
  tools: { kind: "mindmap", source: tools, labels, edges: toolsEdges },
  shapes: { kind: "mindmap", source: shapes, labels: shapesLabels, edges: starEdges(shapesLabels) },
  directives: { kind: "mindmap", source: '%%{init: {"layout":"cose-bilkent","themeCSS":".nodeLabel{white-space:nowrap!important}","htmlLabels":false}}%%\n' + tools, labels, edges: toolsEdges },
  "long-circle": { kind: "mindmap", source: `mindmap\n  root((${longRoot}))\n    child((${longChild}))\n    nearby((nearby_circle))\n    short_card`,
    labels: circleLabels, edges: starEdges(circleLabels), minLines: { [longRoot]: 10, [longChild]: 10 } },
  "explicit-breaks": { kind: "mindmap", source: "mindmap\n  root((显式换行))\n    a[one<br/>two<br>three]\n    b[第一行<br />第二行<br/>第三行]\n    c((one<br/>two<br/>three<br/>four<br/>five<br/>six))\n    nearby",
    labels: breakLabels, edges: starEdges(breakLabels), minLines: { "one two three": 3, "第一行 第二行 第三行": 3, "one two three four five six": 6 } },
  "markdown-multiline": { kind: "mindmap", source: 'mindmap\n  root((Markdown 多行))\n    a["`one\ntwo\nthree`"]\n    b["`**加粗标题**\n\n第二段内容`"]\n    c["`混合\nEnglish_identifier\n第三行`"]\n    nearby',
    labels: markdownLabels, edges: starEdges(markdownLabels), minLines: { "one two three": 3, "加粗标题 第二段内容": 2, "混合 English_identifier 第三行": 3 } },
  flowchart: { kind: "flowchart", source: flowchart, labels: ["技术革命", "周期规律", "技术进步", "人性波动", "慢 · 沉淀 · 复利", "急 · 投机 · 泡沫"], edges: 3 },
  "flowchart-custom": { kind: "flowchart", source: '%%{init: {"themeCSS":".node rect {fill: red !important;}","layout":"dagre"}}%%\nflowchart LR\n A[test] --> B[result]',
    labels: ["test", "result"], edges: 1 },
  invalid: { kind: "invalid", source: "mindmap\n root\n another_root", labels: [], edges: 0 },
};
const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "dark" ? "dark" : "light";
document.documentElement.dataset.theme = theme;
if (params.get("hostile") === "1") {
  const style = document.createElement("style");
  style.textContent = "*,*::before,*::after{transition-duration:0.01ms!important;animation-duration:0.01ms!important}";
  document.head.appendChild(style);
}

function Review() {
  const [variant, setVariant] = useState((params.get("variant") ?? "tools") as keyof typeof fixtures);
  const fixture = fixtures[variant];
  Object.assign(window, { __mermaidReview: { ...fixture,
    select: (next: keyof typeof fixtures) => setVariant(next),
    inspect: () => inspectDiagramImage(document.querySelector(".md-mermaid-diagram img")) } });
  return <main style={{ height: "100%", overflow: "auto", padding: 24 }}>
    <div style={{ width: 752, maxWidth: "100%", margin: "0 auto" }}>
      <label>验证图表 <select value={variant} onChange={event => setVariant(event.target.value as keyof typeof fixtures)}>
        {Object.keys(fixtures).map(key => <option key={key} value={key}>{key}</option>)}
      </select></label>
      <div className="markdown-body"><MarkdownPreMermaid content={fixture.source} theme={theme} /></div>
    </div>
  </main>;
}
ReactDOM.createRoot(document.getElementById("root")!).render(<Review />);
