import { describe, expect, it, vi } from "vitest";
import type { LayoutData } from "mermaid";
import { bindMindmapPathIntersections, fitMindmapCircleLabel, measureMindmapNode } from "../mermaid-mindmap-layout";

function node(shape: string, bbox: { width: number; height: number }) {
  const svg = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg"><g>${shape}</g></svg>`, "image/svg+xml");
  const group = svg.querySelector("g")! as SVGGraphicsElement;
  group.getBBox = vi.fn(() => ({ x: 0, y: 0, ...bbox }) as DOMRect);
  return group;
}

describe("Mindmap node measurement", () => {
  it("keeps a card's SVG dimensions when the group reports transition-corrupted bounds", () => {
    const group = node('<rect class="label-container" width="150" height="72"/>', { width: 2445, height: 1600 });
    expect(measureMindmapNode(group)).toEqual({ width: 150, height: 72 });
    expect(group.getBBox).not.toHaveBeenCalled();
  });

  it("preserves circle and ellipse dimensions without reading screen pixels", () => {
    expect(measureMindmapNode(node('<circle class="label-container" r="80"/>', { width: 2000, height: 2000 })))
      .toEqual({ width: 160, height: 160 });
    expect(measureMindmapNode(node('<ellipse class="label-container" rx="140" ry="50"/>', { width: 2000, height: 2000 })))
      .toEqual({ width: 280, height: 100 });
  });

  it("retains true bounds for paths and compound shapes, including tall valid labels", () => {
    const group = node('<path class="label-container" d="M 0 0 L 200 0 L 200 1200 Z"/>', { width: 200, height: 1200 });
    expect(measureMindmapNode(group)).toEqual({ width: 200, height: 1200 });
  });

  it("rejects unusable fallback bounds so the component can show the source", () => {
    expect(() => measureMindmapNode(node("", { width: NaN, height: 48 }))).toThrow("节点尺寸无效");
    expect(() => measureMindmapNode(node("", { width: 100, height: 0 }))).toThrow("节点尺寸无效");
  });
});

describe("Mindmap circle label containment", () => {
  function circle(width: number, height: number, radius: number, compound = false) {
    const card = compound ? '<g class="label-container"><path d="M 0 0"/></g>'
      : `<circle class="label-container" r="${radius}"/>`;
    return node(`${card}<g class="label" transform="translate(${-width / 2},${-height / 2})"><foreignObject width="${width}" height="${height}"/></g>`,
      { width: radius * 2, height: radius * 2 });
  }

  function model(): Extract<LayoutData["nodes"][number], { isGroup: false }> {
    return { id: "root", isGroup: false, shape: "mindmapCircle", padding: 12, x: 50, y: 80,
      intersect: () => ({ x: 182, y: 80 }), calcIntersect: () => ({ x: 182, y: 80 }) };
  }

  it("encloses every corner of a tall label and updates both edge intersection APIs", () => {
    const group = circle(240, 336, 132);
    const data = model();
    fitMindmapCircleLabel(group, data);
    const radius = Number(group.querySelector("circle")!.getAttribute("r"));
    expect(radius).toBeCloseTo(Math.hypot(120, 168) + 12);
    expect(measureMindmapNode(group)).toEqual({ width: radius * 2, height: radius * 2 });
    for (const point of [{ x: 1050, y: 80 }, { x: 50, y: -920 }, { x: 1050, y: 1080 }]) {
      const hit = data.intersect!(point);
      expect(Math.hypot(hit.x - data.x!, hit.y - data.y!)).toBeCloseTo(radius);
      const scaled = data.calcIntersect!({ x: 50, y: 80, width: radius * 4, height: radius * 4 }, point);
      expect(Math.hypot(scaled.x - 50, scaled.y - 80)).toBeCloseTo(radius * 2);
    }
    expect(group.querySelector(".label")!.getAttribute("transform")).toBe("translate(-120,-168)");
    expect(group.querySelector("foreignObject")!.getAttribute("width")).toBe("240");
    expect(group.getBBox).not.toHaveBeenCalled();
  });

  it("also fits square multiline labels whose height is already below the diameter", () => {
    const group = circle(240, 240, 132);
    fitMindmapCircleLabel(group, model());
    expect(Number(group.querySelector("circle")!.getAttribute("r"))).toBeCloseTo(Math.hypot(120, 120) + 12);
  });

  it.each([[40, 24, 32], [0, 0, 12]])("preserves compact and empty circles (%s × %s)", (width, height, radius) => {
    const group = circle(width, height, radius);
    const data = model();
    const intersect = data.intersect, calcIntersect = data.calcIntersect;
    fitMindmapCircleLabel(group, data);
    expect(group.querySelector("circle")!.getAttribute("r")).toBe(String(radius));
    expect(data.intersect).toBe(intersect);
    expect(data.calcIntersect).toBe(calcIntersect);
  });

  it("scales a hand-drawn outline while retaining its label and updating its nominal edge radius", () => {
    const group = circle(240, 336, 132, true);
    const data = { ...model(), look: "handDrawn" };
    fitMindmapCircleLabel(group, data);
    const radius = Math.hypot(120, 168) + 12;
    expect(group.querySelector(".label-container")!.getAttribute("transform")).toBe(`scale(${radius / 132})`);
    expect(group.querySelector(".label")!.getAttribute("transform")).toBe("translate(-120,-168)");
    expect(data.intersect!({ x: 1050, y: 80 })).toEqual({ x: 50 + radius, y: 80 });
  });

  it("does not resize explicit rectangles or clouds", () => {
    for (const shape of ["rect", "cloud"] as const) {
      const group = circle(240, 336, 132);
      fitMindmapCircleLabel(group, { ...model(), shape });
      expect(group.querySelector("circle")!.getAttribute("r")).toBe("132");
    }
  });
});

