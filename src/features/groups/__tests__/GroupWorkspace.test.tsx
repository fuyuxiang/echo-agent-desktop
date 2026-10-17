import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GroupWorkspace } from "../GroupWorkspace";
import { useGroupStore } from "../group-store";
import { groupSend, type Group } from "../group-client";
import { useKnowledgeStore } from "@/stores/knowledge-store";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("@/lib/agent-client", async original => ({ ...await original<typeof import("@/lib/agent-client")>(), agentsList: vi.fn(async () => []) }));
vi.mock("../group-client", async original => ({ ...await original<typeof import("../group-client")>(), groupSend: vi.fn(async () => {}) }));
vi.mock("@/components/MessageItem", () => ({ MessageItem: () => <div>成员回答</div> }));

const group: Group = { id:"reply-group",name:"需求协作组",goal:"验证",cwd:"/work",sourceSessionId:null,sourceTeamId:null,
  coordinatorId:"c",members:[
    {id:"c",name:"协调员",expert:null,role:"协调",modelId:"test",sessionId:"native-c",discussionSessionId:null,generation:0},
    {id:"e",name:"代码专家",expert:"代码专家",role:"编码",modelId:"test",sessionId:"native-e",discussionSessionId:null,generation:0},
  ], messages:[{id:"answer",seq:1,kind:"assistant",text:"请回复我",memberId:"e",createdAt:0,workId:null,replyTo:null,attachments:[],toolCalls:[]}],
  works:[],decisions:[],archived:false,pinned:false,paused:false,revision:1,updatedAt:1,maxCalls:12,tokenBudget:100000 };

beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks();
  useKnowledgeStore.setState({defaultSources:[],sessionSources:{},defaultOrganizationScopeIds:[],sessionOrganizationScopeIds:{}});
  useGroupStore.setState({current:structuredClone(group),currentId:group.id,groups:[structuredClone(group)],drafts:{},outbox:{},error:null});
});
afterEach(cleanup);

it("回复收件人可改为协调员，引用保留，发送对象与界面一致", async () => {
  render(<GroupWorkspace cwd="/work" models={[{id:"test",label:"测试"}]} workspaces={[]} onToast={() => {}} onOpenSettings={() => {}} />);
  fireEvent.click(screen.getByRole("button",{name:"回复代码专家"}));
  expect(document.querySelector(".group-recipient-row .group-recipient")?.textContent).toBe("代码专家");
  fireEvent.click(document.querySelector(".group-recipient-row button.group-recipient")!);
  expect(document.querySelector(".group-recipient-row .group-recipient")?.textContent).toBe("协调员");
  expect(document.querySelector(".group-reply")?.textContent).toContain("请回复我");
  fireEvent.change(screen.getByPlaceholderText(/说明目标，或输入 @选择成员/),{target:{value:"请结合这条回复汇总"}});
  fireEvent.click(screen.getByRole("button",{name:"发送"}));
  await waitFor(() => expect(groupSend).toHaveBeenCalledWith(group.id,expect.objectContaining({memberIds:["c"],replyTo:"answer",text:"请结合这条回复汇总"})));
});
