import { describe, it, expect } from "vitest";
import {
  extractDocxParagraphs,
  extractPptxSlides,
  slideIndex,
  extractSheets,
  extractSharedStrings,
  extractDocxFromZip,
  extractPptxFromZip,
  extractSheetFromZip,
  extractSheetTextFromZip,
  sheetNameFromPath,
  type ZipReader,
} from "../doc-preview";

describe("extractDocxParagraphs", () => {
  it("提取 <w:p>/<w:t> 段落", () => {
    const xml = `
      <w:document>
        <w:p><w:r><w:t>第一段</w:t></w:r></w:p>
        <w:p><w:r><w:t>第二段</w:t><w:r><w:t> 继续</w:t></w:r></w:r></w:p>
      </w:document>`;
    const r = extractDocxParagraphs(xml);
    expect(r.paragraphs).toEqual(["第一段", "第二段 继续"]);
    expect(r.text).toBe("第一段\n第二段 继续");
  });

  it("反转义 XML 实体", () => {
    const xml = `<w:p><w:r><w:t>a &amp; b &lt; c</w:t></w:r></w:p>`;
    expect(extractDocxParagraphs(xml).paragraphs[0]).toBe("a & b < c");
  });

  it("数字实体只解码一层，并且制表位属性不被当作文本节点", () => {
    const xml = '<w:p><w:pPr><w:tabs><w:tab w:pos="720"/></w:tabs></w:pPr><w:r><w:t>&#x4e2d;&#25991; &#38;lt;</w:t></w:r></w:p>';
    expect(extractDocxParagraphs(xml).text).toBe("中文 &lt;");
  });

  it("空段落被过滤", () => {
    const xml = `<w:p></w:p><w:p><w:t>x</w:t></w:p>`;
    expect(extractDocxParagraphs(xml).paragraphs).toEqual(["x"]);
  });

  it("无 <w:t> 返回空", () => {
    expect(extractDocxParagraphs("<w:p></w:p>").paragraphs).toEqual([]);
  });
});

