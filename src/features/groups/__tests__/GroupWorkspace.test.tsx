import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { GroupWorkspace } from "../GroupWorkspace";
import { useGroupStore } from "../group-store";
import { groupSend, groupMemberChange, type Group } from "../group-client";
import { useKnowledgeStore } from "@/stores/knowledge-store";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("@/lib/agent-client", async original => ({ ...await original<typeof import("@/lib/agent-client")>(), agentsList: vi.fn(async () => []) }));
vi.mock("../group-client", async original => ({ ...await original<typeof import("../group-client")>(), groupSend: vi.fn(async () => {}), groupMemberChange: vi.fn(async () => {}) }));
vi.mock("@/components/MessageItem", () => ({ MessageItem: () => <div>成员回答</div> }));

let measuredWidth: number | null = null;
vi.mock("@/lib/use-element-size", () => ({ useElementSize: (_ref: unknown, dimension: string) => dimension === "width" ? measuredWidth : null }));

const group: Group = { id:"reply-group",name:"需求协作组",goal:"验证",cwd:"/work",sourceSessionId:null,sourceTeamId:null,
  coordinatorId:"c",members:[
    {id:"c",name:"协调员",expert:null,role:"协调",modelId:"test",sessionId:"native-c",discussionSessionId:null,generation:0},
    {id:"e",name:"代码专家",expert:"代码专家",role:"编码",modelId:"test",sessionId:"native-e",discussionSessionId:null,generation:0},
  ], messages:[{id:"answer",seq:1,kind:"assistant",text:"请回复我",memberId:"e",createdAt:0,workId:null,replyTo:null,attachments:[],toolCalls:[]}],
  works:[],decisions:[],archived:false,pinned:false,paused:false,revision:1,updatedAt:1,maxCalls:12,tokenBudget:100000 };

beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks(); measuredWidth = null;
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

it("按实际聊天宽度初始化详情面板，并保留用户主动展开的选择", () => {
  measuredWidth = 760;
  const view = render(<GroupWorkspace cwd="/work" models={[{id:"test",label:"测试"}]} workspaces={[]} onToast={() => {}} onOpenSettings={() => {}} />);
  const details = screen.getByRole("button", {name:"专家团详情"});
  expect(details).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(details);
  expect(details).toHaveAttribute("aria-expanded", "true");
  measuredWidth = 600;
  view.rerender(<GroupWorkspace cwd="/work" models={[{id:"test",label:"测试"}]} workspaces={[]} onToast={() => {}} onOpenSettings={() => {}} />);
  expect(details).toHaveAttribute("aria-expanded", "true");
});

it("补充后启动失败仍展示原因、重试入口和原请求", () => {
  const current=structuredClone(group);
  current.messages=[{...current.messages[0],id:"root",kind:"user",memberId:null,text:"原始交付目标"},
    {...current.messages[0],id:"supplement",seq:2,kind:"user",memberId:null,text:"补充约束",requestId:"root"}];
  current.works=[{id:"failure",rootId:"root",parentId:null,continuationOf:null,memberId:"e",prompt:"交付",status:"failed",discussion:false,sessionId:null,output:"",error:"模型连接失败",createdAt:1,tokens:0}];
  useGroupStore.setState({current});
  render(<GroupWorkspace cwd="/work" models={[{id:"test",label:"测试"}]} workspaces={[]} onToast={() => {}} onOpenSettings={() => {}} />);
  expect(screen.getByText("模型连接失败")).toBeInTheDocument();
  expect(screen.getAllByRole("button",{name:"检查后重试"}).length).toBeGreaterThan(0);
  expect(screen.getByText("补充原请求：原始交付目标")).toBeInTheDocument();
  expect(document.querySelector(".group-chat__header .group-status")?.textContent).toBe("执行失败");
});

it("清除成员记忆失败保留确认框，允许原地重试", async () => {
  vi.mocked(groupMemberChange).mockRejectedValueOnce(new Error("记忆目录暂时不可写"));
  render(<GroupWorkspace cwd="/work" models={[{id:"test",label:"测试"}]} workspaces={[]} onToast={() => {}} onOpenSettings={() => {}} />);
  const details=screen.getByRole("button",{name:"专家团详情"});
  if(details.getAttribute("aria-expanded") === "false") fireEvent.click(details);
  fireEvent.click(screen.getByText("管理成员"));
  fireEvent.click(screen.getAllByRole("button",{name:"清除成员记忆"})[0]);
  const dialog=screen.getByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button",{name:"清除成员记忆"}));
  await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent("记忆目录暂时不可写"));
  expect(dialog).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button",{name:"清除成员记忆"}));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  expect(groupMemberChange).toHaveBeenCalledTimes(2);
});
