import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async (command: string, _args?: unknown): Promise<unknown> => {
  if (command === "coding_task_list") return [];
  if (command === "coding_verification_detect") return [];
  return null;
});
const eventListeners = new Map<string, (event: { payload: unknown }) => void>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args: unknown) => invoke(command, args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, callback: (event: { payload: unknown }) => void) => {
    eventListeners.set(name, callback);
    return () => {
      if (eventListeners.get(name) === callback) eventListeners.delete(name);
    };
  }),
}));
vi.mock("@/components/workspace-panel/FileTreeView", () => ({
  FileTreeView: ({
    rootPath,
    onFileSelect,
  }: {
    rootPath: string;
    onFileSelect: (path: string) => void;
  }) => (
    <div data-testid="file-tree">
      <button type="button" onClick={() => onFileSelect(`${rootPath}/src/a.ts`)}>
        打开源文件
      </button>
    </div>
  ),
}));
const readDocument = vi.fn(async (_root: string, path: string) => ({
  path,
  relativePath: path.replace("/repo/", ""),
  content: "disk content",
  hash: "h1",
  size: 12,
  modifiedAt: 0,
  language: "typescript",
  lineEnding: "LF" as const,
}));
const writeDocument = vi.fn(async (_root: string, path: string, content: string, _hash?: string) => ({
  path,
  relativePath: path.replace("/repo/", ""),
  content,
  hash: "h2",
  size: content.length,
  modifiedAt: 0,
  language: "typescript",
  lineEnding: "LF" as const,
}));

vi.mock("@/lib/agent-client", () => ({
  filesystemPickDirectory: vi.fn(async () => "/picked"),
  listDir: vi.fn(async () => []),
  codingReadDocument: (root: string, path: string) => readDocument(root, path),
  codingWriteDocument: (root: string, path: string, content: string, hash: string) =>
    writeDocument(root, path, content, hash),
}));

// These shared components reach for session/permission plumbing that is out of
// scope here; the workbench only needs to render them.
vi.mock("@/components/PermissionPicker", () => ({
  PermissionPicker: () => <div data-testid="permission-picker" />,
}));
vi.mock("@/components/ModelSelector", () => ({
  ModelSelector: () => <div data-testid="model-selector" />,
}));
vi.mock("@/components/PermissionDialog", () => ({
  PermissionInlineCard: () => <div data-testid="permission-card" />,
}));
vi.mock("@/components/QuestionInlineCard", () => ({
  QuestionInlineCard: () => <div data-testid="question-card" />,
}));
vi.mock("@/components/ExecutionProcess", () => ({
  ExecutionProcess: () => <div data-testid="execution" />,
}));
vi.mock("@/components/Markdown", () => ({
  Markdown: ({ children }: { children: string }) => <div>{children}</div>,
}));

import { TaskEvidenceStrip } from "@/features/coding/agent/TaskEvidenceStrip";
import { CodingWorkbench } from "@/features/coding/CodingWorkbench";
import type { CodingTask } from "@/features/coding/lib/types";
import { useAiDraftStore } from "@/features/coding/store/ai-draft-store";
import { useTaskStore } from "@/features/coding/store/task-store";
import { codingRuntimeKey, useCodingRuntimeStore } from "@/features/coding/lib/coding-task-runtime";
import { registerWorkspaceEditor } from "@/features/coding/lib/workspace-editor";

function verificationTask(overrides: Partial<CodingTask> = {}): CodingTask {
  return {
    schemaVersion: 2,
    id: "verification-task",
    name: "验证布局",
    requirement: "验证工作台布局",
    phase: "verifying",
    acceptanceCriteria: [],
    taskNodes: [],
    planIssues: [],
    globalConstraints: [],
    createdAt: "2026-09-13T00:00:00Z",
    updatedAt: "2026-09-13T00:00:01Z",
    ...overrides,
  };
}



