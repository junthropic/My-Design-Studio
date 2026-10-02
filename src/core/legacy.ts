import { createProject } from './templates';
import { ProjectSchema } from './schema';
import { STYLES } from './presets';
import type { Project, TokenValue, Mode } from './types';

type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const modes: Mode[] = ['light', 'dark'];
const colors: Record<string, string> = {
  'surface-base': 'color.bg',
  'surface-raised': 'color.surface',
  ink: 'color.text',
  'ink-muted': 'color.muted',
  line: 'color.border',
  primary: 'color.accent',
  'on-primary': 'color.onAccent',
  success: 'color.success',
  danger: 'color.danger',
};
const secondaryColors = new Set([
  'surface-sunken',
  'surface-overlay',
  'ink-strong',
  'ink-disabled',
  'line-strong',
  'focus',
  'fill-hover',
  'fill-selected',
  'fill-pressed',
  'disabled-bg',
  'primary-hover',
  'primary-pressed',
  'danger-hover',
  'danger-pressed',
  'on-danger',
  'danger-subtle',
  'success-subtle',
  'warning',
  'warning-subtle',
  'info',
  'info-subtle',
]);
const viewPresets: Record<string, Obj> = {
  default: {},
  focus: { depth: 1, decor: 0.5 },
  paper: { shadow: 0, motion: 0, decor: 0 },
  'high-contrast': { contrast: 1, decor: 0 },
  large: { typeScale: 1.2 },
  compact: { density: 'compact' },
};
const hex = (value: unknown) => {
  if (typeof value === 'string' && /^#[a-f\d]{6}$/i.test(value)) return value.toLowerCase();
  if (
    object(value) &&
    typeof value.hex === 'string' &&
    /^#[a-f\d]{6}$/i.test(value.hex) &&
    (!('alpha' in value) || value.alpha === 1)
  )
    return value.hex.toLowerCase();
  if (
    object(value) &&
    value.colorSpace === 'srgb' &&
    Array.isArray(value.components) &&
    value.components.length === 3 &&
    value.components.every(
      (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1,
    ) &&
    (!('alpha' in value) || value.alpha === 1)
  )
    return (
      '#' +
      value.components
        .map((v) =>
          Math.round(Number(v) * 255)
            .toString(16)
            .padStart(2, '0'),
        )
        .join('')
    );
  throw new Error('기존 색상은 불투명한 6자리 HEX 또는 sRGB 값이어야 합니다.');
};
function at(root: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((v, k) => {
    if (['__proto__', 'constructor', 'prototype'].includes(k) || !object(v) || !Object.hasOwn(v, k))
      return undefined;
    return v[k];
  }, root);
}
function finite(value: unknown, min: number, max: number, label: string) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw new Error(`${label} 값이 지원 범위를 벗어납니다.`);
  return value;
}
function dimension(v: unknown, label: string) {
  const raw = object(v) ? v.value : v;
  if (object(v) && v.unit !== 'px' && v.unit !== 'ms')
    throw new Error(`${label}: px 또는 ms 단위만 변환합니다.`);
  return finite(raw, 0, 100000, label);
}
function safeFont(v: unknown) {
  const text = Array.isArray(v) ? v[0] : v;
  if (typeof text !== 'string' || !text.trim() || text.length > 150 || /[;{}<>\r\n]/.test(text))
    throw new Error('기존 글꼴 이름이 올바르지 않습니다.');
  return text;
}

/** Converts the actual kit v2/v3 tokens.json, specimen overrides.json, brand JSON and v3 DTCG exports. */
export function importLegacyProject(input: unknown): { project: Project; warnings: string[] } {
  if (!object(input)) throw new Error('지원하는 v2/v3 토큰·브랜드·변경분 JSON 객체가 아닙니다.');
  const warnings: string[] = [];
  const unsupported = new Set<string>();
  const rawVersion = at(input, '$extensions.system.version');
  const rawTokens =
    typeof rawVersion === 'string' &&
    /^[23]\./.test(rawVersion) &&
    object(input.color) &&
    object(at(input, 'color.surface-base'));
  const dtcg =
    typeof input.$schema === 'string' &&
    input.$schema.startsWith('https://www.designtokens.org/') &&
    object(input.color) &&
    object(at(input, 'color.surface-base')) &&
    object(input.typography);
  const overrides =
    ['design-kit-v2', 'design-kit-v3'].includes(String(input.kit)) && object(input.edits);
  const savedState =
    object(input.edits) &&
    ['light', 'dark'].includes(String(input.mode)) &&
    typeof input.view === 'string' &&
    Object.keys(input).every((k) => ['mode', 'view', 'edits', 'custom', 'cvd'].includes(k));
  const brand =
    typeof input.id === 'string' &&
    typeof input.name === 'string' &&
    object(input.colors) &&
    typeof input.colors.brand === 'string' &&
    object(input.fonts) &&
    ('text' in input.fonts || 'display' in input.fonts);
  if (!rawTokens && !dtcg && !overrides && !savedState && !brand)
    throw new Error(
      '알 수 없는 JSON입니다. design-kit-v2/v3의 tokens.json, overrides.json, 브랜드 JSON 또는 DTCG 내보내기를 선택하세요.',
    );
  const name = brand
    ? String(input.name)
    : typeof at(input, '$extensions.system.name') === 'string'
      ? String(at(input, '$extensions.system.name'))
      : '기존 디자인 킷';
  const project = createProject(name.slice(0, 190));
  project.mode = 'light';
  project.target = 'web';
  project.brand = { name: name.slice(0, 200), color: '#0b5fff', font: 'Pretendard' };
  project.styleId = 'legacy-kit';
  project.view = { depth: 0, typeScale: 1, decor: 1 };
  const baseline = STYLES.find((s) => s.id === 'minimal')!;
  const base: Record<string, TokenValue> = {
    'font.family': 'Pretendard',
    'font.title': 24,
    'font.body': 15,
    'font.lineHeight': 1.6,
    'space.base': 24,
    'radius.card': 8,
    'motion.duration': 250,
    'effect.blur': 0,
    'effect.glow': 0,
    'effect.decor': 1,
  };
  project.customStyles = [
    {
      ...structuredClone(baseline),
      id: 'legacy-kit',
      name: '기존 킷 가져오기',
      english: 'IMPORTED KIT',
      description: '기존 v2/v3 값에서 변환한 스타일. 변환 보고서에서 미대응 항목을 확인하세요.',
      custom: true,
      accent: '#0b5fff',
      light: {
        ...baseline.light,
        ...base,
        'color.bg': '#ffffff',
        'color.surface': '#ffffff',
        'color.text': '#1f2937',
        'color.muted': '#646b78',
        'color.border': '#e5e7eb',
        'color.accent': '#0b5fff',
        'color.onAccent': '#ffffff',
        'color.success': '#067647',
        'color.danger': '#d92d20',
      },
      dark: {
        ...baseline.dark,
        ...base,
        'color.bg': '#111827',
        'color.surface': '#172031',
        'color.text': '#f3f4f6',
        'color.muted': '#9ca3af',
        'color.border': '#374151',
        'color.accent': '#5b8cff',
        'color.onAccent': '#111827',
        'color.success': '#47cd89',
        'color.danger': '#f97066',
      },
    },
  ];
  function assignColor(key: string, value: unknown, mode: Mode) {
    const valueHex = hex(value);
    if (colors[key]) project.overrides[mode][colors[key]] = valueHex;
    else if (secondaryColors.has(key)) {
      project.overrides[mode]['legacy.color.' + key] = valueHex;
      unsupported.add('표현에 미연결(원값 보존): color.' + key);
    } else unsupported.add('변환하지 않은 색 토큰: ' + key);
  }
  function applyView(knobs: unknown) {
    if (!object(knobs)) throw new Error('기존 보기 knobs는 객체여야 합니다.');
    for (const [key, value] of Object.entries(knobs)) {
      switch (key) {
        case 'depth':
          project.view.depth = finite(value, 0, 1, 'depth');
          if (value)
            warnings.push(
              '표면 깊이는 새 보기 모델로 변환했습니다. 이전 OKLCH 밝기 보정과 색이 완전히 같지는 않습니다.',
            );
          break;
        case 'typeScale':
          project.view.typeScale = finite(value, 0.5, 2, 'typeScale');
          if (value !== 1)
            warnings.push(
              '글자 확대는 새 배율 계산을 사용합니다. 기존 단계별 반올림과 다를 수 있습니다.',
            );
          break;
        case 'decor':
          project.view.decor = finite(value, 0, 1.4, 'decor');
          break;
        case 'contrast':
          project.accessibility.highContrast = finite(value, 0, 1, 'contrast') > 0;
          if (value)
            warnings.push(
              '고대비는 새 접근성 모드에서 재계산합니다. 원본의 7:1 보정 색과 차이가 날 수 있습니다.',
            );
          break;
        case 'motion':
          project.accessibility.reducedMotion = finite(value, 0, 1, 'motion') === 0;
          break;
        case 'shadow':
          finite(value, 0, 1, 'shadow');
          for (const mode of modes) project.overrides[mode]['legacy.view.shadow'] = value as number;
          unsupported.add(
            '그림자 보기 값은 원값만 보존하며 새 화면 그림자와 직접 연결하지 않습니다.',
          );
          break;
        case 'density':
          if (!['compact', 'comfortable'].includes(String(value)))
            throw new Error('알 수 없는 기존 밀도 값입니다.');
          for (const mode of modes) project.overrides[mode]['legacy.view.density'] = String(value);
          unsupported.add('표 밀도는 원값만 보존합니다. 현재 레이아웃 간격은 별도로 조정하세요.');
          break;
        default:
          unsupported.add('변환하지 않은 보기 항목: ' + key);
      }
    }
  }
  if (rawTokens || dtcg) {
    const consumed = new Set<string>();
    function resolve(key: string, mode: Mode, stack = new Set<string>()): unknown {
      if (stack.has(key) || stack.size > 64)
        throw new Error('기존 토큰에 순환 참조가 있습니다: ' + key);
      const node = at(input, key);
      if (!object(node) || !Object.hasOwn(node, '$value'))
        throw new Error('참조 토큰을 찾을 수 없습니다: ' + key);
      consumed.add(key);
      const next = new Set(stack);
      next.add(key);
      const value = at(node, `$extensions.mode.${mode}`) ?? node.$value;
      if (typeof value === 'string') {
        const ref = value.match(/^\{([\w.-]+)\}$/);
        if (ref) return resolve(ref[1], mode, next);
      }
      return value;
    }
    for (const mode of modes) {
      for (const key of Object.keys(input.color as Obj).filter((k) => !k.startsWith('$'))) {
        const full = 'color.' + key;
        if (object(at(input, full)) && Object.hasOwn(at(input, full) as Obj, '$value'))
          assignColor(key, resolve(full, mode), mode);
      }
      for (const [legacy, current] of [
        ['radius.container', 'radius.card'],
        ['rounded.container', 'radius.card'],
        ['space.6', 'space.base'],
        ['spacing.s6', 'space.base'],
        ['motion.duration.base', 'motion.duration'],
      ] as const) {
        if (object(at(input, legacy)))
          project.overrides[mode][current] = dimension(resolve(legacy, mode), legacy);
      }
      if (object(at(input, 'font.sans'))) {
        project.brand.font = safeFont(resolve('font.sans', mode));
        project.overrides[mode]['font.family'] = project.brand.font;
      }
      for (const [legacy, current] of [
        ['typography.title', 'font.title'],
        ['typography.body', 'font.body'],
      ] as const) {
        if (!object(at(input, legacy))) continue;
        const value = resolve(legacy, mode);
        if (!object(value)) throw new Error('기존 타이포그래피 값이 객체가 아닙니다.');
        const size = dimension(value.fontSize, legacy + '.fontSize');
        if (size < 1 || size > 1000) throw new Error('기존 글자 크기가 지원 범위를 벗어납니다.');
        project.overrides[mode][current] = size;
        if (legacy === 'typography.body') {
          if (typeof value.lineHeightRatio === 'number')
            project.overrides[mode]['font.lineHeight'] = finite(
              value.lineHeightRatio,
              0.5,
              4,
              'lineHeightRatio',
            );
          else if (typeof value.lineHeight === 'number')
            project.overrides[mode]['font.lineHeight'] = finite(
              value.lineHeight / size,
              0.5,
              4,
              'lineHeight',
            );
          if (value.fontFamily !== undefined) {
            const ref =
              typeof value.fontFamily === 'string'
                ? value.fontFamily.match(/^\{([\w.-]+)\}$/)
                : null;
            project.brand.font = safeFont(ref ? resolve(ref[1], mode) : value.fontFamily);
            project.overrides[mode]['font.family'] = project.brand.font;
          }
        }
      }
    }
    function scan(value: unknown, prefix = '') {
      if (!object(value)) return;
      if (Object.hasOwn(value, '$value')) {
        if (!consumed.has(prefix) && !prefix.startsWith('primitive.'))
          unsupported.add('변환하지 않은 토큰: ' + prefix);
        return;
      }
      for (const [key, child] of Object.entries(value))
        if (
          !key.startsWith('$') &&
          !['components', 'contrastPairs', 'typeScaleViews'].includes(key)
        )
          scan(child, prefix ? prefix + '.' + key : key);
    }
    scan(input);
    project.brand.color = String(project.overrides.light['color.accent'] ?? project.brand.color);
    if (dtcg && !rawTokens)
      warnings.push(
        '이 DTCG 파일에는 단일 모드 값만 있습니다. 가져온 값은 라이트·다크에 함께 보존했습니다.',
      );
    if (input.components)
      warnings.push(
        '기존 컴포넌트별 토큰 배정 규칙은 새 편집 컴포넌트에 자동 이식하지 않았습니다.',
      );
    if (input.contrastPairs) warnings.push('기존 대비 쌍 목록은 새 검사 목록으로 대체됩니다.');
  }
  if (overrides || savedState) {
    for (const mode of modes) {
      const edits = (input.edits as Obj)[mode] ?? {};
      if (!object(edits)) throw new Error('기존 edits.' + mode + '는 객체여야 합니다.');
      for (const [key, value] of Object.entries(edits)) assignColor(key, value, mode);
    }
    if (savedState) {
      project.mode = input.mode as Mode;
      const view = String(input.view);
      if (view === 'custom') applyView(input.custom ?? {});
      else if (viewPresets[view]) applyView(viewPresets[view]);
      else throw new Error('알 수 없는 기존 보기: ' + view);
      if (input.cvd && input.cvd !== 'none')
        warnings.push('색각 미리보기 필터는 가져오지 않았습니다.');
    } else if (object(input.customView)) {
      applyView(input.customView.knobs);
      warnings.push(
        '원본 변경분 파일은 선택한 보기를 기록하지 않습니다. 포함된 customView 조절값을 가져와 적용했습니다.',
      );
    }
    project.brand.color = String(project.overrides.light['color.accent'] ?? project.brand.color);
    warnings.push(
      '변경분에 없는 값은 v2/v3 기본 업무 테마에서 시작합니다. 기존 HTML 화면·문서 내용은 포함하지 않습니다.',
    );
  }
  if (brand) {
    project.brand.name = String(input.name).slice(0, 200);
    project.brand.color = hex((input.colors as Obj).brand);
    project.brand.font = safeFont((input.fonts as Obj).text ?? (input.fonts as Obj).display);
    warnings.push(
      '브랜드 이름·색·본문 글꼴을 가져왔습니다. 로고 파일, 개성·문체·이미지 지침은 원본을 별도로 참고하세요.',
    );
    for (const key of Object.keys(input))
      if (!['id', 'name', 'colors', 'fonts'].includes(key))
        unsupported.add('변환하지 않은 브랜드 자료: ' + key);
  }
  for (const warning of unsupported) warnings.push(warning);
  warnings.push(
    '기존 파일의 HTML·실행 스크립트·미디어는 생성하지 않습니다. 기본 편집 템플릿에 가져온 스타일을 적용했습니다.',
  );
  project.customStyles[0].accent = project.brand.color;
  return { project: ProjectSchema.parse(project), warnings: [...new Set(warnings)] };
}
