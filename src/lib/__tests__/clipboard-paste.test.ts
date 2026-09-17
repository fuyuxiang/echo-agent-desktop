import { describe, it, expect } from "vitest";
import {
  isLikelyImageMime,
  extractImageFilesFromClipboard,
  blobToBytes,
} from "../clipboard-paste";

class FakeFile {
  name: string;
  type: string;
  size: number;
  content: Uint8Array;
  constructor(name: string, type: string, content = "x") {
    this.name = name;
    this.type = type;
    this.content = new TextEncoder().encode(content);
    this.size = this.content.byteLength;
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    // FakeFile 仅用于单测,避免依赖运行时 SharedArrayBuffer 判定。
    return this.content.buffer.slice(
      this.content.byteOffset,
      this.content.byteOffset + this.content.byteLength,
    ) as ArrayBuffer;
  }
}

class FakeDataTransferItem {
  kind: "file" | "string";
  type: string;
  file: FakeFile | null;
  constructor(kind: "file" | "string", type: string, file: FakeFile | null = null) {
    this.kind = kind;
    this.type = type;
    this.file = file;
  }
  getAsFile(): File | null {
    if (this.kind !== "file" || !this.file) return null;
    return this.file as unknown as File;
  }
}

describe("isLikelyImageMime", () => {
  it("accepts common image mime types", () => {
    expect(isLikelyImageMime("image/png")).toBe(true);
    expect(isLikelyImageMime("image/jpeg")).toBe(true);
    expect(isLikelyImageMime("image/jpg")).toBe(true);
    expect(isLikelyImageMime("image/gif")).toBe(true);
    expect(isLikelyImageMime("image/webp")).toBe(true);
    expect(isLikelyImageMime("image/bmp")).toBe(false);
  });

  it("rejects non-image mimes", () => {
    expect(isLikelyImageMime("text/plain")).toBe(false);
    expect(isLikelyImageMime("application/pdf")).toBe(false);
    expect(isLikelyImageMime("")).toBe(false);
    expect(isLikelyImageMime("video/mp4")).toBe(false);
  });
});

describe("extractImageFilesFromClipboard", () => {
  it("returns empty list when items is null/undefined/empty", () => {
    expect(extractImageFilesFromClipboard(null)).toEqual([]);
    expect(extractImageFilesFromClipboard(undefined)).toEqual([]);
    expect(extractImageFilesFromClipboard([])).toEqual([]);
  });

  it("keeps only file-kind items with image/* mime", () => {
    const imageItem = new FakeDataTransferItem(
      "file",
      "image/png",
      new FakeFile("a.png", "image/png"),
    );
    const pdfItem = new FakeDataTransferItem(
      "file",
      "application/pdf",
      new FakeFile("b.pdf", "application/pdf"),
    );
    const textItem = new FakeDataTransferItem("string", "text/plain");

    const out = extractImageFilesFromClipboard([imageItem, pdfItem, textItem]);
    expect(out).toHaveLength(1);
    expect(out[0].mime).toBe("image/png");
    expect(out[0].blob).toBe(imageItem.file);
  });

  it("supports pasting several images at once", () => {
    const items = [
      new FakeDataTransferItem(
        "file",
        "image/png",
        new FakeFile("a.png", "image/png"),
      ),
      new FakeDataTransferItem(
        "file",
        "image/jpeg",
        new FakeFile("b.jpg", "image/jpeg"),
      ),
    ];
    const out = extractImageFilesFromClipboard(items);
    expect(out.map((i) => i.mime)).toEqual(["image/png", "image/jpeg"]);
  });

  it("skips file items whose getAsFile() returns null", () => {
    const brokenItem = new FakeDataTransferItem("file", "image/png", null);
    const realItem = new FakeDataTransferItem(
      "file",
      "image/png",
      new FakeFile("a.png", "image/png"),
    );
    const out = extractImageFilesFromClipboard([brokenItem, realItem]);
    expect(out).toHaveLength(1);
    expect(out[0].blob).toBe(realItem.file);
  });

  it("falls back to 'image' when filename is missing", () => {
    const item = new FakeDataTransferItem(
      "file",
      "image/png",
      new FakeFile("", "image/png"),
    );
    const [first] = extractImageFilesFromClipboard([item]);
    expect(first.suggestedName.length).toBeGreaterThan(0);
  });
});

describe("blobToBytes", () => {
  it("returns the full blob bytes", async () => {
    const blob = new FakeFile("a", "image/png", "hello") as unknown as Blob;
    const bytes = await blobToBytes(blob);
    expect(Array.from(bytes)).toEqual([
      "h".charCodeAt(0),
      "e".charCodeAt(0),
      "l".charCodeAt(0),
      "l".charCodeAt(0),
      "o".charCodeAt(0),
    ]);
  });

  it("propagates errors from arrayBuffer()", async () => {
    const blob = {
      arrayBuffer: () => Promise.reject(new Error("disk fail")),
    } as unknown as Blob;
    await expect(blobToBytes(blob)).rejects.toThrow("disk fail");
  });
});
