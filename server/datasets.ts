import Papa from 'papaparse';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { randomUUID } from 'node:crypto';
import type { Dataset } from '../src/core/types';
import { ApiError } from './store';
export function normalizeRows(
  value: unknown,
  name: string,
  source: Dataset['source'] = 'file',
): Dataset {
  if (!Array.isArray(value) || !value.length)
    throw new ApiError(400, '하나 이상의 행이 있는 배열이 필요합니다.');
  if (value.length > 50000) throw new ApiError(413, '데이터는 최대 50,000행까지 지원합니다.');
  const objects = value.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row))
      throw new ApiError(400, '각 데이터 행은 객체여야 합니다.');
    return row as Record<string, unknown>;
  });
  const columns = [...new Set(objects.flatMap(Object.keys))];
  if (columns.length > 100) throw new ApiError(413, '최대 100개 열까지 지원합니다.');
  if (columns.some((c) => ['__proto__', 'prototype', 'constructor'].includes(c)))
    throw new ApiError(400, '사용할 수 없는 열 이름입니다.');
  const rows = objects.map((row) =>
    Object.fromEntries(
      columns.map((key) => {
        const v = row[key];
        return [
          key,
          v == null
            ? null
            : typeof v === 'number' && Number.isFinite(v)
              ? v
              : typeof v === 'string'
                ? v
                : JSON.stringify(v),
        ];
      }),
    ),
  ) as Dataset['rows'];
  return { id: randomUUID(), name, columns, rows, source, updatedAt: new Date().toISOString() };
}
export interface DatasetImportOptions {
  sheet?: string;
  range?: string;
}
export const workbookLimits = {
  maxRows: 50000,
  maxColumns: 100,
  previewRows: 8,
  previewColumns: 8,
};
function columnNumber(letters: string) {
  let result = 0;
  for (const c of letters) result = result * 26 + c.charCodeAt(0) - 64;
  return result;
}
function columnLetters(value: number) {
  let result = '';
  while (value > 0) {
    value--;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}
export function parseRange(range: string) {
  const match = range
    .trim()
    .toUpperCase()
    .match(/^\$?([A-Z]{1,3})\$?([1-9]\d{0,6})(?::\$?([A-Z]{1,3})\$?([1-9]\d{0,6}))?$/);
  if (!match)
    throw new ApiError(400, '범위는 A1:F10000처럼 입력하세요. 시트명은 별도 항목에서 선택합니다.');
  const startCol = columnNumber(match[1]),
    startRow = Number(match[2]),
    endCol = columnNumber(match[3] ?? match[1]),
    endRow = Number(match[4] ?? match[2]);
  if (startCol > endCol || startRow > endRow || endCol > 16384 || endRow > 1048576)
    throw new ApiError(400, '엑셀 범위의 시작·끝 또는 행·열 한도가 올바르지 않습니다.');
  return { startCol, startRow, endCol, endRow };
}
async function readWorkbook(buffer: Buffer) {
  if (buffer.length > 25 * 1024 * 1024) throw new ApiError(413, '데이터 파일은 최대 25MB입니다.');
  try {
    const archive = await JSZip.loadAsync(buffer);
    const entries = Object.values(archive.files);
    if (entries.length > 10000 || !archive.file('xl/workbook.xml'))
      throw new ApiError(400, '정상적인 XLSX 통합문서가 아닙니다.');
    let expanded = 0;
    for (const entry of entries) {
      expanded +=
        (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ??
        0;
      if (expanded > 200 * 1024 * 1024)
        throw new ApiError(413, '통합문서 압축 해제 크기가 200MB를 넘습니다.');
    }
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    if (!book.worksheets.length) throw new ApiError(400, '워크시트가 없습니다.');
    if (book.worksheets.length > 200)
      throw new ApiError(413, '한 통합문서는 최대 200개 시트까지 지원합니다.');
    return book;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      400,
      'XLSX 통합문서를 읽지 못했습니다. 파일 손상 또는 암호 설정을 확인하세요.',
    );
  }
}
function cellValue(cell: ExcelJS.Cell): string | number | null {
  let raw = cell.value;
  if (raw && typeof raw === 'object' && 'formula' in raw) raw = raw.result ?? null;
  if (raw && typeof raw === 'object' && 'sharedFormula' in raw) raw = raw.result ?? null;
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) return raw.toISOString();
  if (typeof raw === 'number') {
    const format = cell.numFmt?.split(';')[0];
    if (Number.isInteger(raw) && raw >= 0 && /^0{2,30}$/.test(format ?? ''))
      return String(raw).padStart(format.length, '0');
    return Number.isFinite(raw) ? raw : null;
  }
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'boolean') return String(raw);
  if ('richText' in raw) return raw.richText.map((part) => part.text).join('');
  if ('text' in raw) return raw.text;
  if ('error' in raw) return String(raw.error);
  return cell.text || null;
}
export async function inspectDataset(buffer: Buffer, name: string) {
  if (!name.toLowerCase().endsWith('.xlsx'))
    throw new ApiError(400, '시트 검사는 XLSX 통합문서만 지원합니다.');
  const book = await readWorkbook(buffer);
  const warnings = [
    '선택 범위의 첫 행을 열 이름으로 사용합니다. 계산식은 파일에 저장된 결과만 읽으며 다시 계산하지 않습니다.',
  ];
  const sheets = book.worksheets.map((sheet, index) => {
    const lastRow = Math.max(1, sheet.rowCount),
      lastCol = Math.max(1, sheet.columnCount),
      rows = Math.min(lastRow, workbookLimits.previewRows),
      columns = Math.min(lastCol, workbookLimits.previewColumns);
    if (lastRow > workbookLimits.maxRows + 1 || lastCol > workbookLimits.maxColumns)
      warnings.push(
        `“${sheet.name}”은 가져오기 한도보다 큽니다. 50,001행(머리글 포함)·100열 이내의 범위를 선택하세요.`,
      );
    return {
      name: sheet.name,
      index,
      rowCount: sheet.rowCount,
      columnCount: sheet.columnCount,
      defaultRange: `A1:${columnLetters(lastCol)}${lastRow}`,
      preview: Array.from({ length: rows }, (_, r) =>
        Array.from({ length: columns }, (_, c) =>
          String(cellValue(sheet.getCell(r + 1, c + 1)) ?? '').slice(0, 200),
        ),
      ),
      previewRowNumbers: Array.from({ length: rows }, (_, r) => r + 1),
      previewColumnLetters: Array.from({ length: columns }, (_, c) => columnLetters(c + 1)),
      hidden: sheet.state === 'hidden' || sheet.state === 'veryHidden',
    };
  });
  return { format: 'xlsx' as const, fileName: name, sheets, limits: workbookLimits, warnings };
}
export async function importDataset(
  buffer: Buffer,
  name: string,
  options: DatasetImportOptions = {},
) {
  const ext = name.toLowerCase().split('.').pop();
  if (ext !== 'xlsx' && (options.sheet || options.range))
    throw new ApiError(400, '시트와 셀 범위 선택은 XLSX 파일에서만 사용할 수 있습니다.');
  if (ext === 'json') {
    let data: unknown;
    try {
      data = JSON.parse(buffer.toString('utf8'));
    } catch {
      throw new ApiError(400, 'JSON 파일을 읽을 수 없습니다.');
    }
    return normalizeRows(data, name);
  }
  if (ext === 'csv') {
    const result = Papa.parse<Record<string, unknown>>(
      buffer.toString('utf8').replace(/^\uFEFF/, ''),
      {
        header: true,
        dynamicTyping: false,
        transform: (value) => {
          if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) || value.replace(/[-.]/g, '').length > 15)
            return value;
          const n = Number(value);
          return Number.isFinite(n) ? n : value;
        },
        skipEmptyLines: 'greedy',
      },
    );
    if (result.errors.length)
      throw new ApiError(
        400,
        'CSV 행 또는 따옴표 형식이 잘못되었습니다.',
        result.errors.slice(0, 3).map((e) => ({ row: e.row, message: e.message })),
      );
    return normalizeRows(result.data, name);
  }
  if (ext === 'xlsx') {
    const book = await readWorkbook(buffer);
    const sheet = options.sheet ? book.getWorksheet(options.sheet) : book.worksheets[0];
    if (!sheet) throw new ApiError(400, '선택한 워크시트가 없습니다.');
    const bounds = options.range
      ? parseRange(options.range)
      : { startRow: 1, startCol: 1, endRow: sheet.rowCount, endCol: sheet.columnCount };
    const { startRow, startCol } = bounds;
    const endRow = Math.min(bounds.endRow, sheet.rowCount);
    const endCol = bounds.endCol;
    const columns = endCol - startCol + 1;
    if (bounds.endRow - startRow > workbookLimits.maxRows || columns > workbookLimits.maxColumns)
      throw new ApiError(413, '선택 범위는 최대 50,000개 데이터 행·100열까지 지원합니다.');
    if (startRow >= endRow || startCol > sheet.columnCount || columns < 1)
      throw new ApiError(400, '선택한 범위에 머리글과 데이터 행이 함께 있어야 합니다.');
    const headers = Array.from(
      { length: columns },
      (_, i) =>
        String(cellValue(sheet.getCell(startRow, startCol + i)) ?? '').trim() ||
        `열 ${columnLetters(startCol + i)}`,
    );
    if (new Set(headers).size !== headers.length)
      throw new ApiError(400, `선택 범위 첫 행(${startRow}행)의 열 이름은 고유해야 합니다.`);
    const rows: Record<string, unknown>[] = [];
    for (let n = startRow + 1; n <= endRow; n++) {
      const row = sheet.getRow(n);
      if (!row.hasValues) continue;
      const values = headers.map((_, i) => cellValue(row.getCell(startCol + i)));
      if (values.every((v) => v === null || v === '')) continue;
      rows.push(Object.fromEntries(headers.map((key, i) => [key, values[i]])));
    }
    return normalizeRows(rows, name);
  }
  throw new ApiError(400, 'CSV, XLSX, JSON 파일만 가져올 수 있습니다.');
}
export function selectResponse(data: unknown, responsePath?: string) {
  if (!responsePath) return data;
  if (!/^[a-zA-Z0-9_.-]{1,200}$/.test(responsePath))
    throw new ApiError(400, '응답 경로는 점으로 구분된 속성명이어야 합니다.');
  return responsePath.split('.').reduce<unknown>((value, key) => {
    if (['__proto__', 'prototype', 'constructor'].includes(key))
      throw new ApiError(400, '허용되지 않는 응답 경로입니다.');
    return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
  }, data);
}
