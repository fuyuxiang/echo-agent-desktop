/**
 * 文档预览纯函数层 —— 对齐 EchoAgent `context-viewer-components/media-preview`
 * 的 docx/pptx/sheet 预览。
 *
 * OOXML(docx/pptx/xlsx)本质是 zip,内含 XML。为避免引入重型依赖,这里把「解压」
 * 作为依赖注入(`ZipReader` 接口),核心「XML 文本提取」是纯函数,便于单测。
 * 运行时可注入任意 zip 实现(如 fflate/jszip),或由后端解压后只传 XML 文本。
 */

/** 解压接口:按 entry 路径返回文本内容(缺省返回 null)。 */
export interface ZipReader {
  /** 读取某个 entry 的文本内容;不存在返回 null。 */
  readText(path: string): string | null;
  /** 列出所有 entry 路径(支持 glob 匹配,如 ppt/slides/slide*.xml)。 */
  listEntries(): string[];
}

/** docx 提取结果:按段落聚合的纯文本。 */
export interface DocxExtract {
  /** 段落列表(已去标签、去空白)。 */
  paragraphs: string[];
  /** 合并后的纯文本(段落用换行连接)。 */
  text: string;
}

/** 把 OOXML <w:t>(docx)/<a:t>(pptx) 文本节点内容按顺序抽出来,返回段落数组。 */
function extractTextNodes(xml: string, tagName: "w:t" | "a:t"): string[] {
  const out: string[] = [];
  // docx:段落由 <w:p> 包裹,段落内多个 <w:t> 拼接;pptx:<a:p> 内 <a:t>。
  const paraTag = tagName === "w:t" ? "w:p" : "a:p";
  const paraRe = new RegExp(`<${paraTag}[ >]`, "g");
  // 先按段落切分,再在段内抽取文本节点。
  const starts: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = paraRe.exec(xml)) !== null) starts.push(m.index);
  starts.push(xml.length);
  for (let i = 0; i < starts.length - 1; i++) {
    const seg = xml.slice(starts[i], starts[i + 1]);
    const tRe = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)</${tagName}>`, "g");
    let tm: RegExpExecArray | null;
    let para = "";
    while ((tm = tRe.exec(seg)) !== null) {
      // 反转义基本 XML 实体。
      para += decodeXml(tm[1]);
    }
    para = para.trim();
    if (para) out.push(para);
  }
  return out;
}

function decodeXml(s: string): string {
  const named: Record<string, string> = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };
  return s.replace(/&(lt|gt|quot|apos|amp|#x[\da-f]+|#\d+);/gi, (entity, code: string) => {
      if (code[0] !== "#") return named[code] ?? entity;
      const value = code.slice(1);
      const point = value[0].toLowerCase() === "x" ? parseInt(value.slice(1), 16) : parseInt(value, 10);
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
        ? String.fromCodePoint(point) : entity;
    });
}

/** 从 docx 的 word/document.xml 提取段落文本。 */
export function extractDocxParagraphs(documentXml: string): DocxExtract {
  const paragraphs = extractTextNodes(documentXml, "w:t");
  return { paragraphs, text: paragraphs.join("\n") };
}

/** pptx 提取结果:每页幻灯片的文本(标题/正文聚合)。 */
export interface PptxExtract {
  /** 每张幻灯片的文本行。 */
  slides: string[][];
  /** 合并文本(幻灯片间用空行,行内用换行)。 */
  text: string;
}

/** 从 pptx 的若干 slideN.xml 提取每页文本(按 slide 编号排序)。 */
export function extractPptxSlides(slideXmls: Array<{ name: string; xml: string }>): PptxExtract {
  const sorted = [...slideXmls].sort((a, b) => slideIndex(a.name) - slideIndex(b.name));
  const slides = sorted.map((s) => extractTextNodes(s.xml, "a:t"));
  return { slides, text: slides.map((lines) => lines.join("\n")).join("\n\n") };
}

/** 从 entry 名解析幻灯片序号(ppt/slides/slide1.xml → 1)。 */
export function slideIndex(name: string): number {
  const m = name.match(/slide(\d+)\.xml$/i);
  return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}

/** xlsx 提取结果:每个 sheet 的二维表格(行 × 列)。 */
export interface SheetExtract {
  /** 每个 sheet 的行(每行是单元格字符串数组)。 */
  sheets: Array<{ name: string; rows: string[][] }>;
  /** 合并文本(TSV 近似,sheet 间空行)。 */
  text: string;
}

/**
 * 从 xlsx 的 sheet XML 提取二维表。
 *  - sheetXmls:每个 sheet 的 xml(worksheet.xml,含 <c><v>/<c><is> 单元格)
 *  - sharedStrings:共享字符串表(若存在;cell 的 t="s" 时 v 是下标)
 * 返回每 sheet 的行列。
 */
export function extractSheets(
  sheetXmls: Array<{ name: string; xml: string }>,
  sharedStrings: string[] = [],
): SheetExtract {
  let cellCount = 0;
  let rowCount = 0;
  const sheets = sheetXmls.map(({ name, xml }) => {
    const rows: string[][] = [];
    for (const rm of sheetElements(xml, "row")) {
      const rowNumber = xmlAttribute(rm[1], "r");
      const rowIndex = rowNumber === undefined ? rows.length : Number(rowNumber) - 1;
      if (!Number.isSafeInteger(rowIndex) || rowIndex < 0 || rowIndex >= 10_000) {
        throw new Error("sheet row exceeds preview limit");
      }
      const rowXml = rm[2] ?? "";
      const cells: string[] = [];
      for (const cm of sheetElements(rowXml, "c")) {
        const attrs = cm[1];
        const reference = xmlAttribute(attrs, "r");
        const column = reference === undefined ? cells.length : sheetColumn(reference);
        if (column >= 16_384 || cellCount + Math.max(0, column + 1 - cells.length) > 100_000) {
          throw new Error("sheet cells exceed preview limit");
        }
        cellCount += Math.max(0, column + 1 - cells.length);
        while (cells.length <= column) cells.push("");
        cells[column] = sheetCellText(attrs, cm[2] ?? "", sharedStrings);
      }
      if (cells.length === 0 && rowNumber === undefined) continue;
      const addedRows = Math.max(0, rowIndex + 1 - rows.length);
      if (rowCount + addedRows > 10_000) throw new Error("sheet rows exceed preview limit");
      rowCount += addedRows;
      while (rows.length <= rowIndex) rows.push([]);
      rows[rowIndex] = cells;
    }
    return { name, rows };
  });
  const text = sheets
    .map((s) => `# ${s.name}\n` + s.rows.map((r) => r.join("\t")).join("\n"))
    .join("\n\n");
  return { sheets, text };
}

