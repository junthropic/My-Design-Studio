import { it, expect } from 'vitest';
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from '../server/index';

it('app editing, isolated modes, persistence, responsive web and accessibility', async () => {
  const root = path.resolve('../../work/ui-acceptance-' + Date.now());
  await mkdir(root, { recursive: true });
  const server = await createServer({ dataDir: root, port: 0, staticDir: path.resolve('dist') });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors: string[] = [],
    audits: any[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const nav = (name: string) =>
    page.getByRole('navigation').getByRole('button', { name, exact: true });
  try {
    await page.goto(server.url);
    await nav('디자인 갤러리').waitFor();
    await page.evaluate(() => document.fonts.ready);
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
      const report = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze();
      audits.push({
        page: name,
        violations: report.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          description: v.description,
          nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
        })),
      });
    }
    await nav('디자인 시스템').click();
    await page.getByRole('textbox', { name: '브랜드명', exact: true }).fill('회귀 검증 스튜디오');
    await page.getByRole('spinbutton', { name: '본문 크기', exact: true }).fill('18');
    await page.getByRole('button', { name: '라이트 모드', exact: true }).click();
    await page.getByRole('spinbutton', { name: '본문 크기', exact: true }).fill('20');
    await page.getByRole('button', { name: '다크 모드', exact: true }).click();
    expect(
      await page.getByRole('spinbutton', { name: '본문 크기', exact: true }).inputValue(),
    ).toBe('18');
    await page.getByTitle('저장하기').click();
    await page.getByRole('button', { name: '로컬에 저장됨', exact: true }).waitFor();
    await page.reload();
    await nav('디자인 시스템').click();
    expect(await page.getByRole('textbox', { name: '브랜드명', exact: true }).inputValue()).toBe(
      '회귀 검증 스튜디오',
    );
    expect(
      await page.getByRole('spinbutton', { name: '본문 크기', exact: true }).inputValue(),
    ).toBe('18');
    await nav('웹사이트').click();
    for (const width of [390, 768, 1280, 1440]) {
      await page.getByRole('button', { name: String(width), exact: true }).click();
      const frame = await page.locator('iframe').elementHandle();
      const content = await frame!.contentFrame();
      await content!.waitForLoadState();
      // A completed iframe load does not mean React's new viewport size has committed.
      await content!.waitForFunction((expected) => innerWidth === expected, width);
      const dimensions = await content!.evaluate(() => ({
        width: innerWidth,
        scroll: document.documentElement.scrollWidth,
      }));
      expect(dimensions.width).toBe(width);
      expect(dimensions.scroll).toBeLessThanOrEqual(width);
    }
    await nav('모션그래픽').click();
    await page.getByRole('button', { name: '한 프레임 앞으로', exact: true }).click();
    await page.getByRole('slider', { name: '전체 타임라인 프레임', exact: true }).fill('45');
    expect(
      await page.getByRole('slider', { name: '전체 타임라인 프레임', exact: true }).inputValue(),
    ).toBe('45');
    await nav('디자인 갤러리').click();
    await page.screenshot({ path: path.join(root, 'gallery.png'), fullPage: true });
    await writeFile(path.join(root, 'audit.json'), JSON.stringify({ errors, audits }, null, 2));
    expect(errors).toEqual([]);
    expect(
      audits
        .flatMap((a) =>
          a.violations.filter((v: any) => v.impact === 'critical' || v.impact === 'serious'),
        )
        .map((v) => ({ id: v.id, nodes: v.nodes })),
    ).toEqual([]);
  } finally {
    await browser.close();
    await server.close();
  }
}, 120000);
