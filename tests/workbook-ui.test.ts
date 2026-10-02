import { it, expect } from 'vitest';
import { chromium } from '@playwright/test';
import ExcelJS from 'exceljs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from '../server/index';

it('imports a selected worksheet and range through the actual workbook dialog', async () => {
  const root = path.resolve('../../work/workbook-ui-' + Date.now());
  await mkdir(root, { recursive: true });
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('안내').addRow(['다른 시트를 선택하세요']);
  const sheet = workbook.addWorksheet('실적');
  sheet.addRow(['범위 밖 제목']);
  sheet.addRow([]);
  sheet.addRow(['사번', '매출', '비율']);
  sheet.addRow(['0012', 150000, 0.15]);
  sheet.addRow(['0034', 230000, 0.23]);
  sheet.addRow(['범위 밖 합계', 380000, 0.38]);
  const fixture = path.join(root, '선택 범위.xlsx');
  await workbook.xlsx.writeFile(fixture);
  const server = await createServer({ dataDir: root, port: 0, staticDir: path.resolve('dist') });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  try {
    await page.goto(server.url);
    await page
      .getByRole('navigation')
      .getByRole('button', { name: '자산·데이터', exact: true })
      .click();
    await page.getByRole('button', { name: /데이터 연결/ }).click();
    await page.locator('input[type=file][accept=".csv,.xlsx,.json"]').setInputFiles(fixture);
    const dialog = page.getByRole('dialog', { name: 'Excel 가져오기' });
    await dialog.waitFor();
    expect(await dialog.evaluate((el) => (el as HTMLDialogElement).open)).toBe(true);
    await dialog.getByRole('combobox').selectOption('실적');
    await dialog.getByRole('textbox', { name: '가져올 셀 범위' }).fill('A3:C5');
    await dialog.getByRole('button', { name: '선택 범위 가져오기', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.getByRole('cell', { name: '0012', exact: true }).waitFor();
    expect(await page.getByRole('cell', { name: '0034', exact: true }).count()).toBe(1);
    expect(await page.getByRole('cell', { name: '범위 밖 합계', exact: true }).count()).toBe(0);
    expect(await page.getByRole('cell', { name: '0.15', exact: true }).count()).toBe(1);
    await page.getByRole('combobox', { name: '비율 형식' }).selectOption('percent');
    await page.getByTitle('저장하기').click();
    await page.getByRole('button', { name: '로컬에 저장됨', exact: true }).waitFor();
    const projects = await (await fetch(server.url + '/api/projects')).json();
    const imported = projects[0].datasets.find((d: any) =>
      d.rows.some((r: any) => r['사번'] === '0012'),
    );
    expect(imported.rows).toHaveLength(2);
    expect(imported.formats['비율']).toBe('percent');
    await page.screenshot({ path: path.join(root, 'workbook-import.png'), fullPage: true });
    await writeFile(
      path.join(root, 'report.json'),
      JSON.stringify({ status: 'passed', rows: imported.rows, formats: imported.formats }, null, 2),
    );
  } finally {
    await browser.close();
    await server.close();
  }
}, 60000);