/** 逐个读取实际节点；不根据稀疏坐标分配空行或空列。 */
function* sheetElements(xml: string, tag: "row" | "c"): Generator<RegExpExecArray> {
  const pattern = new RegExp(`<${tag}\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/${tag}>)`, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) yield match;
}

function sheetCellText(attributes: string, inner: string, sharedStrings: string[]): string {
  const inline = inner.match(/<is>([\s\S]*?)<\/is>/);
  if (inline) {
    return [...inline[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
      .map((match) => decodeXml(match[1])).join("");
  }
  const raw = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
  if (raw === undefined) return "";
  const value = decodeXml(raw);
  if (xmlAttribute(attributes, "t") !== "s") return value;
  const index = /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  return Number.isSafeInteger(index) && index >= 0 && index < sharedStrings.length ? sharedStrings[index] : value;
}

function xmlAttribute(attributes: string, name: string): string | undefined {
  return attributes.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])(.*?)\\1`))?.[2];
}

function sheetColumn(reference: string): number {
  const match = /^([A-Z]{1,3})[1-9]\d*$/i.exec(reference);
  if (!match) throw new Error("sheet column exceeds preview limit");
  let column = 0;
  for (const char of match[1].toUpperCase()) column = column * 26 + char.charCodeAt(0) - 64;
  return column - 1;
}

/** 从 xlsx xl/sharedStrings.xml 提取共享字符串数组(顺序保留下标)。 */
export function extractSharedStrings(sharedStringsXml: string): string[] {
  const out: string[] = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = siRe.exec(sharedStringsXml)) !== null) {
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let tm: RegExpExecArray | null;
    let val = "";
    while ((tm = tRe.exec(m[1])!) !== null) {
      val += decodeXml(tm[1]);
    }
    out.push(val);
  }
  return out;
}

/**
 * 高层:从 ZipReader 提取 docx 文本(读 word/document.xml)。
 * 非 docx 或缺 entry 返回 null。
 */
export function extractDocxFromZip(zip: ZipReader): DocxExtract | null {
  const xml = zip.readText("word/document.xml");
  if (xml == null) return null;
  return extractDocxParagraphs(xml);
}

/** 高层:从 ZipReader 提取 pptx(读所有 ppt/slides/slideN.xml)。 */
export function extractPptxFromZip(zip: ZipReader): PptxExtract | null {
  const names = zip.listEntries().filter((n) => /ppt\/slides\/slide\d+\.xml$/i.test(n));
  if (names.length === 0) return null;
  const slideXmls = names
    .map((name) => ({ name, xml: zip.readText(name) ?? "" }))
    .filter((s) => s.xml);
  if (slideXmls.length === 0) return null;
  return extractPptxSlides(slideXmls);
}

/** 高层:从 ZipReader 提取 xlsx(读 xl/worksheets/sheetN.xml + 共享字符串)。 */
export function extractSheetFromZip(zip: ZipReader): SheetExtract | null {
  const ssXml = zip.readText("xl/sharedStrings.xml");
  const shared = ssXml ? extractSharedStrings(ssXml) : [];
  const names = sheetPaths(zip);
  if (names.length === 0) return null;
  const sheetXmls = names.map((name) => ({ name: sheetNameFromPath(name), xml: zip.readText(name) ?? "" }));
  return extractSheets(sheetXmls, shared);
}

/**
 * 知识库只索引实际单元格文本，不展开预览布局。
 * 在引用共享字符串时逐段截断，避免先拼出巨量重复文本再限长。
 * ZIP 的输入、条目和解压预算仍由调用方的 readZip 负责。
 */
export function extractSheetTextFromZip(zip: ZipReader, maxChars: number): string | null {
  if (!Number.isSafeInteger(maxChars) || maxChars < 0) throw new RangeError("invalid sheet text budget");
  const names = sheetPaths(zip);
  if (names.length === 0) return null;
  let text = "";
  const append = (value: string): boolean => {
    text += value.slice(0, maxChars - text.length);
    return text.length < maxChars;
  };
  if (maxChars === 0) return text;
  const ssXml = zip.readText("xl/sharedStrings.xml");
  const shared = ssXml ? extractSharedStrings(ssXml) : [];
  for (const name of names) {
    if (!append(`${text ? "\n\n" : ""}# ${sheetNameFromPath(name)}\n`)) return text;
    const xml = zip.readText(name) ?? "";
    let hasRow = false;
    for (const row of sheetElements(xml, "row")) {
      let hasCell = false;
      for (const cell of sheetElements(row[2] ?? "", "c")) {
        const value = sheetCellText(cell[1], cell[2] ?? "", shared);
        if (!value) continue;
        if (!append(hasCell ? "\t" : hasRow ? "\n" : "") || !append(value)) return text;
        hasCell = true;
        hasRow = true;
      }
    }
  }
  return text;
}

function sheetPaths(zip: ZipReader): string[] {
  return zip.listEntries()
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort((a, b) => Number(a.match(/sheet(\d+)\.xml$/i)?.[1]) - Number(b.match(/sheet(\d+)\.xml$/i)?.[1]));
}

/** 从 entry 路径取 sheet 显示名(xl/worksheets/sheet1.xml → Sheet1)。 */
export function sheetNameFromPath(path: string): string {
  const m = path.match(/sheet(\d+)\.xml$/i);
  return m ? `Sheet${m[1]}` : path;
}
