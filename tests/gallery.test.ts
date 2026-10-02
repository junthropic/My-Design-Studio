import { it, expect } from 'vitest';
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from '../server/index';
import type { Project } from '../src/core/types';

it('갤러리 사용자 스타일·컬렉션과 홈 작업 연결은 실제 프로젝트를 보존한다', async () => {
  const root = path.resolve('../../work/gallery-acceptance-' + Date.now());
  await mkdir(root, { recursive: true });
  const server = await createServer({
    dataDir: root,
    port: 0,
    staticDir: path.resolve(process.env.DESIGN_STUDIO_TEST_STATIC_DIR || 'dist'),
  });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const nav = (name: string) =>
    page.getByRole('navigation').getByRole('button', { name, exact: true });
  const saved = async () => {
    await page.getByTitle('저장하기').click();
    await page.getByRole('button', { name: /^(로컬에 )?저장됨$/ }).waitFor();
    return (await page.evaluate(
      async () =>
        await (await fetch('/api/projects', { headers: { 'x-studio-request': '1' } })).json(),
    )) as Project[];
  };
  try {
    await page.goto(server.url);
    await nav('디자인 갤러리').waitFor();
    const initial = (await saved())[0],
      brand = { ...initial.brand };
    await nav('홈').click();
    await page.getByRole('heading', { name: '다음 작업을 이어가세요.' }).waitFor();
    expect(await page.locator('.home-project-row').count()).toBe(1);
    expect(await page.locator('.home-map-row').count()).toBe(3);
    await page.getByRole('button', { name: '작업 이어가기' }).click();
    await page.locator('iframe').waitFor();
    await nav('디자인 갤러리').click();
    await page.locator('.style-visual').nth(1).click();
    expect((await saved())[0].brand).toEqual(brand);
    await page.getByRole('button', { name: '내 스타일 저장', exact: true }).click();
    await page.getByRole('dialog').getByLabel('스타일 이름', { exact: true }).fill('검증 스타일');
    await page.getByRole('dialog').getByLabel('태그 · 쉼표로 구분').fill('검증용, 웹');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '스타일 저장', exact: true })
      .click();
    let state = (await saved())[0];
    expect(state.brand).toEqual(brand);
    expect(state.customStyles.find((s) => s.name === '검증 스타일')?.tags).toEqual([
      '검증용',
      '웹',
    ]);
    await page.getByRole('button', { name: '컬렉션 만들기', exact: true }).click();
    await page.getByRole('dialog').getByLabel('컬렉션 이름').fill('검증 컬렉션');
    await page.getByRole('dialog').getByRole('button', { name: '저장', exact: true }).click();
    await page.getByRole('combobox', { name: '컬렉션 필터' }).selectOption('');
    await page.getByRole('button', { name: '검증 스타일 컬렉션 지정', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('checkbox', { name: /검증 컬렉션/ })
      .check();
    await page.getByRole('button', { name: '컬렉션 지정 저장', exact: true }).click();
    state = (await saved())[0];
    const collection = state.collections.find((c) => c.name === '검증 컬렉션')!;
    expect(collection.styleIds).toContain(
      state.customStyles.find((s) => s.name === '검증 스타일')!.id,
    );
    await page.getByRole('combobox', { name: '컬렉션 필터' }).selectOption(collection.id);
    expect(await page.locator('.style-card').count()).toBe(1);
    await page.getByRole('button', { name: '컬렉션 이름 변경', exact: true }).click();
    await page.getByRole('dialog').getByLabel('컬렉션 이름').fill('검증 컬렉션 수정');
    await page.getByRole('dialog').getByRole('button', { name: '저장', exact: true }).click();
    await page.getByRole('button', { name: '검증 스타일 이름과 태그 편집', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByLabel('스타일 이름', { exact: true })
      .fill('검증 스타일 수정');
    await page.getByRole('dialog').getByRole('button', { name: '변경 저장', exact: true }).click();
    await page.getByRole('button', { name: '검증 스타일 수정 복제', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByLabel('스타일 이름', { exact: true })
      .fill('검증 스타일 사본');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '스타일 저장', exact: true })
      .click();
    state = (await saved())[0];
    expect(state.customStyles).toHaveLength(2);
    expect(state.brand).toEqual(brand);
    expect(state.collections.find((c) => c.id === collection.id)?.name).toBe('검증 컬렉션 수정');
    expect(state.collections.find((c) => c.id === collection.id)?.styleIds).toHaveLength(2);
    await page.getByRole('textbox', { name: '스타일 검색' }).fill('사본 검증');
    expect(await page.locator('.style-card').count()).toBe(1);
    await page.getByRole('button', { name: '검증 스타일 사본 삭제', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '취소', exact: true }).click();
    expect(await page.locator('.style-card').count()).toBe(1);
    await page.getByRole('button', { name: '검증 스타일 사본 삭제', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '스타일 삭제', exact: true })
      .click();
    state = (await saved())[0];
    expect(state.customStyles).toHaveLength(1);
    expect(state.brand).toEqual(brand);
    expect(state.collections.find((c) => c.id === collection.id)?.styleIds).toHaveLength(1);
    await page.getByRole('button', { name: '필터 초기화', exact: true }).click();
    await page.getByRole('button', { name: '내 스타일', exact: true }).click();
    await page.screenshot({ path: path.join(root, 'gallery-custom.png'), fullPage: true });
    await page.reload();
    await nav('디자인 갤러리').click();
    await page.getByRole('button', { name: '내 스타일', exact: true }).click();
    expect(await page.locator('.style-card').count()).toBe(1);
    await nav('홈').click();
    await page.screenshot({ path: path.join(root, 'home.png'), fullPage: true });
    expect(errors).toEqual([]);
    await writeFile(
      path.join(root, 'report.json'),
      JSON.stringify(
        {
          errors,
          brandPreserved: true,
          customStyles: state.customStyles.length,
          collection: state.collections.find((c) => c.id === collection.id),
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
    await server.close();
  }
}, 90000);
