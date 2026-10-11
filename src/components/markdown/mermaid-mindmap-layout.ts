import type { InternalHelpers, LayoutData, SVG } from "mermaid";
import { MINDMAP_LABEL_MAX_WIDTH } from "./mermaid-svg";

type SizedNode = { id: string; width: number; height: number };
type TreeEdge = { start?: string; end?: string };
type Position = { x: number; y: number };
type LayoutNode = LayoutData["nodes"][number];

const NODE_GAP = 20;

/** Measured radial sectors retain the center-and-branches mindmap presentation. */
export function layoutMindmapTree(nodes: SizedNode[], edges: TreeEdge[]): Map<string, Position> {
  const positions = new Map<string, Position>();
  if (!nodes.length) return positions;
  if (nodes.some((node) => !validSize(node))) throw new Error("思维导图节点尺寸无效，请检查节点内容");
  const byId = new Map(nodes.map((node) => [node.id, node]));
  if (byId.size !== nodes.length) throw new Error("思维导图包含重复节点");
  const children = new Map(nodes.map((node) => [node.id, [] as string[]]));
  const parentIds = new Set<string>();
  for (const edge of edges) {
    if (!edge.start || !edge.end || !byId.has(edge.start) || !byId.has(edge.end)) {
      throw new Error("思维导图包含无效连接");
    }
    if (parentIds.has(edge.end)) throw new Error("思维导图节点有多个父节点");
    children.get(edge.start)!.push(edge.end);
    parentIds.add(edge.end);
  }
  const roots = nodes.filter((node) => !parentIds.has(node.id));
  if (roots.length !== 1) throw new Error("思维导图需要一个中心节点");
  const root = roots[0];
  const weights = new Map<string, number>();
  const visiting = new Set<string>();
  const measure = (id: string): number => {
    if (visiting.has(id)) throw new Error("思维导图包含循环连接");
    visiting.add(id);
    const items = children.get(id)!;
    const weight = Math.max(1, items.reduce((sum, child) => sum + measure(child), 0));
    weights.set(id, weight);
    visiting.delete(id);
    return weight;
  };
  measure(root.id);
  if (weights.size !== nodes.length) throw new Error("思维导图包含未连接的节点");
  const polar = new Map<string, { depth: number; angle: number }>();
  const allocate = (id: string, depth: number, start: number, span: number) => {
    polar.set(id, { depth, angle: start + span / 2 });
    let angle = start;
    for (const child of children.get(id)!) {
      const childSpan = span * weights.get(child)! / weights.get(id)!;
      allocate(child, depth + 1, angle, childSpan);
      angle += childSpan;
    }
  };
  allocate(root.id, 0, -Math.PI, Math.PI * 2);

  // Search a small deterministic set of orientations. Wider ellipses suit
  // Chinese categories plus long Latin tool names better than a fixed circle.
  // For each pair, separation on either axis is sufficient. Taking the maximum
  // of those pairwise requirements guarantees clear space for every node.
  let bestScore = Infinity;
  for (const ratio of [1.5, 1.8, 2.1]) for (let turn = 0; turn < 24; turn += 1) {
    const rotation = turn * Math.PI / 12;
    const units = nodes.map((node) => {
      const { depth, angle } = polar.get(node.id)!;
      return { x: depth * ratio * Math.cos(angle + rotation), y: depth * Math.sin(angle + rotation) };
    });
    let scale = 80;
    for (let a = 0; a < nodes.length; a += 1) for (let b = a + 1; b < nodes.length; b += 1) {
      const dx = Math.abs(units[a].x - units[b].x);
      const dy = Math.abs(units[a].y - units[b].y);
      const horizontal = dx < 1e-8 ? Infinity : ((nodes[a].width + nodes[b].width) / 2 + NODE_GAP) / dx;
      const vertical = dy < 1e-8 ? Infinity : ((nodes[a].height + nodes[b].height) / 2 + NODE_GAP) / dy;
      scale = Math.max(scale, Math.min(horizontal, vertical));
    }
    const candidate = units.map((point) => ({ x: point.x * scale, y: point.y * scale }));
    const width = Math.max(...candidate.map((point, index) => point.x + nodes[index].width / 2))
      - Math.min(...candidate.map((point, index) => point.x - nodes[index].width / 2));
    const height = Math.max(...candidate.map((point, index) => point.y + nodes[index].height / 2))
      - Math.min(...candidate.map((point, index) => point.y - nodes[index].height / 2));
    const score = Math.max(width, height * 1.8);
    if (score < bestScore) {
      bestScore = score;
      nodes.forEach((node, index) => positions.set(node.id, candidate[index]));
    }
  }
  return positions;
}

function validSize(size: { width: number; height: number }): boolean {
  return Number.isFinite(size.width) && size.width > 0
    && Number.isFinite(size.height) && size.height > 0;
}

