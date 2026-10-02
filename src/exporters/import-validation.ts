import sharp from 'sharp';
import type { Asset } from '../core/types.ts';
import { assertSafeSvg } from '../core/svg.ts';

/** Imported manifests are claims, not an authorization to serve active content. */
export async function validateImportedAsset(asset: Asset, bytes: Buffer): Promise<string> {
  const fail = () => {
    throw new Error(`허용하지 않거나 형식이 일치하지 않는 자산: ${asset.name}`);
  };
  const mime = asset.mime.toLowerCase();
  if (['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime)) {
    const metadata = await sharp(bytes, { limitInputPixels: 100000000 }).metadata();
    const formats: Record<string, [string, string]> = {
      png: ['image/png', '.png'],
      jpeg: ['image/jpeg', '.jpg'],
      webp: ['image/webp', '.webp'],
      gif: ['image/gif', '.gif'],
    };
    const actual = formats[metadata.format || ''];
    if (!actual || actual[0] !== mime) return fail();
    asset.width = metadata.width;
    asset.height = metadata.height;
    return actual[1];
  }
  if (mime === 'image/svg+xml') {
    assertSafeSvg(bytes.toString('utf8'));
    return '.svg';
  }
  const magic = bytes.subarray(0, 16);
  const ascii = magic.toString('latin1');
  if (mime === 'video/mp4' || mime === 'audio/mp4') {
    if (bytes.length < 12 || ascii.slice(4, 8) !== 'ftyp') return fail();
    return mime === 'video/mp4' ? '.mp4' : '.m4a';
  }
  if (mime === 'video/webm') {
    if (bytes.length < 4 || bytes.readUInt32BE(0) !== 0x1a45dfa3) return fail();
    return '.webm';
  }
  if (mime === 'audio/mpeg') {
    if (
      !ascii.startsWith('ID3') &&
      !(bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
    )
      return fail();
    return '.mp3';
  }
  if (mime === 'audio/wav') {
    if (!ascii.startsWith('RIFF') || ascii.slice(8, 12) !== 'WAVE') return fail();
    return '.wav';
  }
  if (mime === 'audio/ogg') {
    if (!ascii.startsWith('OggS')) return fail();
    return '.ogg';
  }
  if (mime.startsWith('font/')) {
    if (bytes.length < 48 || bytes.length > 20 * 1024 * 1024) return fail();
    const sfnt = bytes.readUInt32BE(0);
    if (mime === 'font/woff' || mime === 'font/woff2') {
      if (
        ascii.slice(0, 4) !== (mime === 'font/woff' ? 'wOFF' : 'wOF2') ||
        bytes.readUInt32BE(8) !== bytes.length ||
        bytes.readUInt16BE(14) !== 0
      )
        return fail();
      const flavor = bytes.readUInt32BE(4),
        count = bytes.readUInt16BE(12),
        expanded = bytes.readUInt32BE(16);
      if (
        ![0x00010000, 0x4f54544f].includes(flavor) ||
        count < 1 ||
        count > 256 ||
        expanded < 12 ||
        expanded > 100 * 1024 * 1024
      )
        return fail();
      if (mime === 'font/woff') {
        const end = 44 + count * 20;
        if (end > bytes.length) return fail();
        for (let i = 0; i < count; i++) {
          const at = 44 + i * 20,
            offset = bytes.readUInt32BE(at + 4),
            compressed = bytes.readUInt32BE(at + 8),
            original = bytes.readUInt32BE(at + 12);
          if (offset < end || offset + compressed > bytes.length || compressed > original)
            return fail();
        }
        return '.woff';
      }
      if (!bytes.readUInt32BE(20) || bytes.readUInt32BE(20) > bytes.length - 48) return fail();
      return '.woff2';
    }
    if (
      (mime === 'font/ttf' && sfnt === 0x00010000) ||
      (mime === 'font/otf' && ascii.startsWith('OTTO'))
    ) {
      const count = bytes.readUInt16BE(4),
        end = 12 + count * 16;
      if (count < 1 || count > 256 || end > bytes.length) return fail();
      const tags = new Set<string>();
      for (let i = 0; i < count; i++) {
        const at = 12 + i * 16,
          offset = bytes.readUInt32BE(at + 8),
          size = bytes.readUInt32BE(at + 12),
          tag = bytes.toString('ascii', at, at + 4);
        if (offset < end || offset + size > bytes.length || tags.has(tag)) return fail();
        tags.add(tag);
      }
      if (
        !['head', 'name', 'cmap', 'hhea', 'hmtx', 'maxp'].every((tag) => tags.has(tag)) ||
        !((tags.has('glyf') && tags.has('loca')) || tags.has('CFF ') || tags.has('CFF2'))
      )
        return fail();
      return mime === 'font/ttf' ? '.ttf' : '.otf';
    }
    return fail();
  }
  if (mime === 'text/plain') return '.txt';
  return fail();
}