describe("Mindmap irregular outline connections", () => {
  const identity = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  function outline(length: number, at: (length: number) => { x: number; y: number }, matrix = identity) {
    const group = node('<path class="label-container" d="M0 0Z"/>', { width: 200, height: 80 });
    const path = group.querySelector("path")! as SVGGeometryElement;
    const pathMatrix = {} as DOMMatrix;
    const multiply = vi.fn(() => matrix);
    group.getCTM = vi.fn(() => ({ inverse: () => ({ multiply }) }) as unknown as DOMMatrix);
    path.getCTM = vi.fn(() => pathMatrix);
    path.getTotalLength = vi.fn(() => length);
    path.getPointAtLength = vi.fn(value => at(value) as DOMPoint);
    return { group, path, pathMatrix, multiply };
  }
  function model(shape: "cloud" | "bang" = "cloud"): Extract<LayoutData["nodes"][number], { isGroup: false }> {
    return { id: "node", isGroup: false, shape, width: 200, height: 80, x: 37, y: 59,
      intersect: () => ({ x: 137, y: 59 }), calcIntersect: () => ({ x: 137, y: 59 }) };
  }

  it.each(["cloud", "bang"] as const)("uses the actual translated and scaled %s outline at its current node position", shape => {
    const path = outline(Math.PI * 100, value => ({ x: 50 * Math.cos(value / 50), y: 40 * Math.sin(value / 50) }),
      { ...identity, a: 2, e: 10, f: -5 });
    const data = model(shape);
    bindMindmapPathIntersections(path.group, data);
    // Ellipse centered at (10,-5), radii (100,40), intersected at node-local y=0.
    const edgeX = 10 + 100 * Math.sqrt(1 - (5 / 40) ** 2);
    const hit = data.intersect!({ x: 1037, y: 59 });
    expect(hit.x).toBeCloseTo(37 + edgeX, 4);
    expect(hit.y).toBeCloseTo(59, 4);
    expect(path.multiply).toHaveBeenCalledWith(path.pathMatrix);
    data.x = -250; data.y = 300;
    const moved = data.intersect!({ x: 750, y: 300 });
    expect(moved.x).toBeCloseTo(-250 + edgeX, 4);
    expect(moved.y).toBeCloseTo(300, 4);
    const scaled = data.calcIntersect!({ x: 20, y: 30, width: 400, height: 160 }, { x: 1020, y: 30 });
    expect(scaled.x).toBeCloseTo(20 + 2 * edgeX, 4);
    expect(scaled.y).toBeCloseTo(30, 4);
  });

  it("selects the outermost crossing of a concave path so arriving edges do not pass through another lobe", () => {
    const points = [[-20, -20], [20, -20], [20, 10], [40, 10], [40, -10], [60, -10], [60, 20], [-20, 20], [-20, -20]];
    const lengths = [0];
    for (let index = 1; index < points.length; index += 1) {
      lengths.push(lengths[index - 1] + Math.hypot(points[index][0] - points[index - 1][0], points[index][1] - points[index - 1][1]));
    }
    const path = outline(lengths[lengths.length - 1], value => {
      const index = Math.max(1, lengths.findIndex(length => length >= value));
      const ratio = (value - lengths[index - 1]) / (lengths[index] - lengths[index - 1]);
      return { x: points[index - 1][0] + (points[index][0] - points[index - 1][0]) * ratio,
        y: points[index - 1][1] + (points[index][1] - points[index - 1][1]) * ratio };
    });
    const data = model();
    bindMindmapPathIntersections(path.group, data);
    const hit = data.intersect!({ x: 1037, y: 59 });
    expect(hit.x).toBeCloseTo(97, 4);
    expect(hit.y).toBeCloseTo(59, 4);
  });

  it("leaves ordinary shapes and hand-drawn outlines on their original helper callbacks", () => {
    for (const data of [{ ...model(), shape: "circle" as const }, { ...model(), look: "handDrawn" }]) {
      const path = outline(100, () => ({ x: 0, y: 0 }));
      const intersect = data.intersect, calcIntersect = data.calcIntersect;
      bindMindmapPathIntersections(path.group, data);
      expect(data.intersect).toBe(intersect);
      expect(data.calcIntersect).toBe(calcIntersect);
      expect(path.path.getTotalLength).not.toHaveBeenCalled();
    }
  });
});
