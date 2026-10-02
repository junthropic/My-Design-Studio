import path from 'node:path';
import type { Asset } from '../src/core/types';
import { ApiError } from './store';

const formats: Record<string, { mime: string; format: string }> = {
  '.ttf': { mime: 'font/ttf', format: 'truetype' },
  '.otf': { mime: 'font/otf', format: 'opentype' },
  '.woff': { mime: 'font/woff', format: 'woff' },
  '.woff2': { mime: 'font/woff2', format: 'woff2' },
};
export function validateFont(buffer: Buffer, extension: string) {
  const info = formats[extension];
  if (!info) throw new ApiError(400, '지원하지 않는 글꼴 형식입니다.');
  if (buffer.length < 48 || buffer.length > 20 * 1024 * 1024)
    throw new ApiError(400, '글꼴 파일은 48바이트 이상, 20MB 이하여야 합니다.');
  const signature = buffer.toString('ascii', 0, 4);
  const sfnt = buffer.readUInt32BE(0);
  if (extension === '.woff' || extension === '.woff2') {
    if (
      signature !== (extension === '.woff' ? 'wOFF' : 'wOF2') ||
      buffer.readUInt32BE(8) !== buffer.length ||
      buffer.readUInt16BE(14) !== 0
    )
      throw new ApiError(400, '글꼴 헤더 또는 파일 길이가 올바르지 않습니다.');
    const flavor = buffer.readUInt32BE(4),
      count = buffer.readUInt16BE(12),
      expanded = buffer.readUInt32BE(16);
    if (
      ![0x00010000, 0x4f54544f].includes(flavor) ||
      count < 1 ||
      count > 256 ||
      expanded < 12 ||
      expanded > 100 * 1024 * 1024
    )
      throw new ApiError(400, '지원하지 않거나 손상된 웹 글꼴입니다.');
    if (extension === '.woff') {
      const end = 44 + count * 20;
      if (end > buffer.length) throw new ApiError(400, '글꼴 테이블이 잘렸습니다.');
      for (let i = 0; i < count; i++) {
        const start = 44 + i * 20,
          offset = buffer.readUInt32BE(start + 4),
          compressed = buffer.readUInt32BE(start + 8),
          original = buffer.readUInt32BE(start + 12);
        if (offset < end || offset + compressed > buffer.length || compressed > original)
          throw new ApiError(400, '글꼴 테이블 범위가 올바르지 않습니다.');
      }
    } else {
      const compressed = buffer.readUInt32BE(20);
      if (!compressed || compressed > buffer.length - 48)
        throw new ApiError(400, 'WOFF2 압축 데이터 길이가 올바르지 않습니다.');
    }
  } else {
    if (
      (extension === '.ttf' && sfnt !== 0x00010000) ||
      (extension === '.otf' && signature !== 'OTTO')
    )
      throw new ApiError(400, '확장자와 글꼴 형식이 일치하지 않습니다.');
    const count = buffer.readUInt16BE(4),
      end = 12 + count * 16;
    if (count < 1 || count > 256 || end > buffer.length)
      throw new ApiError(400, '글꼴 테이블 목록이 잘못되었습니다.');
    const tags = new Set<string>();
    for (let i = 0; i < count; i++) {
      const start = 12 + i * 16,
        offset = buffer.readUInt32BE(start + 8),
        size = buffer.readUInt32BE(start + 12),
        tag = buffer.toString('ascii', start, start + 4);
      if (offset < end || offset + size > buffer.length || tags.has(tag))
        throw new ApiError(400, '글꼴 테이블 범위가 올바르지 않습니다.');
      tags.add(tag);
    }
    if (
      !['head', 'name', 'cmap', 'hhea', 'hmtx', 'maxp'].every((tag) => tags.has(tag)) ||
      !((tags.has('glyf') && tags.has('loca')) || tags.has('CFF ') || tags.has('CFF2'))
    )
      throw new ApiError(400, '필수 글꼴 테이블이 없습니다.');
  }
  return info;
}
export function fontFamily(asset: Asset) {
  return (
    path
      .basename(asset.name, path.extname(asset.name))
      .normalize('NFKC')
      .replace(/[^\p{L}\p{N} _-]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100) || `StudioFont-${asset.hash.slice(0, 12)}`
  );
}
export function fontAssets(assets: Asset[]) {
  const seen = new Set<string>();
  return assets
    .filter((asset) => {
      if (
        !asset.mime.startsWith('font/') ||
        !formats[path.extname(asset.relativePath).toLowerCase()] ||
        seen.has(asset.hash)
      )
        return false;
      seen.add(asset.hash);
      return true;
    })
    .map((asset) => ({
      ...asset,
      fontFamily: fontFamily(asset),
      format: formats[path.extname(asset.relativePath).toLowerCase()].format,
    }));
}
export function fontsCss(assets: Asset[]) {
  return fontAssets(assets)
    .map(
      (asset) =>
        `@font-face{font-family:${JSON.stringify(asset.fontFamily)};src:url("/api/assets/${encodeURIComponent(asset.id)}") format(${JSON.stringify(asset.format)});font-display:swap;font-style:normal;font-weight:100 900;}`,
    )
    .join('\n');
}