function readyEditor(frame: HTMLIFrameElement, initialDirty = 0, saveFailure = false, onSave?: () => Promise<void>) {
  let dirty = initialDirty;
  const origin = new URL(frame.src).origin;
  const token = JSON.parse(frame.name.slice("echo-embed:".length)).bridgeToken;
  const send = (data: object) => act(() => { window.dispatchEvent(new MessageEvent("message", {origin, source: frame.contentWindow, data: {...data, token}})); });
  const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((data: unknown) => {
    const message = data as {type: string; id: string};
    if (!["echo/get-dirty", "echo/save-all"].includes(message.type)) return;
    queueMicrotask(async () => {
      if (message.type === "echo/save-all") await onSave?.();
      if (message.type === "echo/save-all" && saveFailure) send({type: "echo/response", id: message.id, ok: false, error: "disk full"});
      else { if (message.type === "echo/save-all") dirty = 0; send({type: "echo/response", id: message.id, ok: true, value: dirty}); }
    });
  });
  send({type: "echo/ready"}); send({type: "echo/dirty-state", count: dirty});
  return post;
}
function installApi(task: CodingTask) {
  invoke.mockImplementation(async (command: string): Promise<unknown> => {
    if (["coding_task_list", "coding_verification_list", "coding_diagnostics_list", "coding_task_execution_ledger"].includes(command)) return [];
    if (command === "coding_verification_detect") return [{kind: "test", command: "pnpm test", label: "Tests"}];
    if (command === "coding_theia_start") return {url: "http://127.0.0.1:41773/", embedToken: "test-token"};
    if (command === "coding_task_create" || command === "coding_task_get") return task;
    if (command === "coding_task_begin_verification") return {...task, phase: "verifying"};
    if (command === "coding_orchestrator_state") return {task, problems: [], repairRounds: [], changedFileCount: 1, maxRepairRounds: 3};
    if (command === "coding_verification_run") return {id: "check", taskId: task.id, status: "passed"};
    return null;
  });
}
describe("coding remediation: editor ownership and delivery evidence", () => {
  beforeEach(() => {
    invoke.mockReset(); eventListeners.clear(); localStorage.clear();
    useTaskStore.setState({root: "", task: null, summaries: [], changeSet: null, verifications: [], problems: [], ledger: [], orchestrator: null});
    useAiDraftStore.getState().clear();
  });
  it("does not create a task on cancel or save failure, preserving the draft", async () => {
    installApi(verificationTask({phase: "idle"}));
    const onStartRun = vi.fn();
    render(<CodingWorkbench cwd="/repo" apiReady models={[{id: "test-model"}]} defaultModelId="test-model" onStartRun={onStartRun} />);
    readyEditor(await screen.findByTitle("Echo Code IDE") as HTMLIFrameElement, 1, true);
    fireEvent.change(screen.getByRole("textbox", {name: "任务描述"}), {target: {value: "preserve visible buffer"}});
    await userEvent.click(screen.getByRole("button", {name: "开始 Agent 任务"}));
    await userEvent.click(await screen.findByRole("button", {name: "取消"}));
    expect(invoke).not.toHaveBeenCalledWith("coding_task_create", expect.anything());
    await userEvent.click(screen.getByRole("button", {name: "开始 Agent 任务"}));
    await userEvent.click(await screen.findByRole("button", {name: "保存并继续"}));
    expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
    expect(screen.getByRole("textbox", {name: "任务描述"})).toHaveValue("preserve visible buffer");
    expect(invoke).not.toHaveBeenCalledWith("coding_changeset_capture_baseline", expect.anything());
    expect(onStartRun).not.toHaveBeenCalled();
  });
  it("requires acknowledged save before manual verification, and checks clean state again", async () => {
    const task = verificationTask({phase: "delivered"}); installApi(task);
    useTaskStore.setState({root: "/repo", task});
    render(<CodingWorkbench cwd="/repo" />);
    const post = readyEditor(await screen.findByTitle("Echo Code IDE") as HTMLIFrameElement, 1);
    await userEvent.click(screen.getByRole("tab", {name: "验证"}));
    await userEvent.click(await screen.findByRole("button", {name: "运行全部验证"}));
    await screen.findByRole("button", {name: "保存并继续"});
    expect(invoke).not.toHaveBeenCalledWith("coding_task_begin_verification", expect.anything());
    await userEvent.click(screen.getByRole("button", {name: "保存并继续"}));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("coding_verification_run", expect.objectContaining({root: "/repo"})));
    expect(post.mock.calls.filter(([data]) => (data as {type: string}).type === "echo/get-dirty")).toHaveLength(2);
    expect(post.mock.calls.some(([data]) => (data as {type: string}).type === "echo/save-all")).toBe(true);
  });
  it("reads the revision after the real before/after mutation save bridge", async () => {
    let latest = verificationTask({phase: "verifying"});
    installApi(latest);
    const ordinary = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command, args) => {
      if (command === "coding_task_report_interrupted") { latest = {...latest,phase:"paused",updatedAt:"paused-before-save"}; return latest; }
      if (command === "coding_task_begin_followup") { latest = {...latest,phase:"implementing",updatedAt:"followup"}; return latest; }
      if (command === "coding_orchestrator_report_implementation") { latest = {...latest,phase:"verifying",updatedAt:"saved-by-bridge"}; return latest; }
      if (command === "coding_task_get") return latest;
      if (command === "coding_orchestrator_state") return {task:latest,problems:[],repairRounds:[],changedFileCount:1,maxRepairRounds:3};
      return ordinary(command,args);
    });
    useTaskStore.setState({root:"/repo",task:latest});
    render(<CodingWorkbench cwd="/repo" />);
    const frame = await screen.findByTitle("Echo Code IDE") as HTMLIFrameElement;
    const origin = new URL(frame.src).origin;
    const token = JSON.parse(frame.name.slice("echo-embed:".length)).bridgeToken;
    const send = (data: object) => act(() => window.dispatchEvent(new MessageEvent("message",{origin,source:frame.contentWindow,data:{...data,token}})));
    const post = readyEditor(frame,1,false,async () => {
      send({type:"echo/before-mutation",id:"save-before",operation:"write",paths:["/repo/src/a.ts"]});
      await waitFor(() => expect(post).toHaveBeenCalledWith(expect.objectContaining({id:"save-before",ok:true}),origin));
      const response = post.mock.calls.map(([value]) => value as {id:string;value:unknown}).find(value => value.id === "save-before")!;
      send({type:"echo/after-mutation",id:"save-after",ticket:response.value,success:true});
      await waitFor(() => expect(post).toHaveBeenCalledWith(expect.objectContaining({id:"save-after",ok:true}),origin));
    });
    await userEvent.click(screen.getByRole("tab",{name:"验证"}));
    await userEvent.click(await screen.findByRole("button",{name:"运行全部验证"}));
    await userEvent.click(await screen.findByRole("button",{name:"保存并继续"}));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("coding_task_begin_verification",expect.objectContaining({expectedUpdatedAt:"saved-by-bridge"})));
    expect(invoke).toHaveBeenCalledWith("coding_task_report_interrupted",expect.objectContaining({interruption:"paused"}));
  });

  it("preserves the other task editor block when a clean editor reply arrives late", async () => {
    const original = verificationTask({id:"original",phase:"paused",sessionId:"bound"}); installApi(original);
    useTaskStore.setState({root:"/repo",task:original});
    render(<CodingWorkbench cwd="/repo" sessionId="bound" onSendMessage={vi.fn()} />);
    readyEditor(await screen.findByTitle("Echo Code IDE") as HTMLIFrameElement);
    let finish!: (value:number) => void;
    const getDirtyCount = vi.fn(() => new Promise<number>(resolve => {finish=resolve;}));
    const unregister = registerWorkspaceEditor("/repo",{getDirtyCount,saveAll:async()=>true});
    await userEvent.click(screen.getByRole("button",{name:"继续执行"}));
    await waitFor(() => expect(getDirtyCount).toHaveBeenCalledOnce());
    act(() => {
      useTaskStore.setState({task:verificationTask({id:"other",phase:"paused"})});
      useCodingRuntimeStore.getState().setEditorBlock("/repo","other","保留另一任务的保存错误");
    });
    await act(async () => {finish(0);});
    expect(useCodingRuntimeStore.getState().editorBlocks[codingRuntimeKey("/repo","other")]).toBe("保留另一任务的保存错误");
    expect(invoke).not.toHaveBeenCalledWith("coding_task_resume",expect.anything());
    unregister();
  });

  it("does not claim delivery before current gates are satisfied and offers the pending action", async () => {
    const task = verificationTask({phase: "delivered"}); const onOpenReport = vi.fn();
    invoke.mockResolvedValue({task, deliverable: false, gates: [{id: "acceptance", title: "人工验收", summary: "确认原始需求", status: "not_satisfied"}, {id: "test", status: "not_applicable"}]});
    const view = render(<TaskEvidenceStrip root="/repo-a" task={task} revision={0} needsInput={false} onOpenPlan={() => {}} onOpenReport={onOpenReport} />);
    expect(await screen.findByText("门禁 0/1")).toBeInTheDocument();
    expect(screen.getByText("待验收")).toBeInTheDocument(); expect(screen.queryByText("已交付")).toBeNull();
    expect(screen.getByText("工作区：/repo-a")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", {name: "下一步：人工验收"})); expect(onOpenReport).toHaveBeenCalledOnce();
    invoke.mockResolvedValue({task, deliverable: true, gates: [{id: "acceptance", status: "satisfied"}, {id: "test", status: "not_applicable"}]});
    view.rerender(<TaskEvidenceStrip root="/repo-a" task={task} revision={1} needsInput={false} onOpenPlan={() => {}} onOpenReport={onOpenReport} />);
    expect(await screen.findByText("满足交付条件")).toBeInTheDocument();
    expect(screen.getByText("门禁 1/1")).toBeInTheDocument();
  });
  it("cancels a preflight started in A after switching to B without creating in either root", async () => {
    const task = verificationTask({phase: "idle"}); installApi(task);
    const ordinary = invoke.getMockImplementation()!; let hold = false; let entered = false; let release!: (value: unknown) => void;
    const pending = new Promise(resolve => { release = resolve; });
    invoke.mockImplementation(async (command, args) => command === "coding_task_list" && hold && (args as {root: string}).root === "/a" ? (entered = true, pending) : ordinary(command, args));
    const onStartRun = vi.fn(); const props = {apiReady: true, models: [{id: "test-model"}], defaultModelId: "test-model", onStartRun};
    const view = render(<CodingWorkbench cwd="/a" {...props} />);
    readyEditor(await screen.findByTitle("Echo Code IDE") as HTMLIFrameElement);
    await waitFor(() => expect(useTaskStore.getState().root).toBe("/a")); hold = true;
    fireEvent.change(screen.getByRole("textbox", {name: "任务描述"}), {target: {value: "Only A"}});
    await userEvent.click(screen.getByRole("button", {name: "开始 Agent 任务"}));
    await waitFor(() => expect(entered).toBe(true));
    view.rerender(<CodingWorkbench cwd="/b" {...props} />);
    await act(async () => { release([]); await pending; });
    expect(useTaskStore.getState().root).toBe("/b");
    expect(invoke).not.toHaveBeenCalledWith("coding_task_create", expect.anything()); expect(onStartRun).not.toHaveBeenCalled();
  });
  it("saves the visible buffer before capturing the new task baseline", async () => {
    installApi(verificationTask({id: "saved-task", phase: "discovering", sessionId: "bound"}));
    const onStartRun = vi.fn(async (_root, _requirement, _model, _paths, bind) => {await bind("bound"); return "bound";});
    render(<CodingWorkbench cwd="/saved" apiReady models={[{id: "model"}]} defaultModelId="model" onStartRun={onStartRun} />);
    const post = readyEditor(await screen.findByTitle("Echo Code IDE") as HTMLIFrameElement, 1);
    fireEvent.change(screen.getByRole("textbox", {name: "任务描述"}), {target: {value: "Use saved B"}});
    await userEvent.click(screen.getByRole("button", {name: "开始 Agent 任务"}));
    await userEvent.click(await screen.findByRole("button", {name: "保存并继续"}));
    await waitFor(() => expect(onStartRun).toHaveBeenCalledOnce());
    expect(invoke).toHaveBeenCalledWith("coding_changeset_capture_baseline", expect.objectContaining({root: "/saved", taskId: "saved-task"}));
    const saveIndex = post.mock.calls.findIndex(([data]) => (data as {type: string}).type === "echo/save-all");
    const baselineIndex = invoke.mock.calls.findIndex(([command]) => command === "coding_changeset_capture_baseline");
    expect(post.mock.invocationCallOrder[saveIndex]).toBeLessThan(invoke.mock.invocationCallOrder[baselineIndex]);
  });
  it("records an already-created A task failure in A after switching to B", async () => {
    const task = verificationTask({id: "created-a", phase: "idle"}); installApi(task);
    const ordinary = invoke.getMockImplementation()!; let resolveCreated!: (value: unknown) => void;
    const created = new Promise(resolve => {resolveCreated = resolve;});
    invoke.mockImplementation(async (command, args) => command === "coding_task_create" ? created : ordinary(command, args));
    const onStartRun = vi.fn(); const props = {apiReady: true, models: [{id: "model"}], defaultModelId: "model", onStartRun};
    const view = render(<CodingWorkbench cwd="/a" {...props} />);
    readyEditor(await screen.findByTitle("Echo Code IDE") as HTMLIFrameElement);
    fireEvent.change(screen.getByRole("textbox", {name: "任务描述"}), {target: {value: "A only"}});
    await userEvent.click(screen.getByRole("button", {name: "开始 Agent 任务"}));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("coding_task_create", expect.objectContaining({root: "/a"})));
    view.rerender(<CodingWorkbench cwd="/b" {...props} />);
    await act(async () => {resolveCreated(task); await created;});
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("coding_task_report_start_failed", expect.objectContaining({root: "/a", taskId: "created-a"})));
    expect(useTaskStore.getState().root).toBe("/b"); expect(useTaskStore.getState().task).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("coding_task_set_context", expect.anything()); expect(onStartRun).not.toHaveBeenCalled();
  });

  it("does not resume an interrupted task when saving the current buffer fails", async () => {
    const task = verificationTask({id: "paused", phase: "paused", sessionId: "bound"}); installApi(task);
    useTaskStore.setState({root: "/repo", task}); const onSendMessage = vi.fn();
    render(<CodingWorkbench cwd="/repo" sessionId="bound" onSendMessage={onSendMessage} />);
    readyEditor(await screen.findByTitle("Echo Code IDE") as HTMLIFrameElement, 1, true);
    await userEvent.click(screen.getByRole("button", {name: "继续执行"}));
    await userEvent.click(await screen.findByRole("button", {name: "保存并继续"}));
    await waitFor(() => expect(screen.getByRole("button", {name: "继续执行"})).not.toBeDisabled());
    expect(invoke).not.toHaveBeenCalledWith("coding_task_resume", expect.anything()); expect(onSendMessage).not.toHaveBeenCalled();
  });

  it("does not dispatch a late resume after selecting another task in the same workspace", async () => {
    const original = verificationTask({id:"original",phase:"paused",sessionId:"bound"}); installApi(original);
    const ordinary = invoke.getMockImplementation()!;
    let complete!: (value: unknown) => void;
    invoke.mockImplementation(async (command,args) => command === "coding_task_resume" ? new Promise(resolve => {complete=resolve;}) : ordinary(command,args));
    useTaskStore.setState({root:"/repo",task:original});
    const onSendMessage = vi.fn();
    const view = render(<CodingWorkbench cwd="/repo" sessionId="bound" onSendMessage={onSendMessage} />);
    readyEditor(await screen.findByTitle("Echo Code IDE") as HTMLIFrameElement);
    await userEvent.click(screen.getByRole("button",{name:"继续执行"}));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("coding_task_resume",{root:"/repo",taskId:"original"}));
    act(() => useTaskStore.setState({task:verificationTask({id:"other",phase:"paused",sessionId:"other-bound"})}));
    view.rerender(<CodingWorkbench cwd="/repo" sessionId="other-bound" onSendMessage={onSendMessage} />);
    await act(async () => {complete({...original,phase:"implementing"});});
    expect(onSendMessage).not.toHaveBeenCalled();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("coding_task_report_interrupted",{root:"/repo",taskId:"original",interruption:"paused"}));
  });

});
