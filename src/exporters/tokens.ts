import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import type { Project, ExportContext, ExportResult } from '../core/types.ts';
import { resolveDesign, toDTCG } from '../core/design.ts';
import { prepareOutput, result, slug, writeManifest } from './common.ts';

export async function exportTokens(
  project: Project,
  context: ExportContext,
): Promise<ExportResult> {
  const dir = await prepareOutput(context, 'tokens');
  const dtcg = toDTCG(project);
  const designs = {
    light: resolveDesign(project, project.target, 'light'),
    dark: resolveDesign(project, project.target, 'dark'),
  };
  const css = ['light', 'dark']
    .map(
      (mode) =>
        `[data-theme="${mode}"] {\n${Object.entries(designs[mode as 'light' | 'dark'].css)
          .map(([k, v]) => `  ${k}: ${k === '--font-family' ? JSON.stringify(v) : v};`)
          .join('\n')}\n}`,
    )
    .join('\n\n');
  const json = {
    schemaVersion: 1,
    projectId: project.id,
    target: project.target,
    brand: project.brand,
    modes: { light: designs.light.tokens, dark: designs.dark.tokens },
    sources: { light: designs.light.sources, dark: designs.dark.sources },
  };
  const md = `# ${project.name} — DESIGN\n\n브랜드: ${project.brand.name}\n매체: ${project.target}\n글꼴: ${project.brand.font} (포함하지 않음)\n\n## 토큰 적용 순서\n\n스타일 → 브랜드 → 매체 → 보기 → 프로젝트 변경 → 접근성 → 파생 대비 보정.\n\nDTCG typography.lineHeight는 글자 크기에 대한 배수이며 dimension 단위는 px, duration 단위는 ms입니다. 다크와 라이트 값은 따로 저장합니다.\n\n| 토큰 | 라이트 | 다크 |\n|---|---|---|\n${Object.keys(
    designs.light.tokens,
  )
    .map(
      (k) =>
        `| ${k} | ${String(designs.light.tokens[k]).replaceAll('|', '\\|')} | ${String(designs.dark.tokens[k]).replaceAll('|', '\\|')} |`,
    )
    .join(
      '\n',
    )}\n\n대비는 불투명한 토큰 쌍에 대한 계산입니다. 이미지·유리 표면·영상 위 텍스트는 대상 화면에서 직접 검사하세요. 매체별 스케일, 변환 한계는 각각의 export manifest.json에 기록합니다.\n`;
  // Complete primitive numeric tokens with unambiguous DTCG types, preserving typography's dimensionless lineHeight.
  for (const mode of ['light', 'dark'] as const) {
    const group = dtcg[mode] as Record<string, unknown>;
    const d = designs[mode].tokens;
    group.motion = {
      duration: { $type: 'duration', $value: { value: Number(d['motion.duration']), unit: 'ms' } },
    };
    group.effects = {
      blur: { $type: 'dimension', $value: { value: Number(d['effect.blur']), unit: 'px' } },
      glow: { $type: 'number', $value: Number(d['effect.glow']) },
      decor: { $type: 'number', $value: Number(d['effect.decor']) },
    };
  }
  const files = {
    'tokens.dtcg.json': JSON.stringify(dtcg, null, 2),
    'tokens.json': JSON.stringify(json, null, 2),
    'tokens.css': css,
    'DESIGN.md': md,
  };
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content, 'utf8');
    zip.file(name, content);
  }
  const manifest = await writeManifest(
    dir,
    project,
    'tokens',
    [
      {
        location: 'tokens',
        feature: '토큰·타입·단위',
        capability: 'native',
        message:
          'DTCG 색 공간, px 치수, ms 지속시간, typography 배수 행간과 출처 추적을 포함합니다.',
      },
    ],
    { dtcgVersion: '2025.10', target: project.target, credentialsIncluded: false },
  );
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  const name = slug(project.name) + '-tokens.zip';
  await writeFile(
    path.join(dir, name),
    await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
  );
  return result(
    dir,
    [
      { name, mime: 'application/zip' },
      ...Object.keys(files).map((name) => ({
        name,
        mime: name.endsWith('.json')
          ? 'application/json'
          : name.endsWith('.css')
            ? 'text/css'
            : 'text/markdown',
      })),
    ],
    manifest,
  );
}