describe("extractPptxSlides / slideIndex", () => {
  it("按 slide 编号排序并提取 <a:t>", () => {
    const slides = [
      { name: "ppt/slides/slide2.xml", xml: `<a:p><a:t>第二页</a:t></a:p>` },
      { name: "ppt/slides/slide10.xml", xml: `<a:p><a:t>第十页</a:t></a:p>` },
      { name: "ppt/slides/slide1.xml", xml: `<a:p><a:t>第一页</a:t></a:p>` },
    ];
    const r = extractPptxSlides(slides);
    // slide10 应排在 slide2 之后(数字序而非字典序)。
    expect(r.slides.map((s) => s[0])).toEqual(["第一页", "第二页", "第十页"]);
  });

  it("每页多行", () => {
    const slides = [
      {
        name: "ppt/slides/slide1.xml",
        xml: `<a:p><a:t>标题</a:t></a:p><a:p><a:t>正文</a:t></a:p>`,
      },
    ];
    const r = extractPptxSlides(slides);
    expect(r.slides[0]).toEqual(["标题", "正文"]);
  });

  it("slideIndex 数字序", () => {
    expect(slideIndex("ppt/slides/slide2.xml")).toBe(2);
    expect(slideIndex("ppt/slides/slide10.xml")).toBe(10);
    expect(slideIndex("nope")).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("extractSheets / extractSharedStrings", () => {
  it("提取共享字符串表", () => {
    const ss = `<sst><si><t>姓名</t></si><si><t>年龄</t></si></sst>`;
    expect(extractSharedStrings(ss)).toEqual(["姓名", "年龄"]);
  });

  it("t=\"s\" 单元格用共享字符串下标", () => {
    const shared = ["姓名", "年龄"];
    const xml = `
      <worksheet>
        <row><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
        <row><c r="A2"><v>30</v></c></row>
      </worksheet>`;
    const r = extractSheets([{ name: "Sheet1", xml }], shared);
    expect(r.sheets[0].rows).toEqual([["姓名", "年龄"], ["30"]]);
  });

  it("inline string <is><t>", () => {
    const xml = `<worksheet><row><c r="A1" t="inlineStr"><is><t>直接文本</t></is></c></row></worksheet>`;
    const r = extractSheets([{ name: "S", xml }], []);
    expect(r.sheets[0].rows).toEqual([["直接文本"]]);
  });

  it("空行被过滤", () => {
    const xml = `<worksheet><row></row><row><c><v>1</v></c></row></worksheet>`;
    const r = extractSheets([{ name: "S", xml }], []);
    expect(r.sheets[0].rows).toEqual([["1"]]);
  });

  it("text 含 sheet 名 + TSV", () => {
    const xml = `<worksheet><row><c><v>a</v></c><c><v>b</v></c></row></worksheet>`;
    const r = extractSheets([{ name: "Sheet1", xml }], []);
    expect(r.text).toContain("# Sheet1");
    expect(r.text).toContain("a\tb");
  });
});

describe("extractXxxFromZip (高层 + 注入 ZipReader)", () => {
  it("稀疏单元格保留列位置、自闭合空格与空行", () => {
    const xml = '<worksheet><sheetData><row r="1"><c r="A1"><v>表头</v></c><c r="C1"><v>金额</v></c></row><row r="3"><c r="A3"/><c r="C3"><v>42</v></c></row></sheetData></worksheet>';
    expect(extractSheets([{ name: "Sheet1", xml }]).sheets[0].rows).toEqual([
      ["表头", "", "金额"], [], ["", "", "42"],
    ]);
  });

  it("共享字符串只解码一次，inline string 与它保持相同文字", () => {
    const shared = extractSharedStrings('<sst><si><t>&amp;lt;tag&amp;gt;</t></si></sst>');
    const xml = '<row><c t="s"><v>0</v></c><c t="inlineStr"><is><t>&amp;lt;tag&amp;gt;</t></is></c></row>';
    expect(extractSheets([{ name: "Sheet1", xml }], shared).sheets[0].rows).toEqual([["&lt;tag&gt;", "&lt;tag&gt;"]]);
  });

  it("无效或缺失的共享字符串索引不会变成第一项", () => {
    const xml = '<row><c t="s"><v></v></c><c t="s"><v>-1</v></c><c t="s"><v>0.5</v></c></row>';
    expect(extractSheets([{ name: "Sheet1", xml }], ["不应显示"]).sheets[0].rows).toEqual([["", "-1", "0.5"]]);
  });

  it("恶意行列坐标不能触发无界空数组分配", () => {
    expect(() => extractSheets([{ name: "Sheet1", xml: '<row r="999999999"><c r="ZZZZZZ1"><v>x</v></c></row>' }])).toThrow(/limit/);
  });

  it("多张稀疏工作表共用总行数上限，空行也计入", () => {
    const xml = '<worksheet><sheetData><row r="6000"/></sheetData></worksheet>';
    expect(() => extractSheets([{ name: "Sheet1", xml }, { name: "Sheet2", xml }])).toThrow(/rows.*limit/);
  });

  const makeZip = (entries: Record<string, string>): ZipReader => ({
    readText: (p) => entries[p] ?? null,
    listEntries: () => Object.keys(entries),
  });

  it("docx:有 word/document.xml → 提取", () => {
    const zip = makeZip({ "word/document.xml": `<w:p><w:t>正文</w:t></w:p>` });
    expect(extractDocxFromZip(zip)?.text).toBe("正文");
  });
  it("docx:无 entry → null", () => {
    expect(extractDocxFromZip(makeZip({}))).toBeNull();
  });

  it("pptx:有 slide xml → 提取(数字序)", () => {
    const zip = makeZip({
      "ppt/slides/slide2.xml": `<a:p><a:t>B</a:t></a:p>`,
      "ppt/slides/slide1.xml": `<a:p><a:t>A</a:t></a:p>`,
    });
    expect(extractPptxFromZip(zip)?.slides.map((s) => s[0])).toEqual(["A", "B"]);
  });
  it("pptx:无 slide → null", () => {
    expect(extractPptxFromZip(makeZip({}))).toBeNull();
  });

  it("xlsx:有 worksheet + sharedStrings → 提取", () => {
    const zip = makeZip({
      "xl/sharedStrings.xml": `<sst><si><t>名</t></si></sst>`,
      "xl/worksheets/sheet1.xml": `<worksheet><row><c t="s"><v>0</v></c></row></worksheet>`,
    });
    const r = extractSheetFromZip(zip);
    expect(r?.sheets[0].rows).toEqual([["名"]]);
  });
  it("xlsx:无 worksheet → null", () => {
    expect(extractSheetFromZip(makeZip({}))).toBeNull();
    expect(extractSheetTextFromZip(makeZip({}), 1024)).toBeNull();
  });

  it("xlsx 按工作表数字序预览，排除相似路径", () => {
    const row = (value: string) => `<row><c><v>${value}</v></c></row>`;
    const zip = makeZip({ "xl/worksheets/sheet10.xml": row("10"), "xl/worksheets/sheet2.xml": row("2"), "other/xl/worksheets/sheet1.xml": row("忽略") });
    expect(extractSheetFromZip(zip)?.sheets.map(sheet => sheet.name)).toEqual(["Sheet2", "Sheet10"]);
    expect(extractSheetTextFromZip(zip, 1024)).toBe("# Sheet2\n2\n\n# Sheet10\n10");
  });

  it("知识索引在字符预算内截断共享字符串，达到上限后不再读取后续工作表", () => {
    const reads: string[] = [];
    const zip: ZipReader = {
      listEntries: () => ["xl/worksheets/sheet2.xml", "xl/worksheets/sheet1.xml"],
      readText: (path) => {
        reads.push(path);
        if (path === "xl/sharedStrings.xml") return `<sst><si><t>${"知识".repeat(1024)}</t></si></sst>`;
        if (path === "xl/worksheets/sheet1.xml") return '<row r="1048576"><c r="XFD1048576" t="s"><v>0</v></c></row>';
        throw new Error("不应读取预算外的工作表");
      },
    };
    expect(extractSheetTextFromZip(zip, 32)).toBe(("# Sheet1\n" + "知识".repeat(1024)).slice(0, 32));
    expect(reads).toEqual(["xl/sharedStrings.xml", "xl/worksheets/sheet1.xml"]);
  });
});

describe("sheetNameFromPath", () => {
  it("取 Sheet<N>", () => {
    expect(sheetNameFromPath("xl/worksheets/sheet1.xml")).toBe("Sheet1");
    expect(sheetNameFromPath("xl/worksheets/sheet12.xml")).toBe("Sheet12");
  });
  it("无匹配返回原路径", () => {
    expect(sheetNameFromPath("other.xml")).toBe("other.xml");
  });
});
