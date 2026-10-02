import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Asset, ExportContext, Project, ExportResult } from '../core/types.ts';
import { assertSafeSvg } from '../core/svg.ts';

export interface Loss {
  elementId?: string;
  location: string;
  capability: 'native' | 'rasterized' | 'approximated' | 'unsupported';
  feature: string;
  message: string;
}
export const hashBuffer = (buffer: Buffer | Uint8Array) =>
  createHash('sha256').update(buffer).digest('hex');
export const slug = (value: string) =>
  value.replace(/[^a-zA-Z0-9가-힣_-]/g, '-').slice(0, 80) || 'project';
export function checkAbort(context: ExportContext) {
  if (context.signal?.aborted) throw new Error('내보내기를 취소했습니다.');
}
export async function prepareOutput(context: ExportContext, format: string) {
  checkAbort(context);
  const dir = path.join(context.outputDir, `${format}-${Date.now()}-${randomUUID().slice(0, 8)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}
export function resolveAssetPath(asset: Asset, context: ExportContext) {
  const candidate = context.assetPath
    ? context.assetPath(asset)
    : path.resolve(context.assetsDir, asset.relativePath);
  if (!context.assetPath) {
    const relative = path.relative(path.resolve(context.assetsDir), candidate);
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error(`에셋 경로가 허용된 폴더 밖입니다: ${asset.name}`);
  }
  return candidate;
}
export async function assetBytes(asset: Asset, context: ExportContext) {
  checkAbort(context);
  const buffer = await readFile(resolveAssetPath(asset, context));
  if (asset.hash && hashBuffer(buffer) !== asset.hash.toLowerCase())
    throw new Error(`에셋 해시가 다릅니다: ${asset.name}`);
  if (asset.mime === 'image/svg+xml' || /\.svg$/i.test(asset.relativePath))
    assertSafeSvg(buffer.toString('utf8'));
  return buffer;
}
export function safeProject(project: Project): Project {
  const clone = JSON.parse(JSON.stringify(project)) as Project;
  clone.datasets = clone.datasets.map((d) => {
    delete d.connection;
    return d;
  });
  clone.assets = clone.assets.map((a) => {
    if (a.source && /^https?:/i.test(a.source)) {
      try {
        const u = new URL(a.source);
        u.username = '';
        u.password = '';
        u.search = '';
        u.hash = '';
        a.source = u.toString();
      } catch {
        delete a.source;
      }
    }
    return a;
  });
  return clone;
}
export async function writeManifest(
  dir: string,
  project: Project,
  format: string,
  losses: Loss[],
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const manifest = {
    schemaVersion: 1,
    format,
    projectId: project.id,
    projectRevision: project.revision,
    exportedAt: new Date().toISOString(),
    capabilities: losses,
    font: {
      requested: project.brand.font,
      embedded: false,
      note: '대상 문서의 글꼴 임베딩은 보장하지 않습니다. 동봉 자산과 대상 도구의 글꼴 설치 여부·라이선스를 확인하세요.',
    },
    ...extra,
  };
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}
export function result(
  dir: string,
  names: { name: string; mime: string }[],
  manifest: Record<string, unknown>,
): ExportResult {
  return {
    files: [...names, { name: 'manifest.json', mime: 'application/json' }].map((f) => ({
      ...f,
      path: path.join(dir, f.name),
    })),
    manifest,
  };
}
