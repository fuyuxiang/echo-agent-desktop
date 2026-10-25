/** Drive the production text tabs rather than the retired header view menu. */
export async function openWorkspaceView(page, label) {
  const expand = page.getByRole("button", {name:"展开工作区",exact:true});
  if (await expand.count()) await expand.click();
  const target = /团队/.test(label) ? "团队" : /运行|协作/.test(label) ? "运行" : /计划/.test(label) ? "计划"
    : /网页|浏览/.test(label) ? "网页" : /变更/.test(label) ? "变更" : /产物|成果/.test(label) ? "成果" : "文件";
  if (["计划","运行","团队"].includes(target) && !await page.getByRole("tab",{name:target,exact:true}).count()) await page.getByRole("tab",{name:"任务",exact:true}).click();
  await page.getByRole("tab",{name:target,exact:true}).click();
}
