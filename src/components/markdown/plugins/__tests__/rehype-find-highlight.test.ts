import { describe, it, expect } from "vitest";
import type { Element, Root, Text, RootContent } from "hast";
import { rehypeFindHighlight } from "../rehype-find-highlight";

/** 构造一个 HAST 树,根节点是 fragment 容器,children 是传入的 nodes。 */
function root(children: RootContent[]): Root {
  return { type: "root", children };
}

function el(tagName: string, children: (Element | Text)[], className?: string[]): Element {
  return {
    type: "element",
    tagName,
    properties: className ? { className } : {},
    children,
  };
}

function text(value: string): Text {
  return { type: "text", value };
}

function findMarks(node: Root | Element): Element[] {
  const out: Element[] = [];
  if (node.type === "element" && node.tagName === "mark") out.push(node);
  for (const child of (node.children as RootContent[])) {
    if (child.type === "element") out.push(...findMarks(child));
  }
  return out;
}

function runPlugin(tree: Root, query: string) {
  const transformer = rehypeFindHighlight({ query });
  transformer(tree);
}

describe("rehypeFindHighlight", () => {
  it("空 query 时不动 DOM", () => {
    const tree = root([el("p", [text("hello world")])]);
    runPlugin(tree, "");
    expect(findMarks(tree)).toHaveLength(0);
    expect((tree.children[0] as Element).children[0]).toEqual(text("hello world"));
  });

  it("把命中片段包成 <mark class='find-hit'>", () => {
    const tree = root([el("p", [text("小鸟飞过天空")])]);
    runPlugin(tree, "鸟");
    const marks = findMarks(tree);
    expect(marks).toHaveLength(1);
    expect(marks[0].properties?.className).toEqual(["find-hit"]);
    expect(marks[0].children[0]).toEqual(text("鸟"));
  });

  it("同一文本多次出现应分别包裹", () => {
    const tree = root([el("p", [text("鸟鸟鸟")])]);
    runPlugin(tree, "鸟");
    expect(findMarks(tree)).toHaveLength(3);
  });

  it("所有命中只输出稳定的 find-hit 类", () => {
    const tree = root([el("p", [text("鸟鸟鸟鸟")])]);
    runPlugin(tree, "鸟");
    const marks = findMarks(tree);
    expect(marks).toHaveLength(4);
    expect(marks[0].properties?.className).toEqual(["find-hit"]);
    expect(marks[1].properties?.className).toEqual(["find-hit"]);
    expect(marks[2].properties?.className).toEqual(["find-hit"]);
    expect(marks[3].properties?.className).toEqual(["find-hit"]);
  });

  it("转义正则元字符,避免 query 中的 ( . 等破坏 RegExp", () => {
    const tree = root([el("p", [text("价格: (1.50)")])]);
    runPlugin(tree, "(1.50)");
    expect(findMarks(tree)).toHaveLength(1);
  });

  it("大小写不敏感命中", () => {
    const tree = root([el("p", [text("Hello world HELLO")])]);
    runPlugin(tree, "hello");
    expect(findMarks(tree)).toHaveLength(2);
  });

  it("跨节点完整生成所有命中", () => {
    const tree = root([
      el("p", [text("鸟")]),
      el("p", [text("鸟")]),
      el("p", [text("其他")]),
      el("p", [text("鸟")]),
    ]);
    runPlugin(tree, "鸟");
    const marks = findMarks(tree);
    expect(marks).toHaveLength(3);
    expect(marks[2].properties?.className).toEqual(["find-hit"]);
  });

  it("不命中时不输出 <mark>", () => {
    const tree = root([el("p", [text("没有命中")])]);
    runPlugin(tree, "完全不存在");
    expect(findMarks(tree)).toHaveLength(0);
  });
});
