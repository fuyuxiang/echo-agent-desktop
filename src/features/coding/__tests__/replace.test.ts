import { describe, expect, it } from "vitest";

import {
  countOccurrences,
  describeReplacePlan,
  replaceAll,
  replaceAtLine,
} from "../lib/replace";

describe("countOccurrences", () => {
  it("counts non-overlapping matches", () => {
    expect(countOccurrences("aaa", "a")).toBe(3);
    expect(countOccurrences("aaaa", "aa")).toBe(2);
  });

  it("returns zero for an empty needle or no match", () => {
    expect(countOccurrences("abc", "")).toBe(0);
    expect(countOccurrences("abc", "z")).toBe(0);
  });

  it("treats the needle literally, not as a pattern", () => {
    expect(countOccurrences("a.c abc", ".")).toBe(1);
  });
});

describe("replaceAll", () => {
  it("replaces every occurrence and reports the count", () => {
    const result = replaceAll("foo bar foo", "foo", "baz");
    expect(result.content).toBe("baz bar baz");
    expect(result.count).toBe(2);
  });

  it("leaves content untouched when nothing matches", () => {
    const result = replaceAll("foo", "zzz", "x");
    expect(result.content).toBe("foo");
    expect(result.count).toBe(0);
  });

  it("does not interpret regex metacharacters", () => {
    const result = replaceAll("a.c and abc", ".", "-");
    expect(result.content).toBe("a-c and abc");
    expect(result.count).toBe(1);
  });

  it("supports replacing with an empty string", () => {
    expect(replaceAll("keep me", " me", "").content).toBe("keep");
  });
});

describe("replaceAtLine", () => {
  const content = "line one foo\nline two foo\nline three";

  it("replaces only the first match on the requested line", () => {
    const result = replaceAtLine(content, 2, "foo", "bar");
    expect(result).toBe("line one foo\nline two bar\nline three");
  });

  it("returns null when the line no longer contains the needle", () => {
    expect(replaceAtLine(content, 3, "foo", "bar")).toBeNull();
  });

  it("returns null for a line outside the file", () => {
    expect(replaceAtLine(content, 99, "foo", "bar")).toBeNull();
    expect(replaceAtLine(content, 0, "foo", "bar")).toBeNull();
  });

  it("preserves the file's other lines exactly", () => {
    const result = replaceAtLine("a\nb foo\nc", 2, "foo", "X");
    expect(result?.split("\n")).toEqual(["a", "b X", "c"]);
  });
});

describe("describeReplacePlan", () => {
  it("summarises files and occurrences", () => {
    expect(describeReplacePlan([{ path: "a.ts", count: 2 }, { path: "b.ts", count: 1 }])).toBe(
      "将在 2 个文件中替换 3 处匹配",
    );
  });

  it("ignores files with no occurrences", () => {
    expect(describeReplacePlan([{ path: "a.ts", count: 2 }, { path: "b.ts", count: 0 }])).toBe(
      "将在 1 个文件中替换 2 处匹配",
    );
  });

  it("reports when there is nothing to do", () => {
    expect(describeReplacePlan([])).toBe("没有可替换的匹配项");
    expect(describeReplacePlan([{ path: "a.ts", count: 0 }])).toBe("没有可替换的匹配项");
  });
});
