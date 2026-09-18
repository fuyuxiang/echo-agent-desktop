import { describe, expect, it } from "vitest";
import {
  AttachmentKind,
  LEGACY_ATTACHMENT_HEADING,
  attachmentBasename,
  classifyAttachment,
  isImageAttachment,
  parseLegacyAttachmentPrompt,
  stripAttachmentTransportContext,
  stripInjectedUserContext,
} from "../user-message";

describe("isImageAttachment", () => {
  it("与 ACP 多模态附件格式保持一致", () => {
    expect(isImageAttachment("/tmp/a.PNG")).toBe(true);
    expect(isImageAttachment("C:\\tmp\\a.jpeg")).toBe(true);
    expect(isImageAttachment("/tmp/a.gif")).toBe(true);
    expect(isImageAttachment("/tmp/a.webp")).toBe(true);
    expect(isImageAttachment("/tmp/a.svg")).toBe(false);
    expect(isImageAttachment("/tmp/a.docx")).toBe(false);
  });
});

describe("classifyAttachment — 多类型附件分类契约", () => {
  // 图片:沿用多模态管线白名单
  it("图片格式返回 Image", () => {
    expect(classifyAttachment("/tmp/a.png")).toBe(AttachmentKind.Image);
    expect(classifyAttachment("/tmp/a.PNG")).toBe(AttachmentKind.Image);
    expect(classifyAttachment("/tmp/a.jpg")).toBe(AttachmentKind.Image);
    expect(classifyAttachment("/tmp/a.jpeg")).toBe(AttachmentKind.Image);
    expect(classifyAttachment("/tmp/a.gif")).toBe(AttachmentKind.Image);
    expect(classifyAttachment("/tmp/a.webp")).toBe(AttachmentKind.Image);
  });

  // 文档:PDF / Office / OpenDocument / ePub
  it("文档格式返回 Document", () => {
    expect(classifyAttachment("/tmp/a.pdf")).toBe(AttachmentKind.Document);
    expect(classifyAttachment("/tmp/a.docx")).toBe(AttachmentKind.Document);
    expect(classifyAttachment("/tmp/a.doc")).toBe(AttachmentKind.Document);
    expect(classifyAttachment("/tmp/a.xlsx")).toBe(AttachmentKind.Document);
    expect(classifyAttachment("/tmp/a.xls")).toBe(AttachmentKind.Document);
    expect(classifyAttachment("/tmp/a.pptx")).toBe(AttachmentKind.Document);
    expect(classifyAttachment("/tmp/a.rtf")).toBe(AttachmentKind.Document);
    expect(classifyAttachment("/tmp/a.odt")).toBe(AttachmentKind.Document);
    expect(classifyAttachment("/tmp/a.epub")).toBe(AttachmentKind.Document);
  });

  // 代码源文件:agent 场景最高频
  it("代码格式返回 Code", () => {
    expect(classifyAttachment("/tmp/a.ts")).toBe(AttachmentKind.Code);
    expect(classifyAttachment("/tmp/a.tsx")).toBe(AttachmentKind.Code);
    expect(classifyAttachment("/tmp/a.js")).toBe(AttachmentKind.Code);
    expect(classifyAttachment("/tmp/a.py")).toBe(AttachmentKind.Code);
    expect(classifyAttachment("/tmp/a.rs")).toBe(AttachmentKind.Code);
    expect(classifyAttachment("/tmp/a.go")).toBe(AttachmentKind.Code);
    expect(classifyAttachment("/tmp/a.java")).toBe(AttachmentKind.Code);
    expect(classifyAttachment("/tmp/a.swift")).toBe(AttachmentKind.Code);
    expect(classifyAttachment("/tmp/a.kt")).toBe(AttachmentKind.Code);
    expect(classifyAttachment("/tmp/a.cpp")).toBe(AttachmentKind.Code);
    expect(classifyAttachment("/tmp/a.c")).toBe(AttachmentKind.Code);
    expect(classifyAttachment("/tmp/a.h")).toBe(AttachmentKind.Code);
    expect(classifyAttachment("/tmp/a.sql")).toBe(AttachmentKind.Code);
    expect(classifyAttachment("/tmp/a.vue")).toBe(AttachmentKind.Code);
    expect(classifyAttachment("/tmp/a.svelte")).toBe(AttachmentKind.Code);
    expect(classifyAttachment("/tmp/a.sh")).toBe(AttachmentKind.Code);
    expect(classifyAttachment("/tmp/a.ps1")).toBe(AttachmentKind.Code);
  });

  // 文本/数据
  it("文本格式返回 Text", () => {
    expect(classifyAttachment("/tmp/a.txt")).toBe(AttachmentKind.Text);
    expect(classifyAttachment("/tmp/a.md")).toBe(AttachmentKind.Text);
    expect(classifyAttachment("/tmp/a.markdown")).toBe(AttachmentKind.Text);
    expect(classifyAttachment("/tmp/a.log")).toBe(AttachmentKind.Text);
    expect(classifyAttachment("/tmp/a.rst")).toBe(AttachmentKind.Text);
  });

  it("数据格式返回 Data", () => {
    expect(classifyAttachment("/tmp/a.json")).toBe(AttachmentKind.Data);
    expect(classifyAttachment("/tmp/a.yaml")).toBe(AttachmentKind.Data);
    expect(classifyAttachment("/tmp/a.yml")).toBe(AttachmentKind.Data);
    expect(classifyAttachment("/tmp/a.toml")).toBe(AttachmentKind.Data);
    expect(classifyAttachment("/tmp/a.csv")).toBe(AttachmentKind.Data);
    expect(classifyAttachment("/tmp/a.xml")).toBe(AttachmentKind.Data);
    expect(classifyAttachment("/tmp/a.proto")).toBe(AttachmentKind.Data);
  });

  // 安全护栏:可执行与脚本二进制不应被允许
  it("可执行格式被显式拒绝", () => {
    expect(classifyAttachment("/tmp/a.exe")).toBe(AttachmentKind.Unsupported);
    expect(classifyAttachment("/tmp/a.dll")).toBe(AttachmentKind.Unsupported);
    expect(classifyAttachment("/tmp/a.so")).toBe(AttachmentKind.Unsupported);
    expect(classifyAttachment("/tmp/a.dylib")).toBe(AttachmentKind.Unsupported);
    expect(classifyAttachment("/tmp/a.app")).toBe(AttachmentKind.Unsupported);
    expect(classifyAttachment("/tmp/a.pkg")).toBe(AttachmentKind.Unsupported);
    expect(classifyAttachment("/tmp/a.dmg")).toBe(AttachmentKind.Unsupported);
    expect(classifyAttachment("/tmp/a.deb")).toBe(AttachmentKind.Unsupported);
    expect(classifyAttachment("/tmp/a.rpm")).toBe(AttachmentKind.Unsupported);
    expect(classifyAttachment("/tmp/a.msi")).toBe(AttachmentKind.Unsupported);
    expect(classifyAttachment("/tmp/a.bat")).toBe(AttachmentKind.Unsupported);
    expect(classifyAttachment("/tmp/a.cmd")).toBe(AttachmentKind.Unsupported);
    expect(classifyAttachment("/tmp/a.com")).toBe(AttachmentKind.Unsupported);
    expect(classifyAttachment("/tmp/a.scr")).toBe(AttachmentKind.Unsupported);
    expect(classifyAttachment("/tmp/a.vbs")).toBe(AttachmentKind.Unsupported);
  });

  it("压缩包暂时不支持(留给二期)", () => {
    expect(classifyAttachment("/tmp/a.zip")).toBe(AttachmentKind.Unsupported);
    expect(classifyAttachment("/tmp/a.tar")).toBe(AttachmentKind.Unsupported);
    expect(classifyAttachment("/tmp/a.gz")).toBe(AttachmentKind.Unsupported);
  });

  // 边界情况
  it("无扩展名或未知扩展名返回 Unsupported", () => {
    expect(classifyAttachment("/tmp/a")).toBe(AttachmentKind.Unsupported);
    expect(classifyAttachment("/tmp/.hidden")).toBe(AttachmentKind.Unsupported);
    expect(classifyAttachment("/tmp/a.xyz")).toBe(AttachmentKind.Unsupported);
    expect(classifyAttachment("")).toBe(AttachmentKind.Unsupported);
  });

  it("路径大小写不敏感、POSIX/Windows 路径都识别", () => {
    expect(classifyAttachment("/tmp/A.PDF")).toBe(AttachmentKind.Document);
    expect(classifyAttachment("C:\\docs\\A.Pdf")).toBe(AttachmentKind.Document);
    expect(classifyAttachment("/tmp/REPORT.JSON")).toBe(AttachmentKind.Data);
  });

  // isImageAttachment 兼容旧路径(必须仍然返回 true 用于 Image)
  it("Image 类同时满足 isImageAttachment", () => {
    expect(isImageAttachment("/tmp/a.png")).toBe(true);
    expect(isImageAttachment("/tmp/a.docx")).toBe(false);
  });
});

