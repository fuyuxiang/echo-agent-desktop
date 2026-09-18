import { describe, it, expect } from "vitest";
import { friendlyAttachmentError } from "../attachment-errors";

describe("friendlyAttachmentError", () => {
  it("把未授权错误翻译成简短中文提示", () => {
    const raw = `Error: 拒绝访问未授权的路径：C:\\Users\\Taurus\\AppData\\Roaming\\com.echoagent.desktop\\clipboard-images\\image.png-1789704470684682000-e6a3ab.png`;
    const result = friendlyAttachmentError(raw, `C:\\Users\\Taurus\\AppData\\Roaming\\com.echoagent.desktop\\clipboard-images\\image.png-1789704470684682000-e6a3ab.png`);
    expect(result).toContain("image.png");
    expect(result).not.toContain("Users\\Taurus");
    expect(result).not.toContain("拒绝访问未授权的路径");
    // 不暴露绝对路径给用户
    expect(result).not.toContain("AppData");
    expect(result).not.toContain("Roaming");
  });

  it("区分文件不存在与未授权", () => {
    const missing = `Error: 路径不存在：C:\\Users\\test\\photo.png`;
    expect(friendlyAttachmentError(missing, `C:\\Users\\test\\photo.png`))
      .toContain("已不存在");
    const unauthorized = `Error: 拒绝访问未授权的路径：C:\\Users\\test\\photo.png`;
    expect(friendlyAttachmentError(unauthorized, `C:\\Users\\test\\photo.png`))
      .not.toContain("已不存在");
  });

  it("把符号链接附件拒绝对用户透明化", () => {
    const raw = `Error: 拒绝使用符号链接附件：C:\\Users\\test\\link.png`;
    const result = friendlyAttachmentError(raw, `C:\\Users\\test\\link.png`);
    expect(result).toContain("link.png");
    expect(result).not.toContain("符号链接");
  });

  it("未识别错误时返回简短中文 + 简化技术信息（不暴露完整路径）", () => {
    const raw = `Error: 未知错误：C:\\Users\\test\\secret-file.png：磁盘 I/O 失败`;
    const result = friendlyAttachmentError(raw, `C:\\Users\\test\\secret-file.png`);
    expect(result).toContain("secret-file.png");
    expect(result).not.toContain("Users\\test");
  });

  it("支持 POSIX 路径", () => {
    const raw = `Error: 路径不存在：/private/var/folders/abc/photo.png`;
    const result = friendlyAttachmentError(raw, `/private/var/folders/abc/photo.png`);
    expect(result).toContain("photo.png");
    expect(result).not.toContain("/private");
  });

  it("空路径回退到通用提示", () => {
    const raw = `Error: 拒绝访问未授权的路径：/tmp/foo`;
    const result = friendlyAttachmentError(raw, "");
    expect(result).toContain("附件");
    expect(result).toContain("受限");
  });

  it("非 Error 字符串也兼容", () => {
    const result = friendlyAttachmentError("plain string", "/tmp/file.txt");
    expect(result).toContain("file.txt");
  });

  it("完全未知的内容降级为带文件名的通用失败提示", () => {
    const result = friendlyAttachmentError("???", "/tmp/x.png");
    expect(result).toContain("x.png");
    expect(result).toContain("打开失败");
  });
});