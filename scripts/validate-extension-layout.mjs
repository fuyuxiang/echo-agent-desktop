import assert from 'node:assert/strict';
import { join } from 'node:path';

const pages = [
  { route: '专家·技能·连接器', name: 'experts', title: '我的专家', search: '搜索专家', row: '.colleague-card-profile-main', primary: '创建专家' },
  { route: '技能', name: 'skills', title: '已安装技能', search: '搜索已安装技能', row: '.sk-inst-row', primary: '添加技能' },
  { route: '连接器', name: 'connectors', title: '已配置连接器', search: '搜索连接器', row: '.mcp-item-wrap', primary: '配置连接器' },
  { route: '插件', name: 'plugins', title: '已安装插件', search: '搜索插件', row: '.plugins-panel__item' },
];

/** Production React/CSS with isolated IPC: alignment, scaling, scrolling and real controls. */
export async function validateExtensionLayouts(page, output) {
  let layouts = 0;
  const open = async (spec, state, theme = 'light', shell = false) => {
    const query = new URLSearchParams({ surface: 'capabilities', label: spec.route, theme, extensionState: state });
    if (shell) query.set('extensionShell', '1');
    await page.goto(`http://127.0.0.1:1439/__ui-review?${query}`);
    await page.getByRole('heading', { name: spec.title, exact: true }).waitFor();
    if (state === 'error') await page.getByRole('alert').waitFor();
    else if (state !== 'empty') await page.locator(spec.row).first().waitFor();
    else await page.locator('.capability-empty').waitFor();
  };
  const inspect = async (label) => {
    const geometry = await page.locator('.capability-page').evaluate(root => {
      const header = root.querySelector('.capability-page__header');
      const heading = header.querySelector('h2');
      const rect = root.getBoundingClientRect();
      const title = heading.getBoundingClientRect();
      const controls = [...header.querySelectorAll('input, button')].map(element => {
        const box = element.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, height: box.height };
      });
      return { titleTop: title.top, titleLeft: title.left, titleSize: getComputedStyle(heading).fontSize,
        left: rect.left, right: rect.right, overflow: root.scrollWidth > root.clientWidth + 1,
        documentOverflow: document.documentElement.scrollWidth > innerWidth + 1, controls };
    });
    assert(!geometry.overflow && !geometry.documentOverflow, `${label}: horizontal overflow`);
    assert(geometry.controls.every(control => control.left >= geometry.left && control.right <= geometry.right + 1), `${label}: toolbar clips`);
    const inputs = page.locator('.capability-page__header input');
    if (await inputs.count()) {
      const before = await inputs.first().boundingBox();
      await inputs.first().focus();
      const after = await inputs.first().boundingBox();
      assert(Math.abs(before.width - after.width) < 1, `${label}: focusing search shifts the toolbar`);
    }
    layouts += 1;
    return geometry;
  };

  for (const [width, height, shell] of [[1440, 900, true], [1024, 680, true], [768, 720, false]]) {
    await page.setViewportSize({ width, height });
    for (const theme of ['light', 'dark']) {
      let baseline;
      let primaryColor;
      for (const spec of pages) {
        await open(spec, 'populated', theme, shell);
        const geometry = await inspect(`${spec.name} ${width} ${theme}`);
        if (!baseline) baseline = geometry;
        else {
          assert(Math.abs(geometry.titleTop - baseline.titleTop) < 1, 'Extension titles have different top offsets');
          assert(Math.abs(geometry.titleLeft - baseline.titleLeft) < 1, 'Extension titles have different left offsets');
          assert.equal(geometry.titleSize, baseline.titleSize, 'Extension title typography differs');
        }
        const heights = geometry.controls.map(control => control.height);
        assert(Math.max(...heights) - Math.min(...heights) <= 1, 'Search and buttons have different heights');
        if (spec.primary) {
          const button = page.getByRole('button', { name: spec.primary, exact: true });
          const color = await button.evaluate(element => getComputedStyle(element).backgroundColor);
          const brand = await button.evaluate(element => {
            const probe = document.createElement('span');
            probe.style.color = 'var(--echo-brand)';
            element.append(probe);
            const value = getComputedStyle(probe).color;
            probe.remove();
            return value;
          });
          assert.equal(color, brand, 'Primary extension action lost the brand color');
          if (!primaryColor) primaryColor = color;
          else assert.equal(color, primaryColor, 'Primary extension actions use different colors');
        }
        await page.evaluate(() => document.activeElement?.blur());
        await page.mouse.move(0, 0);
        await page.screenshot({ path: join(output, `extensions-${spec.name}-${width}-${theme}.png`) });
        const search = page.getByRole('textbox', { name: spec.search, exact: true });
        await search.fill('没有这项能力');
        await page.getByText(/没有找到与「没有这项能力」匹配/).waitFor();
        await page.getByRole('button', { name: '清空搜索', exact: true }).click();
        await page.locator(spec.row).first().waitFor();
        assert.equal(await search.inputValue(), '');
      }
    }
  }

  await page.setViewportSize({ width: 1024, height: 680 });
  for (const spec of pages) {
    for (const state of ['empty', 'error', 'long']) {
      await open(spec, state, 'light', true);
      await inspect(`${spec.name} ${state}`);
      if (state === 'error') {
        await page.getByRole('button', { name: '重试', exact: true }).click();
        await page.locator(spec.row).first().waitFor();
        assert.equal(await page.getByRole('alert').count(), 0);
      }
      if (state === 'long') {
        const scroller = page.locator('.capability-page');
        const range = await scroller.evaluate(element => element.scrollHeight - element.clientHeight);
        assert(range > 0, `${spec.name}: long content has no scroll range`);
        await page.locator(spec.row).last().scrollIntoViewIfNeeded();
        assert(await scroller.evaluate(element => element.scrollTop > 0), `${spec.name}: content does not scroll in the page`);
        const extraOwners = await page.evaluate(() => [...document.querySelectorAll('.capability-tab,.capabilities-panel,.capabilities-content,.mcp-list')]
          .filter(element => ['auto', 'scroll'].includes(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight + 1).length);
        assert.equal(extraOwners, 0, `${spec.name}: nested page scrollbars`);
      }
      await page.screenshot({ path: join(output, `extensions-${spec.name}-${state}.png`) });
    }
    await open(spec, 'populated', 'dark', true);
    await page.evaluate(() => { document.documentElement.style.fontSize = '22px'; });
    await inspect(`${spec.name} large font`);
    await page.screenshot({ path: join(output, `extensions-${spec.name}-large-font.png`) });
  }

  await open(pages[1], 'populated');
  await page.locator('.sk-inst-row input[type=checkbox]').first().uncheck();
  assert.equal(await page.locator('.sk-inst-row input[type=checkbox]').first().isChecked(), false);
  await page.getByRole('button', { name: '添加技能', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });

  await open(pages[2], 'populated');
  await page.locator('.mcp-item-main').first().click();
  await page.locator('.mcp-item-details').waitFor();
  await page.getByRole('button', { name: '配置连接器', exact: true }).click();
  await page.getByRole('heading', { name: '配置连接器', exact: true }).waitFor();
  const config = page.getByRole('textbox', { name: 'MCP 配置内容', exact: true });
  await config.fill('{');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '无效的 JSON' }).waitFor();
  await config.fill('{"mcpServers":{"configured":{"command":"review"}}}');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.capability-page__actions button:last-child')?.disabled);
  await page.getByRole('button', { name: '返回连接器列表', exact: true }).click();
  await page.getByRole('heading', { name: pages[2].title, exact: true }).waitFor();

  await open(pages[3], 'populated');
  await page.locator('.plugins-panel__toggle').first().click();
  await page.locator('.plugins-panel__toggle').first().filter({ hasText: '已禁用' }).waitFor();
  return layouts;
}
