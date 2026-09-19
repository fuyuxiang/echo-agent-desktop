import { describe, expect, it } from "vitest";

import {
  atTokenAtCursor,
  replaceAtToken,
  type AtToken,
} from "@/lib/at-commands";

describe("atTokenAtCursor", () => {
  it("detects a token at the start of input", () => {
    const t: AtToken | null = atTokenAtCursor("@sym", 4);
    expect(t).not.toBeNull();
    expect(t?.start).toBe(0);
    expect(t?.end).toBe(4);
    expect(t?.value).toBe("@sym");
    expect(t?.query).toBe("sym");
  });

  it("detects a token mid-sentence when preceded by whitespace", () => {
    const t = atTokenAtCursor("hello @src/foo", "hello @src/foo".length);
    expect(t).not.toBeNull();
    expect(t?.start).toBe(6);
    expect(t?.query).toBe("src/foo");
  });

  it("rejects a token whose preceding character is non-whitespace", () => {
    expect(atTokenAtCursor("foo@bar", "foo@bar".length)).toBeNull();
    expect(atTokenAtCursor("user@example.com", "user@example.com".length)).toBeNull();
  });

  it("rejects a token that already contains whitespace", () => {
    // Cursor positioned *after* the whitespace — token must be closed.
    expect(atTokenAtCursor("@sym foo", 5)).toBeNull();
    expect(atTokenAtCursor("@sym foo", 8)).toBeNull();
    expect(atTokenAtCursor("@sym\nfoo", 5)).toBeNull();
  });

  it("rejects an unknown preceding character", () => {
    expect(atTokenAtCursor("a@b", 3)).toBeNull();
  });

  it("accepts path separators and dots", () => {
    const t = atTokenAtCursor("@src/utils/file.ts", 18);
    expect(t?.query).toBe("src/utils/file.ts");
  });

  it("accepts symbol references like @file.ts:42", () => {
    const t = atTokenAtCursor("@file.ts:42", 11);
    expect(t?.query).toBe("file.ts:42");
  });
});

describe("replaceAtToken", () => {
  it("returns null when there is no active token", () => {
    expect(replaceAtToken("plain text", 5, "@src/foo")).toBeNull();
  });

  it("replaces the token and inserts a trailing space", () => {
    // cursor sits immediately after the "@sym" token; no trailing whitespace
    // yet, so the replacement is "@src/foo " followed by whatever followed.
    const result = replaceAtToken("see @sym", 8, "@src/foo");
    expect(result).not.toBeNull();
    expect(result?.text).toBe("see @src/foo ");
    expect(result?.cursor).toBe("see @src/foo ".length);
  });

  it("replaces the token with cursor inside (drops trailing space)", () => {
    // cursor sits between "@sym" and " foo" — token is still "@sym".
    const result = replaceAtToken("see @sym foo", 8, "@src/foo");
    expect(result).not.toBeNull();
    expect(result?.text).toBe("see @src/foo foo");
  });

  it("preserves text before and after the token", () => {
    const text = "before @sym after";
    const cursor = "before @sym".length;
    const result = replaceAtToken(text, cursor, "@src/foo");
    expect(result).not.toBeNull();
    expect(result?.text).toBe("before @src/foo after");
    expect(result?.cursor).toBe("before @src/foo ".length);
  });
});
