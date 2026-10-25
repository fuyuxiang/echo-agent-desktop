import assert from "node:assert/strict";
import { join } from "node:path";

// Uses the production MessageItem and CSS in the existing IPC fixture. This
// verifies the decision and navigation UI, not native document generation.
export async function validateOfficeExportMenu(page, output, { width, height, theme }) {
  const commonText = "公式和 Mermaid 图表以原始文本保留。图表可从图表菜单下载 SVG。";
  const excelText = "Excel：回复含表格时，仅导出表格。";
  const trigger = page.getByRole("button", { name: "更多回复操作" }).last();
  const focused = (item) => item.evaluate((element) => document.activeElement === element);
  let layouts = 0;
  for (const enlarged of [false, true]) {
    if (enlarged) {
      await page.evaluate(() => { document.documentElement.style.fontSize = "22px"; });
    }
    await trigger.focus();
    await page.keyboard.press("ArrowDown");
    await page.getByRole("menuitem", { name: "导出本条回复为办公文件" }).click();
    const menu = page.getByRole("menu", { name: "选择导出格式" });
    await menu.waitFor();
    const common = page.getByText(commonText, { exact: true });
    const excel = page.getByText(excelText, { exact: true });
    assert.ok(await common.isVisible(), "Office export must explain formula/diagram content before selection");
    assert.ok(await excel.isVisible(), "Office export must explain the spreadsheet table scope before selection");
    const items = menu.getByRole("menuitem");
    assert.deepEqual(await items.allTextContents(), ["Word", "PDF", "Excel", "PPT"]);
    for (const label of ["Word", "PDF", "Excel", "PPT"]) {
      const item = menu.getByRole("menuitem", { name: label, exact: true });
      assert.ok(await item.isEnabled(), `${label}: existing export entry must stay available`);
      const description = await item.evaluate((element) => (
        (element.getAttribute("aria-describedby") ?? "").split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? "").join(" ")
      ));
      assert.ok(description.includes(commonText), `${label}: missing accessible export scope`);
      if (label === "Excel") assert.ok(description.includes(excelText), "Excel: missing accessible table scope");
    }
    const geometry = await page.locator(".msg__export-menu").evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
        scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
        notes: [...element.querySelectorAll(".msg__export-note")].map((note) => {
          const box = note.getBoundingClientRect();
          return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, tabIndex: note.tabIndex };
        }),
      };
    });
    const label = `Office export ${width} ${theme} ${enlarged ? "large font" : "normal font"}`;
    assert.ok(geometry.left >= 0 && geometry.right <= width && geometry.top >= 0 && geometry.bottom <= height, `${label}: menu clips at viewport edge`);
    assert.ok(geometry.scrollWidth <= geometry.clientWidth + 1, `${label}: menu scrolls horizontally`);
    assert.ok(geometry.notes.length === 2 && geometry.notes.every((note) => (
      note.left >= geometry.left && note.right <= geometry.right
      && note.top >= geometry.top && note.bottom <= geometry.bottom && note.tabIndex === -1
    )), `${label}: decision notes clip or add a focus target`);
    const word = menu.getByRole("menuitem", { name: "Word", exact: true });
    const ppt = menu.getByRole("menuitem", { name: "PPT", exact: true });
    assert.ok(await focused(word), `${label}: keyboard opening should focus Word`);
    await page.keyboard.press("End");
    assert.ok(await focused(ppt), `${label}: End should focus PPT`);
    await page.keyboard.press("ArrowDown");
    assert.ok(await focused(word), `${label}: ArrowDown should wrap to Word`);
    await page.keyboard.press("ArrowUp");
    assert.ok(await focused(ppt), `${label}: ArrowUp should wrap to PPT`);
    await page.keyboard.press("Home");
    assert.ok(await focused(word), `${label}: Home should focus Word`);
    await page.screenshot({ path: join(output, `office-export-${width}-${theme}${enlarged ? "-large-font" : ""}.png`) });
    layouts += 1;
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "hidden" });
    assert.ok(await focused(trigger), `${label}: Escape should restore trigger focus`);
    await page.keyboard.press("ArrowDown");
    await page.getByRole("menuitem", { name: "导出本条回复为办公文件" }).click();
    await menu.waitFor();
    await page.keyboard.press("End");
    await page.keyboard.press("Tab");
    await menu.waitFor({ state: "hidden" });
    assert.ok(await page.evaluate(() => !document.activeElement?.closest(".msg__export-menu")), `${label}: Tab must leave the menu without a focus trap`);
  }
  return layouts;
}