/** Mermaid sizes circles from label width alone. Wrapped labels also need
 * their corners inside the circle; keep existing short-label circles intact. */
export function fitMindmapCircleLabel(element: SVGGraphicsElement, node: LayoutNode): void {
  if (node.shape !== "mindmapCircle" && node.shape !== "circle") return;
  const card = element.querySelector<SVGGraphicsElement>(":scope > .label-container");
  const label = element.querySelector(":scope > .label > foreignObject");
  if (!card || !label) return;
  const width = Number(label.getAttribute("width"));
  const height = Number(label.getAttribute("height"));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 0 || height < 0) {
    throw new Error("思维导图节点尺寸无效，请检查节点内容");
  }
  if (!width || !height) return;

  // Plain circles expose their exact radius. RoughJS renders a compound group,
  // but Mermaid's circle helper uses this same nominal radius for its outline
  // and intersect callback; scale that group without scaling the label.
  const primitive = card.tagName.toLowerCase() === "circle";
  const padding = node.look === "neo" ? 32
    : node.shape === "mindmapCircle" ? node.padding ?? 0 : (node.padding ?? 0) / 2;
  const originalRadius = primitive ? Number(card.getAttribute("r")) : width / 2 + padding;
  if (!Number.isFinite(originalRadius) || originalRadius <= 0) {
    throw new Error("思维导图节点尺寸无效，请检查节点内容");
  }
  const labelRadius = Math.hypot(width, height) / 2;
  if (labelRadius <= originalRadius) return;
  const radius = labelRadius + Math.max(0, originalRadius - width / 2);
  if (primitive) {
    card.setAttribute("r", String(radius));
  } else {
    const transform = card.getAttribute("transform") ?? "";
    card.setAttribute("transform", `${transform} scale(${radius / originalRadius})`.trim());
  }
  // The helper's original intersect closes over the old radius. Update both
  // edge APIs together with the visible outline and the measured node bounds.
  const intersect = (bounds: { x?: number; y?: number }, r: number, point: Position): Position => {
    const x = bounds.x ?? 0, y = bounds.y ?? 0;
    const dx = point.x - x, dy = point.y - y;
    const distance = Math.hypot(dx, dy);
    return distance ? { x: x + r * dx / distance, y: y + r * dy / distance } : { x: x + r, y };
  };
  node.intersect = (point: Position) => intersect(node, radius, point);
  node.calcIntersect = (bounds, point) => intersect(bounds, bounds.width / 2, point);
}

/** Cloud and bang helpers approximate their scalloped paths with a rectangle.
 * Find the actual outline on the ray facing the other node instead. */
export function bindMindmapPathIntersections(element: SVGGraphicsElement, node: LayoutNode): void {
  if ((node.shape !== "cloud" && node.shape !== "bang") || node.look === "handDrawn") return;
  const path = element.querySelector<SVGGeometryElement>(":scope > path.label-container");
  if (!path) return;
  const parentMatrix = element.getCTM();
  const pathMatrix = path.getCTM();
  if (!parentMatrix || !pathMatrix) return;
  // Cancel every ancestor transform; retain the shape's own translation in
  // node-local SVG units, independently of the offscreen DOM's screen scale.
  const matrix = parentMatrix.inverse().multiply(pathMatrix);
  const length = path.getTotalLength();
  if (!Number.isFinite(length) || length <= 0) throw new Error("思维导图节点轮廓无效，请检查节点内容");
  const at = (value: number): Position => {
    const point = path.getPointAtLength(value);
    return { x: matrix.a * point.x + matrix.c * point.y + matrix.e,
      y: matrix.b * point.x + matrix.d * point.y + matrix.f };
  };
  const count = Math.min(2048, Math.max(128, Math.ceil(length / 4)));
  const samples = Array.from({ length: count + 1 }, (_, index) => at(length * index / count));
  const fallback = node.intersect;
  const fallbackScaled = node.calcIntersect;
  const intersect = (bounds: { x?: number; y?: number; width: number; height: number }, point: Position): Position => {
    const x = bounds.x ?? 0, y = bounds.y ?? 0;
    const sx = bounds.width / node.width!, sy = bounds.height / node.height!;
    const dx = point.x - x, dy = point.y - y;
    const distance = Math.hypot(dx, dy);
    const ux = distance ? dx / distance : 1, uy = distance ? dy / distance : 0;
    const side = (p: Position) => ux * p.y * sy - uy * p.x * sx;
    let best: Position | undefined, projection = -Infinity;
    const consider = (p: Position) => {
      const along = ux * p.x * sx + uy * p.y * sy;
      if (along >= 0 && along > projection) {
        projection = along;
        best = { x: x + p.x * sx, y: y + p.y * sy };
      }
    };
    for (let index = 0; index < count; index += 1) {
      let lo = length * index / count, hi = length * (index + 1) / count;
      let first = side(samples[index]);
      const last = side(samples[index + 1]);
      if (Math.abs(first) < 1e-8) consider(samples[index]);
      if (Math.abs(last) < 1e-8) consider(samples[index + 1]);
      if (first * last >= 0) continue;
      // Refine against the actual SVG curve, not its sampled chord. A concave
      // outline may cross the ray repeatedly; its outermost crossing is the
      // first boundary reached by an edge arriving from the other node.
      for (let step = 0; step < 24 && hi - lo > 1e-4; step += 1) {
        const middle = (lo + hi) / 2;
        const value = side(at(middle));
        if (first * value <= 0) hi = middle;
        else { lo = middle; first = value; }
      }
      consider(at((lo + hi) / 2));
    }
    return best ?? fallbackScaled?.({ ...bounds, x, y }, point) ?? fallback?.(point) ?? { x, y };
  };
  node.intersect = (point: Position) => intersect({ x: node.x, y: node.y, width: node.width!, height: node.height! }, point);
  node.calcIntersect = intersect;
}

