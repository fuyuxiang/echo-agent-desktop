import { describe, expect, it } from "vitest";
import {
  availableClientSlashCommands,
  isClientSlashCommand,
  mergeSlashCommands,
  parseSlashInvocation,
  replaceSlashToken,
  slashCommandSourceLabel,
  slashTokenAtCursor,
} from "../slash-commands";

describe("slash command helpers", () => {
  it("only completes a leading slash token", () => {
    expect(slashTokenAtCursor("  /comp", 7)).toMatchObject({
      start: 2,
      end: 7,
      value: "/comp",
      query: "comp",
    });
    expect(slashTokenAtCursor("please /comp", 12)).toBeNull();
    expect(slashTokenAtCursor("/one/two", 8)).toBeNull();
  });

  it("replaces qualified command tokens without leaving stale text", () => {
    expect(replaceSlashToken("/acme:dep trailing", 9, "/acme:deploy")).toEqual({
      text: "/acme:deploy trailing",
      cursor: 13,
    });
  });

  it("parses submitted commands and arguments", () => {
    expect(parseSlashInvocation("  /PLAN off  ")).toEqual({ name: "plan", args: "off" });
    expect(parseSlashInvocation("normal prompt")).toBeNull();
  });

  it("merges client and runtime commands case-insensitively with client precedence", () => {
    const merged = mergeSlashCommands(
      [{ name: "help", description: "desktop", source: "client" }],
      [
        { name: "HELP", description: "runtime", source: "builtin" },
        { name: "compact", description: "runtime", source: "builtin" },
      ],
    );
    expect(merged).toEqual([
      { name: "help", description: "desktop", source: "client" },
      { name: "compact", description: "runtime", source: "builtin" },
    ]);
  });

  it("gates session-only client commands and formats source labels", () => {
    expect(availableClientSlashCommands(false).some((c) => c.name === "plan")).toBe(false);
    expect(availableClientSlashCommands(true).some((c) => c.name === "plan")).toBe(true);
    expect(isClientSlashCommand("HELP")).toBe(true);
    expect(slashCommandSourceLabel("plugin:acme")).toBe("插件 · acme");
  });
});
