import { useEffect, useState } from 'react';
import { delayRender, continueRender, cancelRender, staticFile } from 'remotion';
import type { Asset } from '../core/types';
import { activeFontAsset } from './font';

const fonts = new Map<string, Promise<void>>();
export function FontReady({
  family,
  assets,
  assetSources,
}: {
  family: string;
  assets: Asset[];
  assetSources: Record<string, string>;
}) {
  const [handle] = useState(() => delayRender('브랜드 글꼴을 불러오는 중'));
  const asset = activeFontAsset(assets, family),
    source = asset
      ? (assetSources[asset.id] ?? `/api/assets/${encodeURIComponent(asset.id)}`)
      : family.includes('Pretendard')
        ? staticFile('fonts/PretendardVariable.woff2')
        : undefined;
  useEffect(() => {
    if (!source) {
      continueRender(handle);
      return;
    }
    const fontName = family
      .split(',')[0]
      .trim()
      .replace(/^['"]|['"]$/g, '');
    const cacheKey = `${fontName}:${asset?.hash ?? source}`;
    if (!fonts.has(cacheKey))
      fonts.set(
        cacheKey,
        (async () => {
          const font = new FontFace(fontName, `url(${JSON.stringify(source)})`, {
            weight: '100 900',
            style: 'normal',
          });
          await font.load();
          document.fonts.add(font);
          await document.fonts.load(`400 16px ${JSON.stringify(fontName)}`);
        })(),
      );
    fonts.get(cacheKey)!.then(
      () => continueRender(handle),
      (error) => cancelRender(new Error(`브랜드 글꼴을 읽지 못했습니다: ${String(error)}`)),
    );
    return () => continueRender(handle);
  }, [family, handle, source, asset?.hash]);
  return null;
}
