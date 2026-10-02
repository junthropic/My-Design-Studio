import { STYLES, TOKEN_META } from './presets';
import type { Project, Target, Mode, ResolvedDesign, TokenValue, ValidationReport } from './types';
export function rgb(hex: string): number[] {
  const s = hex.replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(s)) throw new Error('올바른 HEX 색이 아닙니다.');
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16) / 255);
}
export function contrast(a: string, b: string) {
  const lum = (v: string) =>
    rgb(v)
      .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
      .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  const x = lum(a),
    y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
function blend(a: string, b: string, t: number) {
  const aa = rgb(a),
    bb = rgb(b);
  return (
    '#' +
    aa
      .map((v, i) =>
        Math.round((v * (1 - t) + bb[i] * t) * 255)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}
export function readableAccent(accent: string, bg: string) {
  if (contrast(accent, bg) >= 4.5) return accent;
  const toward = contrast('#ffffff', bg) > contrast('#000000', bg) ? '#ffffff' : '#000000';
  for (let i = 1; i <= 100; i++) {
    const c = blend(accent, toward, i / 100);
    if (contrast(c, bg) >= 4.5) return c;
  }
  return toward;
}
export function resolveReferences(input: Record<string, TokenValue>): Record<string, TokenValue> {
  const result: Record<string, TokenValue> = Object.create(null);
  const stack = new Set<string>();
  function visit(k: string): TokenValue {
    if (Object.hasOwn(result, k)) return result[k];
    if (!Object.hasOwn(input, k)) throw new Error(`없는 토큰 참조: ${k}`);
    if (stack.has(k)) throw new Error(`토큰 순환 참조: ${k}`);
    stack.add(k);
    const value = input[k];
    const match = typeof value === 'string' ? value.match(/^\{([^}]+)\}$/) : null;
    const out = match ? visit(match[1]) : value;
    stack.delete(k);
    return (result[k] = out);
  }
  for (const k of Object.keys(input)) visit(k);
  return result;
}
export function resolveDesign(
  project: Project,
  target: Target = project.target,
  mode: Mode = project.mode,
): ResolvedDesign {
  const style =
    [...STYLES, ...project.customStyles].find((s) => s.id === project.styleId) || STYLES[0];
  let tokens = { ...style[mode] };
  const sources = Object.fromEntries(Object.keys(tokens).map((k) => [k, `스타일 · ${style.name}`]));
  tokens['font.family'] = project.brand.font;
  sources['font.family'] = '브랜드';
  tokens['color.accent'] = project.brand.color;
  sources['color.accent'] = '브랜드';
  if (target === 'ppt') {
    tokens['font.body'] = 22;
    tokens['font.title'] = 40;
    sources['font.body'] = 'PowerPoint 스케일';
    sources['font.title'] = 'PowerPoint 스케일';
  }
  if (target === 'motion') {
    tokens['font.body'] = 36;
    tokens['font.title'] = 78;
    sources['font.body'] = '모션 스케일';
    sources['font.title'] = '모션 스케일';
  }
  if (project.view.depth !== 0) {
    tokens['color.bg'] = blend(
      String(tokens['color.bg']),
      mode === 'dark' ? '#000000' : '#ffffff',
      project.view.depth * 0.25,
    );
    sources['color.bg'] = '보기 · 표면 깊이';
  }
  tokens['font.title'] = Number(tokens['font.title']) * project.view.typeScale;
  tokens['font.body'] = Number(tokens['font.body']) * project.view.typeScale;
  tokens['effect.decor'] = project.view.decor;
  for (const [k, v] of Object.entries(project.overrides[mode])) {
    tokens[k] = v;
    sources[k] = '프로젝트 변경';
  }
  if (project.accessibility.highContrast) {
    Object.assign(tokens, {
      'color.bg': mode === 'dark' ? '#000000' : '#ffffff',
      'color.surface': mode === 'dark' ? '#0d0d0d' : '#ffffff',
      'color.text': mode === 'dark' ? '#ffffff' : '#000000',
      'color.muted': mode === 'dark' ? '#d5d5d5' : '#333333',
      'effect.blur': 0,
      'effect.glow': 0,
    });
    for (const k of [
      'color.bg',
      'color.surface',
      'color.text',
      'color.muted',
      'effect.blur',
      'effect.glow',
    ])
      sources[k] = '접근성 · 고대비';
  }

  if (project.accessibility.reducedMotion) {
    tokens['motion.duration'] = 0;
    sources['motion.duration'] = '접근성 · 동작 줄이기';
  }
  const rawTokens = { ...tokens };
  tokens = resolveReferences(tokens);
  if (project.accessibility.largeText) {
    tokens['font.body'] = Number(tokens['font.body']) * 1.2;
    tokens['font.title'] = Number(tokens['font.title']) * 1.2;
    sources['font.body'] += ' · 글자 확대';
    sources['font.title'] += ' · 글자 확대';
  }
  const rawAccent = String(tokens['color.accent']);
  tokens['color.accent'] = readableAccent(rawAccent, String(tokens['color.surface']));
  if (rawAccent !== tokens['color.accent']) {
    sources['color.accent'] += ' · 대비 보정';
    const refreshed = resolveReferences({ ...rawTokens, 'color.accent': tokens['color.accent'] });
    for (const [key, value] of Object.entries(rawTokens))
      if (
        typeof value === 'string' &&
        /^\{[^}]+\}$/.test(value) &&
        key !== 'font.body' &&
        key !== 'font.title'
      )
        tokens[key] = refreshed[key];
  }
  if (!('color.onAccent' in project.overrides[mode])) {
    tokens['color.onAccent'] =
      contrast('#ffffff', String(tokens['color.accent'])) >=
      contrast('#10131a', String(tokens['color.accent']))
        ? '#ffffff'
        : '#10131a';
    sources['color.onAccent'] = '파생값 · 대비';
  }
  const css = Object.fromEntries(
    Object.entries(tokens).map(([k, v]) => [
      '--' + k.replaceAll('.', '-'),
      typeof v === 'number' && /(font\.(body|title|tracking)|space\.|radius\.|effect.blur)/.test(k)
        ? `${v}px`
        : String(v),
    ]),
  );
  return { mode, target, style, tokens, sources, brandOriginal: project.brand.color, css };
}
export function contrastPairs(design: ResolvedDesign) {
  return [
    ['본문 / 페이지', 'color.text', 'color.bg', 4.5],
    ['본문 / 표면', 'color.text', 'color.surface', 4.5],
    ['보조 / 표면', 'color.muted', 'color.surface', 4.5],
    ['강조 / 표면', 'color.accent', 'color.surface', 4.5],
    ['버튼 글자 / 강조', 'color.onAccent', 'color.accent', 4.5],
  ].map(([name, fg, bg, min]) => {
    const ratio = contrast(String(design.tokens[fg]), String(design.tokens[bg]));
    return {
      name: String(name),
      fg: String(fg),
      bg: String(bg),
      ratio,
      min: Number(min),
      pass: ratio >= Number(min),
    };
  });
}
export function validateDocument(
  project: Project,
  design = resolveDesign(project),
): ValidationReport {
  const issues: ValidationReport['issues'] = [];
  for (const pair of contrastPairs(design))
    if (!pair.pass)
      issues.push({
        id: pair.fg + '-' + pair.bg,
        severity: 'error',
        message: `${pair.name}: ${pair.ratio.toFixed(2)}:1 (기준 ${pair.min}:1)`,
      });
  for (const slide of project.slides)
    for (const e of slide.elements) {
      if (
        e.x < 0 ||
        e.y < 0 ||
        e.x + e.w > project.slideSize.width + 0.1 ||
        e.y + e.h > project.slideSize.height + 0.1
      )
        issues.push({
          id: 'bounds-' + e.id,
          severity: 'warning',
          target: slide.id,
          elementId: e.id,
          message: `${slide.name}: 요소가 슬라이드 경계를 벗어납니다.`,
        });
      if (
        e.type === 'text' &&
        e.text &&
        e.fontSize &&
        e.text.length * e.fontSize * 0.55 > e.w * Math.max(1, Math.floor(e.h / (e.fontSize * 1.3)))
      )
        issues.push({
          id: 'overflow-' + e.id,
          severity: 'warning',
          target: slide.id,
          elementId: e.id,
          message: `${slide.name}: 텍스트 줄바꿈과 넘침을 확인하세요.`,
        });
      if (e.assetId && !project.assets.some((a) => a.id === e.assetId))
        issues.push({
          id: 'asset-' + e.id,
          severity: 'error',
          message: `${slide.name}: 연결된 자산이 없습니다.`,
        });
    }
  if (Number(design.tokens['effect.blur']) > 0 || Number(design.tokens['effect.glow']) > 0)
    issues.push({
      id: 'composited',
      severity: 'manual',
      message: '이미지·유리·광원 위 글자는 실제 출력에서 대비를 확인하세요.',
    });
  issues.push({
    id: 'font-render',
    severity: 'manual',
    message: '대상 PowerPoint와 영상 렌더에서 실제 글꼴·줄바꿈을 확인하세요.',
  });
  return {
    issues,
    passed: contrastPairs(design).filter((p) => p.pass).length,
    failed: issues.filter((i) => i.severity === 'error').length,
    manual: issues.filter((i) => i.severity === 'manual').length,
    checkedAt: new Date().toISOString(),
  };
}
export function toDTCG(project: Project) {
  const tokenObject = (mode: Mode) => {
    const d = resolveDesign(project, project.target, mode);
    const colors = Object.fromEntries(
      Object.entries(d.tokens)
        .filter(([k]) => k.startsWith('color.'))
        .map(([k, v]) => [
          k.slice(6),
          {
            $type: 'color',
            $value: { colorSpace: 'srgb', components: rgb(String(v)), alpha: 1, hex: v },
          },
        ]),
    );
    return {
      color: colors,
      spacing: {
        base: { $type: 'dimension', $value: { value: Number(d.tokens['space.base']), unit: 'px' } },
      },
      radius: {
        card: {
          $type: 'dimension',
          $value: { value: Number(d.tokens['radius.card']), unit: 'px' },
        },
      },
      typography: {
        body: {
          $type: 'typography',
          $value: {
            fontFamily: String(d.tokens['font.family']),
            fontSize: { value: Number(d.tokens['font.body']), unit: 'px' },
            fontWeight: 400,
            letterSpacing: { value: Number(d.tokens['font.tracking']), unit: 'px' },
            lineHeight: Number(d.tokens['font.lineHeight']),
          },
        },
      },
    };
  };
  return {
    $schema: 'https://www.designtokens.org/schemas/2025.10/format.json',
    $description: project.name,
    light: tokenObject('light'),
    dark: tokenObject('dark'),
  };
}
