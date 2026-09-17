/**
 * rehype-find-highlight —— 在 markdown 渲染前的 hast 树上把命中关键词的文本切片包成 `<mark>`。
 *
 * 命中处输出 `<mark class="find-hit">`。激活态由 ChatView 按最终 DOM 顺序统一管理。
 * 该插件由 Markdown 组件在 rehype 流水线中按需注入(query 为空时短路)。
 *
 * 为何走 rehype 而不是 react-markdown 组件覆盖:react-markdown 的文本节点无法被组件化,
 * 只能通过包装父节点再 walk children 重组。rehype 直接改 hast,渲染阶段无需做额外处理。
 */
import { SKIP, visit } from "unist-util-visit";
import type { Element, Root, RootContent, Text } from "hast";

interface Options {
  /** 当前查询关键词(已 trim)。空字符串表示关闭高亮。 */
  query: string;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** rehype 插件签名(unified 的 Plugin 类型在 transitive deps 下拿不到,这里本地化)。 */
type Transformer = (root: Root) => void;

export const rehypeFindHighlight =
  (options: Options): Transformer =>
  (root) => {
    const { query } = options;
    if (!query) return;
    const re = new RegExp(escapeRegex(query), "gi");
    visit(root, "text", (node: Text, index, parent) => {
      if (typeof index !== "number" || !parent || parent.type !== "element") return;
      const text = node.value;
      const replacements: RootContent[] = [];
      let last = 0;
      re.lastIndex = 0;
      let hit: RegExpExecArray | null;
      while ((hit = re.exec(text)) !== null) {
        if (hit.index > last) {
          replacements.push({ type: "text", value: text.slice(last, hit.index) });
        }
        const mark: Element = {
          type: "element",
          tagName: "mark",
          properties: { className: ["find-hit"] },
          children: [{ type: "text", value: hit[0] }],
        };
        replacements.push(mark);
        last = hit.index + hit[0].length;
        if (hit[0].length === 0) re.lastIndex += 1;
      }
      if (last < text.length) {
        replacements.push({ type: "text", value: text.slice(last) });
      }
      if (replacements.length === 0) return;
      const parentEl = parent as Element & { children: RootContent[] };
      parentEl.children.splice(index, 1, ...replacements);
      return [SKIP, index + replacements.length];
    });
  };
