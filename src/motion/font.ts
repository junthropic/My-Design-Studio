import type { Asset } from '../core/types';
/** Same stable filename alias as server/fonts.ts, without Node dependencies. */
export function fontFamilyForAsset(asset: Asset) {
  return (
    (asset.name.split(/[\\/]/).pop() ?? asset.name)
      .replace(/\.[^.]+$/, '')
      .normalize('NFKC')
      .replace(/[^\p{L}\p{N} _-]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100) || `StudioFont-${asset.hash.slice(0, 12)}`
  );
}
export function activeFontAsset(assets: Asset[], family: string) {
  const name = family
    .split(',')[0]
    .trim()
    .replace(/^['"]|['"]$/g, '');
  return assets.find(
    (asset) => asset.mime.startsWith('font/') && fontFamilyForAsset(asset) === name,
  );
}