/** Read primitive shape dimensions in SVG units; CSS transitions can corrupt a
 * whole-group getBBox. Paths and compound shapes retain their true SVG bounds,
 * without mixing screen pixels from getBoundingClientRect into layout units. */
export function measureMindmapNode(element: SVGGraphicsElement): { width: number; height: number } {
  const card = element.querySelector(":scope > .label-container");
  if (card) {
    const number = (attribute: string) => Number(card.getAttribute(attribute));
    let size;
    switch (card.tagName.toLowerCase()) {
      case "rect": size = { width: number("width"), height: number("height") }; break;
      case "circle": size = { width: number("r") * 2, height: number("r") * 2 }; break;
      case "ellipse": size = { width: number("rx") * 2, height: number("ry") * 2 }; break;
    }
    if (size && validSize(size)) return size;
  }
  const box = element.getBBox();
  if (!validSize(box)) throw new Error("思维导图节点尺寸无效，请检查节点内容");
  return { width: box.width, height: box.height };
}

/** Mermaid's layout extension retains its parser, labels, shapes and SVG export. */
export async function render(data: LayoutData, svg: SVG, helpers: InternalHelpers): Promise<void> {
  const group = svg.select<SVGGElement>("g");
  helpers.insertMarkers(group, data.markers, data.type, data.diagramId);
  const edgePaths = group.append("g").attr("class", "edgePaths");
  const edgeLabels = group.append("g").attr("class", "edgeLabels");
  const nodeGroup = group.append("g").attr("class", "nodes");
  const nodeElements = new Map<string, Awaited<ReturnType<InternalHelpers["insertNode"]>>>();

  for (const node of data.nodes) {
    if (node.isGroup) throw new Error("思维导图不支持分组容器");
    // Unspecified shapes use compact rounded cards. Explicit circles, clouds,
    // squares and other Mermaid shapes still retain their original meaning.
    if (node.shape === "defaultMindmapNode") {
      node.shape = "rounded";
      node.width = 0;
      node.radius = 8;
      node.wrappingWidth = data.config.mindmap?.maxNodeWidth ?? MINDMAP_LABEL_MAX_WIDTH;
    }
    const element = await helpers.insertNode(nodeGroup, node, { config: data.config, dir: "LR" });
    fitMindmapCircleLabel(element.node()!, node);
    const box = measureMindmapNode(element.node()!);
    node.width = box.width;
    node.height = box.height;
    bindMindmapPathIntersections(element.node()!, node);
    nodeElements.set(node.id, element);
  }

  const positions = layoutMindmapTree(
    data.nodes.map((node) => ({ id: node.id, width: node.width!, height: node.height! })),
    data.edges,
  );
  const byId = new Map(data.nodes.map((node) => [node.id, node]));
  for (const node of data.nodes) {
    const position = positions.get(node.id)!;
    node.x = position.x;
    node.y = position.y;
    nodeElements.get(node.id)!.attr("transform", `translate(${node.x}, ${node.y})`);
  }
  for (const edge of data.edges) {
    const start = byId.get(edge.start!)!;
    const end = byId.get(edge.end!)!;
    edge.points = [
      { x: start.x!, y: start.y! },
      { x: (start.x! + end.x!) / 2, y: (start.y! + end.y!) / 2 },
      { x: end.x!, y: end.y! },
    ];
    await helpers.insertEdgeLabel(edgeLabels, edge);
    const paths = helpers.insertEdge(edgePaths, edge, {}, data.type, start, end, data.diagramId);
    helpers.positionEdgeLabel(edge, paths);
  }
}
