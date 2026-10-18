import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AssistantsPanel } from "../AssistantsPanel";
const api = vi.hoisted(() => ({ agentsList: vi.fn(), agentsSave: vi.fn(), agentsUpdate: vi.fn(), agentsDelete: vi.fn(), agentsTemplate: vi.fn() }));
vi.mock("@/lib/agent-client", () => api);
const merge = vi.hoisted(() => vi.fn());
vi.mock("@/lib/expert-definition", () => ({ mergeExpertDefinition: merge }));
const original = '---\nname: Alpha\ndescription: original\nmodel: custom-model\ntools:\n  - read_file\nfuture: keep-me\n---\noriginal instructions';
const alpha = { name:"Alpha", description:"original", scope:"user", path:"/agents/alpha.md", raw:original };

describe("expert editor transactions", () => {
  beforeEach(() => {
    vi.resetAllMocks(); api.agentsList.mockResolvedValue([alpha]);
    merge.mockImplementation(async (_original: string, generated: string) => generated.replace("\n---\n", "\nmodel: custom-model\ntools:\n  - read_file\nfuture: keep-me\n---\n"));
    api.agentsTemplate.mockImplementation(async (name:string,description:string,prompt:string)=>`---\nname: ${name}\ndescription: ${description}\n---\n${prompt}`);
  });
  it("renames in place with expected raw and preserved advanced fields, without delete", async () => {
    api.agentsUpdate.mockResolvedValue({...alpha,name:"Renamed"});
    render(<AssistantsPanel />);
    fireEvent.click(await screen.findByRole("button",{name:"查看专家 Alpha 详情"}));
    fireEvent.click(screen.getByRole("button",{name:"编辑"}));
    fireEvent.change(screen.getByRole("textbox",{name:"专家名称"}),{target:{value:"Renamed"}});
    fireEvent.click(screen.getByRole("button",{name:"保存"}));
    await waitFor(()=>expect(api.agentsUpdate).toHaveBeenCalledOnce());
    expect(api.agentsUpdate.mock.calls[0].slice(0,2)).toEqual(["/agents/alpha.md",original]);
    expect(api.agentsUpdate.mock.calls[0][2]).toContain("future: keep-me");
    expect(api.agentsUpdate.mock.calls[0][2]).toContain("tools:\n  - read_file");
    expect(api.agentsUpdate.mock.calls[0][2]).toContain("name: Renamed");
    expect(api.agentsDelete).not.toHaveBeenCalled(); expect(api.agentsSave).not.toHaveBeenCalled();
    await waitFor(()=>expect(screen.queryByRole("dialog")).toBeNull());
  });
  it("keeps the edited draft when YAML validation cannot safely merge the original", async () => {
    merge.mockRejectedValue(new Error("无法安全合并专家配置，原配置未修改"));
    const toast = vi.fn(); render(<AssistantsPanel onToast={toast} />);
    fireEvent.click(await screen.findByRole("button", {name: "查看专家 Alpha 详情"}));
    fireEvent.click(screen.getByRole("button", {name: "编辑"}));
    fireEvent.change(screen.getByRole("textbox", {name: "专家指令"}), {target: {value: "keep draft"}});
    fireEvent.click(screen.getByRole("button", {name: "保存"}));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringContaining("原配置未修改")));
    expect(api.agentsUpdate).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", {name: "专家指令"})).toHaveValue("keep draft");
  });
  it("keeps a conflicting create draft and does not invoke a destructive save", async () => {
    const toast=vi.fn(); render(<AssistantsPanel onToast={toast} />);
    await screen.findByRole("button",{name:"查看专家 Alpha 详情"});
    fireEvent.click(screen.getByRole("button",{name:"创建专家"}));
    fireEvent.change(screen.getByRole("textbox",{name:"专家名称"}),{target:{value:"Alpha"}});
    fireEvent.change(screen.getByRole("textbox",{name:"专家指令"}),{target:{value:"my unsaved instructions"}});
    fireEvent.click(screen.getByRole("button",{name:"创建"}));
    await waitFor(()=>expect(toast).toHaveBeenCalledWith(expect.stringContaining("已有同名专家")));
    expect(api.agentsSave).not.toHaveBeenCalled(); expect(screen.getByRole("textbox",{name:"专家指令"})).toHaveValue("my unsaved instructions");
  });
  it("retains an edited draft on native stale-write rejection", async () => {
    api.agentsUpdate.mockRejectedValue(new Error("配置已被其他操作修改"));
    const toast=vi.fn(); render(<AssistantsPanel onToast={toast} />);
    fireEvent.click(await screen.findByRole("button",{name:"查看专家 Alpha 详情"})); fireEvent.click(screen.getByRole("button",{name:"编辑"}));
    fireEvent.change(screen.getByRole("textbox",{name:"专家指令"}),{target:{value:"unsaved edit"}}); fireEvent.click(screen.getByRole("button",{name:"保存"}));
    await waitFor(()=>expect(toast).toHaveBeenCalledWith(expect.stringContaining("配置已被其他操作修改")));
    expect(screen.getByRole("textbox",{name:"专家指令"})).toHaveValue("unsaved edit"); expect(api.agentsDelete).not.toHaveBeenCalled();
  });
});