describe("user-message attachment compatibility", () => {
  it("extracts legacy document paths without showing the transport suffix", () => {
    const parsed = parseLegacyAttachmentPrompt(
      `请优化文档\n\n${LEGACY_ATTACHMENT_HEADING}\n- @/tmp/方案.docx\n- @C:\\docs\\说明.pdf`,
    );
    expect(parsed).toEqual({
      text: "请优化文档",
      attachments: ["/tmp/方案.docx", "C:\\docs\\说明.pdf"],
    });
  });

  it("重放附件提示时只移除运输尾注，保留模型上下文", () => {
    const modelText = "<!--EXPERT_PERSONA_BEGIN-->expert<!--EXPERT_PERSONA_END-->\n\n用户正文"
      + `\n\n${LEGACY_ATTACHMENT_HEADING}\n- @/tmp/方案.docx`;

    expect(stripAttachmentTransportContext(modelText)).toEqual({
      text: "<!--EXPERT_PERSONA_BEGIN-->expert<!--EXPERT_PERSONA_END-->\n\n用户正文",
      attachments: ["/tmp/方案.docx"],
    });
  });

  it("does not strip an attachment-like heading without valid path rows", () => {
    const text = `普通内容\n\n${LEGACY_ATTACHMENT_HEADING}\n这不是路径`;
    expect(parseLegacyAttachmentPrompt(text)).toEqual({ text, attachments: [] });
  });

  it("removes injected expert and project context from replay text", () => {
    expect(stripInjectedUserContext(
      "<!--EXPERT_PERSONA_BEGIN-->\nexpert\n<!--EXPERT_PERSONA_END-->\n\n"
      + "<system-reminder>project</system-reminder>\n\n用户正文",
    )).toBe("用户正文");
  });

  it("removes repeated expert persona blocks without hiding user text", () => {
    expect(stripInjectedUserContext(
      "prefix\n<!--EXPERT_PERSONA_BEGIN-->one<!--EXPERT_PERSONA_END-->\n"
      + "<!--EXPERT_PERSONA_BEGIN-->two<!--EXPERT_PERSONA_END-->\nuser task",
    )).toBe("prefix\n\n\nuser task");
  });

  it("drops the tail of an unterminated expert persona block", () => {
    expect(stripInjectedUserContext(
      "visible\n<!--EXPERT_PERSONA_BEGIN-->\ninternal",
    )).toBe("visible");
  });

  it("normalizes both Windows and POSIX basenames", () => {
    expect(attachmentBasename("C:\\docs\\方案.docx")).toBe("方案.docx");
    expect(attachmentBasename("/tmp/report.pdf")).toBe("report.pdf");
  });
});
