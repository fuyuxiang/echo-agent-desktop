import { describe, expect, it } from "vitest";
import {
  LEGACY_ATTACHMENT_HEADING,
  attachmentBasename,
  isImageAttachment,
  parseLegacyAttachmentPrompt,
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

  it("normalizes both Windows and POSIX basenames", () => {
    expect(attachmentBasename("C:\\docs\\方案.docx")).toBe("方案.docx");
    expect(attachmentBasename("/tmp/report.pdf")).toBe("report.pdf");
  });
});
