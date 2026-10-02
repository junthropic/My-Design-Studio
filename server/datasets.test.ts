import { afterEach, describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { importDataset, inspectDataset, parseRange } from './datasets';
import { createServer } from './index';
import { createProject } from '../src/core/templates';
let running: Awaited<ReturnType<typeof createServer>> | undefined;
let dir = '';
afterEach(async () => {
  await running?.close();
  running = undefined;
  const rel = path.relative(tmpdir(), dir);
  if (rel.startsWith('studio-xlsx-test-') && !rel.includes(path.sep))
    rmSync(dir, { recursive: true, force: true });
});
async function workbook() {
  const book = new ExcelJS.Workbook();
  const first = book.addWorksheet('요약');
  first.addRow(['이름', '값']);
  first.addRow(['첫 시트', 10]);
  const second = book.addWorksheet('대상 데이터');
  second.getCell('A1').value = '메모: 실제 표는 B3에서 시작';
  second.getCell('B3').value = 'ID';
  second.getCell('C3').value = '우편번호';
  second.getCell('D3').value = '금액';
  second.getCell('E3').value = '계산';
  second.getCell('B4').value = '00123';
  second.getCell('C4').value = 42;
  second.getCell('C4').numFmt = '00000';
  second.getCell('D4').value = 12.5;
  second.getCell('E4').value = { formula: 'D4*2', result: 25 };
  second.getCell('B6').value = '9007199254740993123';
  second.getCell('C6').value = '00007';
  second.getCell('D6').value = 3;
  second.getCell('E6').value = { formula: 'D6*2', result: 6 };
  return Buffer.from(await book.xlsx.writeBuffer());
}
describe('Excel sheet and range import', () => {
  it('inspects multiple sheets with bounded previews without saving a project', async () => {
    const info = await inspectDataset(await workbook(), '선택.xlsx');
    expect(info.format).toBe('xlsx');
    expect(info.sheets.map((s) => s.name)).toEqual(['요약', '대상 데이터']);
    expect(info.sheets[1]).toMatchObject({
      index: 1,
      rowCount: 6,
      columnCount: 5,
      defaultRange: 'A1:E6',
    });
    expect(info.sheets[1].preview[2][1]).toBe('ID');
    expect(info.sheets[1].preview[3][2]).toBe('00042');
    expect(
      info.sheets.every((s) => s.preview.length <= 8 && s.preview.every((row) => row.length <= 8)),
    ).toBe(true);
  });
  it('selects the second sheet and range while preserving text IDs and zero padding', async () => {
    const buffer = await workbook();
    const original = await importDataset(buffer, '선택.xlsx');
    expect(original.rows).toEqual([{ 이름: '첫 시트', 값: 10 }]);
    const chosen = await importDataset(buffer, '선택.xlsx', {
      sheet: '대상 데이터',
      range: 'B3:E6',
    });
    expect(chosen.columns).toEqual(['ID', '우편번호', '금액', '계산']);
    expect(chosen.rows).toEqual([
      { ID: '00123', 우편번호: '00042', 금액: 12.5, 계산: 25 },
      { ID: '9007199254740993123', 우편번호: '00007', 금액: 3, 계산: 6 },
    ]);
    const subset = await importDataset(buffer, '선택.xlsx', {
      sheet: '대상 데이터',
      range: '$B$3:$D$4',
    });
    expect(subset.rows).toHaveLength(1);
    expect(subset.columns).toEqual(['ID', '우편번호', '금액']);
  });
  it('rejects missing sheets, malformed/reversed ranges and oversized selections', async () => {
    const buffer = await workbook();
    await expect(importDataset(buffer, '선택.xlsx', { sheet: '없는 시트' })).rejects.toThrow(
      '워크시트',
    );
    expect(() => parseRange('B5:A1')).toThrow('시작');
    expect(() => parseRange('A0:F5')).toThrow('범위');
    expect(() => parseRange('Sheet1!A1:B2')).toThrow('별도');
    await expect(
      importDataset(buffer, '선택.xlsx', { sheet: '대상 데이터', range: 'A1:ZZ2' }),
    ).rejects.toThrow('100열');
    await expect(
      importDataset(buffer, '선택.xlsx', { sheet: '대상 데이터', range: 'B3:E50004' }),
    ).rejects.toThrow('50,000');
    await expect(
      importDataset(Buffer.from('a,b\n1,2'), 'x.csv', { sheet: 'ignored' }),
    ).rejects.toThrow('XLSX');
  });
  it('supports the multipart inspect and import routes with Korean sheet names', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'studio-xlsx-test-'));
    running = await createServer({ port: 0, dataDir: dir });
    const project = running.store.create(createProject());
    const buffer = await workbook();
    const inspectForm = new FormData();
    inspectForm.append('file', new Blob([buffer]), '선택.xlsx');
    const inspected = await fetch(running.url + '/api/datasets/inspect', {
      method: 'POST',
      headers: { 'x-studio-request': '1' },
      body: inspectForm,
    });
    expect(inspected.status).toBe(200);
    expect((await inspected.json()).sheets).toHaveLength(2);
    expect(running.store.project(project.id).revision).toBe(1);
    const importForm = new FormData();
    importForm.append('file', new Blob([buffer]), '선택.xlsx');
    importForm.append('sheet', '대상 데이터');
    importForm.append('range', 'B3:D4');
    const imported = await fetch(running.url + `/api/projects/${project.id}/datasets`, {
      method: 'POST',
      headers: { 'x-studio-request': '1' },
      body: importForm,
    });
    expect(imported.status).toBe(201);
    const result = await imported.json();
    expect(result.dataset.rows).toEqual([{ ID: '00123', 우편번호: '00042', 금액: 12.5 }]);
    expect(result.project.revision).toBe(2);
  });
});
