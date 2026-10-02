import { it, expect } from 'vitest';
import { chromium, expect as browserExpect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from '../server/index';

it('project menu manages persisted copies/deletion and both app themes cover all nine pages independently', async () => {
  const root = path.resolve('../../work/workspace-acceptance-' + Date.now());
  await mkdir(root, { recursive: true });
  const server = await createServer({
    dataDir: root,
    port: 0,
    staticDir: path.resolve(process.env.DESIGN_STUDIO_TEST_STATIC_DIR || 'dist'),
  });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors: string[] = [],
    audits: any[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const nav = (name: string) =>
    page.getByRole('navigation').getByRole('button', { name, exact: true });
  const menu = () => page.getByRole('button', { name: '프로젝트 선택', exact: true }).click();
  try {
    await page.goto(server.url);
    await nav('홈').waitFor();
    const original = server.store.projects()[0];
    await nav('디자인 시스템').click();
    await page.getByRole('textbox', { name: '브랜드명', exact: true }).fill('저장 전 복제 내용');
    await menu();
    await page.getByRole('button', { name: original.name + ' 복제', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('프로젝트 이름').fill('내 복제 프로젝트');
    await dialog.getByRole('button', { name: '프로젝트 복제', exact: true }).click();
    await browserExpect(dialog).toHaveCount(0);
    let copy = server.store.projects().find((p) => p.name === '내 복제 프로젝트')!;
    expect(copy.brand.name).toBe('저장 전 복제 내용');
    expect(copy.slides).toEqual(server.store.project(original.id).slides);
    await menu();
    await page.getByRole('button', { name: '내 복제 프로젝트 이름 변경', exact: true }).click();
    await dialog.getByLabel('프로젝트 이름').fill('독립 프로젝트');
    await dialog.getByRole('button', { name: '프로젝트 이름 변경', exact: true }).click();
    await browserExpect(dialog).toHaveCount(0);
    await menu();
    await page.getByRole('button', { name: original.name + ' 삭제', exact: true }).click();
    await dialog.getByRole('button', { name: '취소', exact: true }).click();
    expect(server.store.projects()).toHaveLength(2);
    await menu();
    await page.getByRole('button', { name: original.name + ' 삭제', exact: true }).click();
    await dialog.getByRole('button', { name: '프로젝트 삭제', exact: true }).click();
    await browserExpect(dialog).toHaveCount(0);
    expect(server.store.projects()).toHaveLength(1);
    copy = server.store.project(copy.id);
    await page.getByRole('button', { name: '앱 라이트 모드', exact: true }).click();
    await browserExpect(page.locator('html')).toHaveAttribute('data-app-theme', 'light');
    await browserExpect(
      page.getByRole('button', { name: '앱 라이트 모드', exact: true }),
    ).toBeEnabled();
    expect(server.store.project(copy.id)).toEqual(copy);
    await page.reload();
    await nav('홈').waitFor();
    await browserExpect(page.locator('html')).toHaveAttribute('data-app-theme', 'light');
    for (const theme of ['light', 'dark']) {
      await page
        .getByRole('button', {
          name: theme === 'light' ? '앱 라이트 모드' : '앱 다크 모드',
          exact: true,
        })
        .click();
      await browserExpect(
        page.getByRole('button', {
          name: theme === 'light' ? '앱 라이트 모드' : '앱 다크 모드',
          exact: true,
        }),
      ).toBeEnabled();
      await browserExpect(page.locator('html')).toHaveAttribute('data-app-theme', theme);
      // Contrast audits measure settled colors, not a button's in-flight hover/theme transition.
      await page.waitForFunction(
        () => !document.getAnimations().some((a) => a instanceof CSSTransition),
      );
      for (const name of [
        '홈',
        '디자인 갤러리',
        '디자인 시스템',
        'PowerPoint',
        '웹사이트',
        '모션그래픽',
        '자산·데이터',
        '검사·내보내기',
        '연결·설정',
      ]) {
        await nav(name).click();
        if (name === '모션그래픽')
          await page.getByRole('heading', { name: '모션 스튜디오' }).waitFor();
        const report = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze();
        audits.push({
          theme,
          page: name,
          violations: report.violations
            .filter((v) => ['critical', 'serious'].includes(v.impact || ''))
            .map((v) => ({
              id: v.id,
              nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
            })),
        });
        if (name === '홈' || name === '모션그래픽')
          await page.screenshot({ path: path.join(root, `${theme}-${name}.png`), fullPage: true });
      }
    }
    await nav('디자인 갤러리').click();
    await writeFile(path.join(root, 'audit.json'), JSON.stringify({ errors, audits }, null, 2));
    const previewColors = () =>
      page
        .locator('.mini-preview')
        .first()
        .evaluate((root) =>
          [root, ...root.querySelectorAll('*')].map((el) => {
            const style = getComputedStyle(el);
            return {
              color: style.color,
              background: style.backgroundColor,
              image: style.backgroundImage,
            };
          }),
        );
    const previewBefore = await previewColors();
    await page.getByRole('button', { name: '앱 라이트 모드', exact: true }).click();
    await browserExpect(page.locator('html')).toHaveAttribute('data-app-theme', 'light');
    expect(await previewColors()).toEqual(previewBefore);
    expect(server.store.project(copy.id)).toEqual(copy);
    await page
      .getByRole('button', {
        name: copy.mode === 'dark' ? '라이트 모드' : '다크 모드',
        exact: true,
      })
      .click();
    await browserExpect(page.locator('html')).toHaveAttribute('data-app-theme', 'light');
    await page.setViewportSize({ width: 1024, height: 768 });
    await nav('홈').click();
    await menu();
    await page.screenshot({ path: path.join(root, 'light-project-menu.png'), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole('button', { name: '독립 프로젝트 삭제', exact: true }).click();
    await dialog.getByRole('button', { name: '프로젝트 삭제', exact: true }).click();
    await browserExpect(dialog).toHaveCount(0);
    expect(server.store.projects()).toHaveLength(1);
    expect(server.store.projects()[0].id).not.toBe(copy.id);
    await page.reload();
    await nav('홈').waitFor();
    expect(server.store.projects()).toHaveLength(1);
    await writeFile(path.join(root, 'audit.json'), JSON.stringify({ errors, audits }, null, 2));
    expect(errors).toEqual([]);
    expect(audits.filter((a) => a.violations.length)).toEqual([]);
  } finally {
    await browser.close();
    await server.close();
  }
}, 180000);
