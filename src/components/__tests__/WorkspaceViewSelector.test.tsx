import { useState } from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { ViewSelector, defaultViews } from "../workspace-panel/ViewSelector";
import type { WorkspaceView } from "@/lib/use-unified-tabs";

it("exposes five text categories, keyboard selection and remembers the task subview", () => {
  function Fixture() {
    const [view,setView] = useState<WorkspaceView>("artifacts");
    const props={view,views:defaultViews({hasChanges:false}),onChange:setView};
    return <><ViewSelector {...props}/><ViewSelector {...props} secondary/></>;
  }
  render(<Fixture/>);
  const categories=screen.getByRole("tablist",{name:"工作区分类"});
  expect(within(categories).getAllByRole("tab").map(item=>item.textContent)).toEqual(["成果","文件","变更","任务","网页"]);
  fireEvent.keyDown(within(categories).getByRole("tab",{name:"成果"}),{key:"ArrowRight"});
  expect(within(categories).getByRole("tab",{name:"文件"})).toHaveAttribute("aria-selected","true");
  fireEvent.click(screen.getByRole("tab",{name:"任务"}));
  fireEvent.click(screen.getByRole("tab",{name:"团队"}));
  expect(screen.getByRole("tab",{name:"团队"})).toHaveAttribute("aria-selected","true");
  fireEvent.click(screen.getByRole("tab",{name:"网页"}));
  expect(screen.queryByRole("tablist",{name:"任务视图"})).toBeNull();
  fireEvent.click(screen.getByRole("tab",{name:"任务"}));
  expect(screen.getByRole("tab",{name:"团队"})).toHaveAttribute("aria-selected","true");
});
