import { describe, it, expect } from "vitest";
import {
  collectSessionArtifacts,
  findToolCall,
} from "../session-artifacts";
import type { ChatMessage } from "@/stores/session-store";

describe("session-artifacts", () => {
  it("collects unique paths from diffs and titles", () => {
    const messages: ChatMessage[] = [
      {
        id: "a1",
        role: "assistant",
        complete: true,
        parts: [
          {
            kind: "tool_call",
            toolCall: {
              toolCallId: "t1",
              title: "Write C:\\Users\\example\\hello.txt",
              kind: "edit",
              status: "completed",
              content: [
                {
                  type: "diff",
                  diff: {
                    path: "C:\\Users\\example\\hello.txt",
                    old: "",
                    new: "hello",
                  },
                },
              ],
            },
          },
          {
            kind: "tool_call",
            toolCall: {
              toolCallId: "t2",
              title: "Write C:\\Users\\example\\hello.txt",
              kind: "edit",
              status: "completed",
              content: [],
            },
          },
        ],
      },
    ];
    const arts = collectSessionArtifacts(messages);
    expect(arts).toHaveLength(1);
    expect(arts[0].path.toLowerCase()).toContain("hello.txt");
    expect(arts[0].toolCallId).toBe("t2"); // last write wins
  });

  it("does not treat read/open/search inputs as task outputs", () => {
    const messages: ChatMessage[] = [
      toolMessage("read_file", "Read C:\\Users\\example\\config.toml", "completed", {
        path: "C:\\Users\\example\\config.toml",
      }),
      toolMessage("other", "Open /tmp/reference.md", "completed", {
        file: "/tmp/reference.md",
      }),
      toolMessage("grep", "Search src", "completed", { path: "src" }),
    ];
    expect(collectSessionArtifacts(messages)).toEqual([]);
  });

  it("keeps the last real producer when the file is read afterwards", () => {
    const messages: ChatMessage[] = [
      toolMessage("edit", "Write /work/result.md", "completed", {
        path: "/work/result.md",
      }),
      toolMessage("read_file", "Read /work/result.md", "completed", {
        path: "/work/result.md",
      }),
    ];
    const [artifact] = collectSessionArtifacts(messages);
    expect(artifact).toMatchObject({
      path: "/work/result.md",
      toolCallId: "edit-Write /work/result.md",
      kind: "edit",
    });
  });

  it("rejects failed writes and shell command path guesses", () => {
    const messages: ChatMessage[] = [
      toolMessage("edit", "Write /work/failed.md", "failed", {
        path: "/work/failed.md",
      }),
      toolMessage("run_terminal_command", "Copy files", "completed", {
        command: "cp /input.md /output.md",
        path: "/output.md",
      }),
    ];
    expect(collectSessionArtifacts(messages)).toEqual([]);
  });

  it("accepts structured diffs from an unknown provider tool", () => {
    const message = toolMessage("connector_tool", "Provider action", "completed");
    const part = message.parts[0];
    if (part.kind === "tool_call") {
      part.toolCall.content = [{
        type: "diff",
        diff: { path: "/work/generated.json", old: "", new: "{}" },
      }];
    }
    expect(collectSessionArtifacts([message])[0]).toMatchObject({
      path: "/work/generated.json",
      verifiedOutput: true,
    });
  });

  it("removes a previously produced artifact after a completed delete", () => {
    const messages = [
      toolMessage("edit", "Write /work/temporary.md", "completed", {
        path: "/work/temporary.md",
      }),
      toolMessage("delete", "Delete /work/temporary.md", "completed", {
        path: "/work/temporary.md",
      }),
    ];
    expect(collectSessionArtifacts(messages)).toEqual([]);
  });

  it("tracks only the destination when a produced file is moved", () => {
    const messages = [
      toolMessage("edit", "Write /work/draft.md", "completed", {
        path: "/work/draft.md",
      }),
      toolMessage("move", "Move file", "completed", {
        path: "/work/draft.md",
        target: "/work/final.md",
      }),
    ];
    expect(collectSessionArtifacts(messages).map((item) => item.path))
      .toEqual(["/work/final.md"]);
  });

  it("does not mistake copy source arrays for generated outputs", () => {
    const messages = [toolMessage("copy", "Copy files", "completed", {
      files: ["/input/one.md", "/input/two.md"],
      destination: "/work/bundle.md",
    })];
    expect(collectSessionArtifacts(messages).map((item) => item.path))
      .toEqual(["/work/bundle.md"]);
  });

  it("does not list created directories as file artifacts", () => {
    const messages = [toolMessage("create_directory", "Create directory /work/output", "completed", {
      path: "/work/output",
    })];
    expect(collectSessionArtifacts(messages)).toEqual([]);
  });

  it("findToolCall locates by id", () => {
    const messages: ChatMessage[] = [
      {
        id: "a1",
        role: "assistant",
        complete: true,
        parts: [
          {
            kind: "tool_call",
            toolCall: {
              toolCallId: "abc",
              title: "read",
              kind: "read",
              status: "completed",
              content: [],
            },
          },
        ],
      },
    ];
    expect(findToolCall(messages, "abc")?.kind).toBe("read");
    expect(findToolCall(messages, "nope")).toBeUndefined();
  });
});

function toolMessage(
  kind: string,
  title: string,
  status: "in_progress" | "completed" | "failed",
  rawInput?: unknown,
): ChatMessage {
  return {
    id: `${kind}-${title}`,
    role: "assistant",
    complete: status !== "in_progress",
    parts: [{
      kind: "tool_call",
      toolCall: {
        toolCallId: `${kind}-${title}`,
        title,
        kind,
        status,
        content: [],
        rawInput,
      },
    }],
  };
}
