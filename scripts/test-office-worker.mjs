import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ExcelJS from "exceljs";
import { PDFDocument } from "pdf-lib";

const root = resolve(import.meta.dirname, "..");
const worker = join(root, "src-tauri/resources/office/worker.mjs");
const font = join(root, "src-tauri/resources/office/fonts/NotoSansCJKsc-Regular.otf");
const stagedNode = process.platform === "win32"
  ? join(root, "src-tauri/resources/theia/node/node.exe")
  : join(root, "src-tauri/resources/theia/node/bin/node");
const executable = existsSync(stagedNode) ? stagedNode : process.execPath;
const directory = await mkdtemp(join(tmpdir(), "echo-office-test-"));
const markdown = "# 季度报告\n\n中文段落与 English。\n\n| 项目 | 金额 |\n| --- | ---: |\n| 收入 | 1200 |\n| 公式样本 | =SUM(B2) |\n";

async function run(format, documentMarkdown = markdown, name = `report.${format}`) {
  const path = join(directory, name);
  const child = spawn(executable, ["--max-old-space-size=512", worker, path, font], { stdio: ["pipe", "ignore", "pipe"] });
  let errorText = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { errorText += chunk; });
  child.stdin.end(JSON.stringify({ title: "季度报告", markdown: documentMarkdown, format }));
  const code = await new Promise((fulfill, reject) => {
    child.on("error", reject);
    child.on("close", fulfill);
  });
  assert.equal(code, 0, `${format}: ${errorText}`);
  assert.ok((await stat(path)).size > 1000, `${format} output is unexpectedly small`);
  return path;
}

try {
  const docx = await readFile(await run("docx"));
  assert.equal(docx.toString("utf8", 0, 2), "PK");

  const pdf = await PDFDocument.load(await readFile(await run("pdf")));
  assert.ok(pdf.getPageCount() >= 1);
  const longTable = `# 多页表格\n\n| 项目 | 金额 |\n| --- | ---: |\n${
    Array.from({ length: 80 }, (_, index) => `| 项目 ${index + 1} | ${index * 10} |`).join("\n")
  }`;
  const pagedPdf = await PDFDocument.load(await readFile(await run("pdf", longTable, "paged.pdf")));
  assert.ok(pagedPdf.getPageCount() >= 2, "long PDF table should span pages");

  const book = new ExcelJS.Workbook();
  await book.xlsx.readFile(await run("xlsx"));
  assert.equal(book.worksheets[0].name, "季度报告-1");
  assert.equal(book.worksheets[0].getRow(2).getCell(1).value, "收入");
  assert.equal(book.worksheets[0].getRow(2).getCell(2).value, 1200);
  assert.equal(book.worksheets[0].getRow(3).getCell(2).value, "=SUM(B2)");

  const pptx = await readFile(await run("pptx"));
  assert.equal(pptx.toString("utf8", 0, 2), "PK");
  console.log("Offline Office export smoke passed: docx, pdf, xlsx, pptx");
} finally {
  await rm(directory, { recursive: true, force: true });
}
