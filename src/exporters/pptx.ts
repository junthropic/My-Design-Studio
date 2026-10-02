import PptxGenJS from 'pptxgenjs';
import sharp from 'sharp';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { Project, ExportContext, ExportResult, StudioElement } from '../core/types.ts';
import { resolveDesign } from '../core/design.ts';
import {
  assetBytes,
  checkAbort,
  prepareOutput,
  result,
  slug,
  writeManifest,
  type Loss,
} from './common.ts';

export async function exportPowerPoint(
  project: Project,
  context: ExportContext,
): Promise<ExportResult> {
  const dir = await prepareOutput(context, 'pptx'),
    design = resolveDesign(project, 'ppt'),
    t = design.tokens;
  const color = (value: string | undefined, fallback = 'color.text') => {
    const key = value?.match(/^\{([^}]+)\}$/)?.[1];
    const raw = key ? t[key] : value || t[fallback];
    return /^#[0-9a-f]{6}$/i.test(String(raw))
      ? String(raw).slice(1)
      : String(t[fallback]).slice(1);
  };
  const ppt = new PptxGenJS();
  // The editor's slide geometry and typography are points. PptxGenJS expects
  // inches for geometry, but points for font size, tracking and line width.
  const pointsToInches = 1 / 72;
  ppt.defineLayout({
    name: 'STUDIO',
    width: project.slideSize.width * pointsToInches,
    height: project.slideSize.height * pointsToInches,
  });
  ppt.layout = 'STUDIO';
  ppt.author = project.brand.name;
  ppt.subject = 'Design Studio editable presentation';
  ppt.title = project.name;
  ppt.company = project.brand.name;
  ppt.theme = { headFontFace: project.brand.font, bodyFontFace: project.brand.font };
  const losses: Loss[] = [];
  const masterObjects: PptxGenJS.SlideMasterProps['objects'] = [];
  const logo = project.assets.find((a) => a.id === project.brand.logoAssetId);
  if (logo && logo.mime.startsWith('image/')) {
    const original = await assetBytes(logo, context);
    let bytes: Buffer = original,
      mime = logo.mime;
    let capability: Loss['capability'] = 'native';
    if (!/^image\/(png|jpeg|gif|svg\+xml)$/.test(mime)) {
      bytes = await sharp(bytes).png().toBuffer();
      mime = 'image/png';
      capability = 'rasterized';
    }
    const metadata = await sharp(original).metadata(),
      ratio = (metadata.width || 60) / (metadata.height || 32),
      w = Math.min(60, 32 * ratio),
      h = w / ratio;
    masterObjects.push({
      image: {
        data: `${mime};base64,${bytes.toString('base64')}`,
        x: (project.slideSize.width - 105 + (60 - w) / 2) * pointsToInches,
        y: (24 + (32 - h) / 2) * pointsToInches,
        w: w * pointsToInches,
        h: h * pointsToInches,
        altText: project.brand.name + ' 로고',
        objectName: 'brand-logo-' + logo.id,
      },
    });
    losses.push({
      location: 'slide-master',
      elementId: logo.id,
      feature: '브랜드 로고',
      capability,
      message:
        '모든 장표의 오른쪽 위에 비율을 유지한 마스터 이미지로 포함합니다. PowerPoint 슬라이드 마스터에서 편집할 수 있습니다.',
    });
  } else if (project.brand.logoAssetId)
    losses.push({
      location: 'slide-master',
      feature: '브랜드 로고',
      capability: 'unsupported',
      message: '유효한 이미지 자산을 찾지 못해 로고를 내보내지 않았습니다.',
    });
  ppt.defineSlideMaster({
    title: 'STUDIO_MASTER',
    background: { color: color(undefined, 'color.bg') },
    objects: masterObjects,
  });
  if (Number(t['effect.blur']) || Number(t['effect.glow']))
    losses.push({
      location: 'theme',
      feature: '유리·광원',
      capability: 'approximated',
      message:
        'CSS 배경 블러와 광원은 평면 브랜드색으로 대체됩니다. 텍스트와 도형은 편집 가능합니다.',
    });
  const rect = (e: StudioElement) => ({
    x: e.x * pointsToInches,
    y: e.y * pointsToInches,
    w: e.w * pointsToInches,
    h: e.h * pointsToInches,
    rotate: (((e.rotation || 0) % 360) + 360) % 360,
    objectName: e.id,
  });
  for (const [i, source] of project.slides.entries()) {
    checkAbort(context);
    context.onProgress?.(
      Math.round((i / Math.max(1, project.slides.length)) * 85),
      `장표 ${i + 1} / ${project.slides.length}`,
    );
    const slide = ppt.addSlide('STUDIO_MASTER');
    slide.hidden = source.hidden;
    slide.addNotes(source.notes || `${source.name} · ${source.layout}`);
    for (const e of source.elements) {
      const location = `slide:${source.id}`,
        base = rect(e),
        transparency = Math.round((1 - (e.opacity ?? 1)) * 100);
      let capability: Loss['capability'] = 'native',
        message = 'PowerPoint에서 개별 요소를 편집할 수 있습니다.';
      if (e.type === 'text')
        slide.addText(e.text || '', {
          ...base,
          fontFace: project.brand.font,
          fontSize: e.fontSize || Number(t['font.body']),
          bold: (e.fontWeight || 400) >= 600,
          color: color(e.color),
          transparency,
          margin: 0,
          breakLine: false,
          valign: 'top',
          lineSpacingMultiple: Number(t['font.lineHeight']),
          charSpacing: Number(t['font.tracking']),
          fit: 'resize',
          lang: 'ko-KR',
        });
      else if (e.type === 'shape') {
        const shape =
          e.shape === 'ellipse'
            ? ppt.ShapeType.ellipse
            : e.shape === 'line'
              ? ppt.ShapeType.line
              : ppt.ShapeType.rect;
        slide.addShape(shape, {
          ...base,
          fill: { color: color(e.fill, 'color.accent'), transparency },
          line: {
            color: color(e.fill, 'color.accent'),
            transparency,
            width: e.shape === 'line' ? Math.max(1, e.h) : 0,
          },
        });
      } else if (e.type === 'table') {
        const rawRows = e.tableData || [],
          cols = Math.max(0, ...rawRows.map((r) => r.length)),
          rows = rawRows.map((row) => Array.from({ length: cols }, (_, i) => row[i] ?? ''));
        if (!rows.length || !cols) {
          capability = 'unsupported';
          message = '행 또는 열이 없는 표는 내보내지 않았습니다.';
        } else
          slide.addTable(
            rows.map((row, ri) =>
              row.map((cell) => ({
                text: cell,
                options: {
                  fill: { color: color(undefined, ri ? 'color.surface' : 'color.accent') },
                  color: color(undefined, ri ? 'color.text' : 'color.onAccent'),
                  bold: ri === 0,
                },
              })),
            ),
            {
              ...base,
              fontFace: project.brand.font,
              fontSize: e.fontSize || 18,
              border: { color: color(undefined, 'color.border'), pt: 0.5 },
              margin: 6,
              rowH: base.h / rows.length,
              colW: base.w / cols,
              autoPage: false,
              color: color(e.color),
              fill: { color: color(e.fill, 'color.surface') },
              transparency,
            },
          );
        if (capability !== 'unsupported' && (e.rotation || transparency)) {
          capability = 'approximated';
          message =
            '표는 네이티브 셀로 유지됩니다. 표 회전·전체 투명도는 PowerPoint 기능 범위에 따라 다를 수 있습니다.';
        }
      } else if (e.type === 'chart') {
        const d = e.chartData;
        if (!d?.labels.length || !d.values.length) {
          capability = 'unsupported';
          message = '데이터가 없는 차트는 내보내지 않았습니다.';
        } else if (
          d.type === 'pie' &&
          (d.values.some((v) => v < 0) || !d.values.some((v) => v > 0))
        ) {
          capability = 'unsupported';
          message = '파이 차트에는 음수가 없어야 하며 최소 하나의 양수가 필요합니다.';
        } else {
          const count = Math.min(d.labels.length, d.values.length);
          const type =
            d.type === 'line'
              ? ppt.ChartType.line
              : d.type === 'pie'
                ? ppt.ChartType.pie
                : ppt.ChartType.bar;
          slide.addChart(
            type,
            [{ name: '값', labels: d.labels.slice(0, count), values: d.values.slice(0, count) }],
            {
              ...base,
              catAxisLabelFontFace: project.brand.font,
              valAxisLabelFontFace: project.brand.font,
              catAxisLabelFontSize: 11,
              valAxisLabelFontSize: 10,
              catAxisLabelColor: color(undefined, 'color.muted'),
              valAxisLabelColor: color(undefined, 'color.muted'),
              chartColors: [
                color(undefined, 'color.accent'),
                color(undefined, 'color.success'),
                color(undefined, 'color.muted'),
              ],
              showTitle: false,
              showLegend: d.type === 'pie',
              showValue: true,
              dataLabelColor: color(e.color),
              catAxisLineShow: false,
              valAxisLineShow: false,
              valGridLine: { color: color(undefined, 'color.border'), size: 0.5 },
              legendColor: color(undefined, 'color.text'),
              legendFontFace: project.brand.font,
              layout: { x: 0.1, y: 0.05, w: 0.85, h: 0.8 },
            },
          );
          message = '편집 가능한 네이티브 차트와 내부 Excel 데이터 통합문서를 포함합니다.';
          if (d.labels.length !== d.values.length) {
            capability = 'approximated';
            message += ' 라벨과 값 개수가 달라 공통 길이까지만 사용했습니다.';
          }
        }
      } else if (e.type === 'image' || e.type === 'video') {
        const asset = project.assets.find((a) => a.id === e.assetId);
        if (!asset) {
          capability = 'unsupported';
          message = '연결된 자산이 없어 요소를 내보내지 않았습니다.';
        } else if (e.type === 'image') {
          const data = await assetBytes(asset, context);
          const native = /^image\/(png|jpeg|gif|svg\+xml)$/.test(asset.mime);
          let image: Buffer = data;
          let mime = asset.mime;
          if (!native) {
            image = await sharp(data).png().toBuffer();
            mime = 'image/png';
            capability = 'rasterized';
            message =
              'PowerPoint 호환성을 위해 PNG로 변환했습니다. 이미지 개체의 크기·위치는 편집 가능합니다.';
          }
          slide.addImage({
            ...base,
            data: `${mime};base64,${image.toString('base64')}`,
            altText: e.alt || asset.name,
            transparency,
          });
        } else {
          const data = await assetBytes(asset, context);
          if (!/^video\//.test(asset.mime)) {
            capability = 'unsupported';
            message = '영상 MIME이 아닌 자산은 영상 개체로 내보내지 않았습니다.';
          } else {
            slide.addMedia({
              ...base,
              type: 'video',
              data: `${asset.mime};base64,${data.toString('base64')}`,
              extn: path.extname(asset.relativePath).replace('.', '') || 'mp4',
            });
            message =
              '파일이 포함된 영상 개체입니다. 재생은 대상 PowerPoint 및 코덱 지원에 따라 확인해야 합니다.';
          }
        }
      }
      losses.push({ elementId: e.id, location, feature: e.type, capability, message });
      if (e.keyframes?.length || e.effect)
        losses.push({
          elementId: e.id,
          location,
          feature: '모션',
          capability: 'unsupported',
          message:
            '장표 요소는 정적 상태입니다. 웹·모션 효과 및 키프레임은 PPTX 애니메이션으로 변환하지 않습니다.',
        });
      if (e.group || e.locked)
        losses.push({
          elementId: e.id,
          location,
          feature: '그룹·잠금',
          capability: 'approximated',
          message: '원래의 개별 요소 순서는 유지되며 편집기 전용 잠금과 그룹은 적용하지 않습니다.',
        });
    }
  }
  const name = slug(project.name) + '.pptx';
  await ppt.writeFile({ fileName: path.join(dir, name), compression: true });
  const manifest = await writeManifest(dir, project, 'pptx', losses, {
    slides: project.slides.length,
    hiddenSlides: project.slides.filter((s) => s.hidden).length,
    layouts: [...new Set(project.slides.map((s) => s.layout))],
    coordinateConversion: {
      source: 'pt',
      inchesPerPoint: pointsToInches,
      emuPerPoint: 12700,
      slideSizePoints: project.slideSize,
    },
    editable: true,
    validation:
      'OOXML 구조 검사를 수행할 수 있습니다. 실제 PowerPoint의 글꼴·줄바꿈·영상 재생은 별도 시각 검사가 필요합니다.',
  });
  await writeFile(
    path.join(dir, 'README.txt'),
    '텍스트·도형·표·차트는 네이티브 PowerPoint 개체입니다. 글꼴은 포함하지 않습니다. manifest.json에서 요소별 변환 상태를 확인하세요.\n',
    'utf8',
  );
  context.onProgress?.(100, 'PowerPoint 저장 완료');
  return result(
    dir,
    [
      { name, mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
      { name: 'README.txt', mime: 'text/plain' },
    ],
    manifest,
  );
}
