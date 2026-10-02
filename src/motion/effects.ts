import type { Keyframe, StudioElement, MotionScene, EffectSettings } from '../core/types';

export type EffectCategory =
  | 'entrance'
  | 'exit'
  | 'emphasis'
  | 'text'
  | 'background'
  | 'transition';
export interface EffectPreset {
  id: string;
  name: string;
  category: EffectCategory;
  description: string;
}
export const EFFECT_CATEGORIES: Record<EffectCategory, string> = {
  entrance: '등장',
  exit: '퇴장',
  emphasis: '강조',
  text: '타이포',
  background: '배경',
  transition: '전환',
};
export const EFFECTS: EffectPreset[] = [
  ['fade-in', '페이드 인', 'entrance', '투명도 0 → 1'],
  ['slide-up', '아래에서 등장', 'entrance', '아래 48px에서 제자리로'],
  ['scale-in', '확대 등장', 'entrance', '크기 85% → 100%'],
  ['blur-in', '초점 등장', 'entrance', '흐림 16px → 0'],
  ['fade-out', '페이드 아웃', 'exit', '마지막 구간에서 사라짐'],
  ['slide-down', '아래로 퇴장', 'exit', '아래로 48px 이동'],
  ['scale-out', '축소 퇴장', 'exit', '크기 100% → 85%'],
  ['blur-out', '초점 퇴장', 'exit', '마지막 구간에서 흐려짐'],
  ['pulse', '펄스', 'emphasis', '크기가 부드럽게 강조됨'],
  ['breathe', '숨쉬기', 'emphasis', '투명도가 잔잔히 바뀜'],
  ['wobble', '기울임', 'emphasis', '좌우 3도 회전'],
  ['bounce', '바운스', 'emphasis', '가볍게 위아래 움직임'],
  ['typewriter', '타이핑', 'text', '글자 단위로 나타남'],
  ['word-reveal', '단어 등장', 'text', '단어 단위로 나타남'],
  ['tracking', '자간 모으기', 'text', '자간 12px → 0'],
  ['text-rise', '제목 올리기', 'text', '클리핑과 상승을 함께 적용'],
  ['pan-left', '왼쪽 팬', 'background', '전체 구간에 걸친 왼쪽 이동'],
  ['pan-right', '오른쪽 팬', 'background', '전체 구간에 걸친 오른쪽 이동'],
  ['slow-zoom', '느린 확대', 'background', '전체 구간에 걸친 8% 확대'],
  ['float', '부유', 'background', '일정한 위아래 움직임'],
  ['wipe-left', '왼쪽 와이프', 'transition', '왼쪽부터 드러남'],
  ['wipe-right', '오른쪽 와이프', 'transition', '오른쪽부터 드러남'],
  ['wipe-up', '위로 와이프', 'transition', '아래부터 드러남'],
  ['iris', '원형 열기', 'transition', '중앙에서 원형으로 드러남'],
].map(([id, name, category, description]) => ({
  id,
  name,
  category: category as EffectCategory,
  description,
}));

export interface MotionValues {
  x: number;
  y: number;
  opacity: number;
  rotation: number;
  scale: number;
  color?: string;
  blur: number;
  clipPath?: string;
  letterSpacing: number;
  visibleProgress: number;
  wordReveal: boolean;
  visible: boolean;
}
export const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));
export function ease(t: number, easing: Keyframe['easing'] = 'linear') {
  t = clamp(t);
  return easing === 'easeIn'
    ? t * t * t
    : easing === 'easeOut'
      ? 1 - Math.pow(1 - t, 3)
      : easing === 'easeInOut'
        ? t < 0.5
          ? 4 * t * t * t
          : 1 - Math.pow(-2 * t + 2, 3) / 2
        : t;
}
function mixColor(a: string, b: string, t: number): string {
  const expand = (v: string) =>
    /^#[\da-f]{3}$/i.test(v)
      ? '#' +
        v
          .slice(1)
          .split('')
          .map((c) => c + c)
          .join('')
      : v;
  a = expand(a);
  b = expand(b);
  if (!/^#[\da-f]{6}$/i.test(a) || !/^#[\da-f]{6}$/i.test(b)) return t < 1 ? a : b;
  return (
    '#' +
    [1, 3, 5]
      .map((i) =>
        Math.round(
          parseInt(a.slice(i, i + 2), 16) +
            (parseInt(b.slice(i, i + 2), 16) - parseInt(a.slice(i, i + 2), 16)) * t,
        )
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}
export function sampleKeyframes(
  keys: Keyframe[],
  frame: number,
  property: Keyframe['property'],
  fallback: number | string,
): number | string {
  const sorted = keys
    .filter((k) => k.property === property && Number.isFinite(k.frame))
    .sort((a, b) => a.frame - b.frame);
  if (!sorted.length) return fallback;
  if (frame <= sorted[0].frame) return sorted[0].value;
  for (let i = 1; i < sorted.length; i++) {
    const left = sorted[i - 1],
      right = sorted[i];
    if (frame <= right.frame) {
      const t = ease((frame - left.frame) / Math.max(1, right.frame - left.frame), right.easing);
      return typeof left.value === 'number' && typeof right.value === 'number'
        ? left.value + (right.value - left.value) * t
        : mixColor(String(left.value), String(right.value), t);
    }
  }
  return sorted[sorted.length - 1].value;
}

/** Every value is derived only from frame and saved inputs; no wall clock or CSS animation. */
function baseEffect(
  effect: string | undefined,
  frame: number,
  durationFrames: number,
  fps = 30,
  curve?: Keyframe['easing'],
): Partial<MotionValues> {
  const d = Math.max(1, durationFrames),
    fade = Math.max(1, Math.min(Math.round(fps * 0.6), Math.floor(d / 2))),
    p = ease(frame / fade, curve ?? 'easeOut'),
    out = ease((frame - (d - fade)) / fade, curve ?? 'easeIn'),
    whole = ease(frame / Math.max(1, d - 1), curve ?? 'linear');
  const wave = Math.sin((frame / Math.max(1, fps)) * Math.PI * 2);
  switch (effect) {
    case 'fade-in':
      return { opacity: p };
    case 'slide-up':
      return { opacity: p, y: 48 * (1 - p) };
    case 'scale-in':
      return { opacity: p, scale: 0.85 + 0.15 * p };
    case 'blur-in':
      return { opacity: p, blur: 16 * (1 - p) };
    case 'fade-out':
      return { opacity: 1 - out };
    case 'slide-down':
      return { opacity: 1 - out, y: 48 * out };
    case 'scale-out':
      return { opacity: 1 - out, scale: 1 - 0.15 * out };
    case 'blur-out':
      return { opacity: 1 - out, blur: 16 * out };
    case 'pulse':
      return { scale: 1 + 0.035 * wave };
    case 'breathe':
      return { opacity: 0.85 + 0.15 * wave };
    case 'wobble':
      return { rotation: 3 * wave };
    case 'bounce':
      return { y: -16 * Math.abs(wave) };
    case 'typewriter':
      return { visibleProgress: ease(frame / Math.max(1, d * 0.6), curve ?? 'linear') };
    case 'word-reveal':
      return {
        visibleProgress: ease(frame / Math.max(1, d * 0.6), curve ?? 'linear'),
        wordReveal: true,
      };
    case 'tracking':
      return { opacity: p, letterSpacing: 12 * (1 - p) };
    case 'text-rise':
      return { y: 32 * (1 - p), clipPath: `inset(${(1 - p) * 100}% 0 0 0)` };
    case 'pan-left':
      return { x: -40 * whole, scale: 1.06 };
    case 'pan-right':
      return { x: 40 * whole, scale: 1.06 };
    case 'slow-zoom':
      return { scale: 1 + whole * 0.08 };
    case 'float':
      return { y: Math.sin((frame / Math.max(1, fps)) * Math.PI) * 12 };
    case 'wipe-left':
      return { clipPath: `inset(0 ${(1 - p) * 100}% 0 0)` };
    case 'wipe-right':
      return { clipPath: `inset(0 0 0 ${(1 - p) * 100}%)` };
    case 'wipe-up':
      return { clipPath: `inset(${(1 - p) * 100}% 0 0 0)` };
    case 'iris':
      return { clipPath: `circle(${p * 72}% at 50% 50%)` };
    default:
      return {};
  }
}

export function computeEffect(
  effect: string | undefined,
  frame: number,
  durationFrames: number,
  fps = 30,
  settings?: EffectSettings,
): Partial<MotionValues> {
  if (!settings) return baseEffect(effect, frame, durationFrames, fps);
  const intensity = clamp(settings.intensity ?? 1, 0, 2);
  if (intensity === 0) return {};
  const preset = EFFECTS.find((item) => item.id === effect),
    d = Math.max(1, durationFrames),
    delay = settings.delayFrames ?? 0,
    local = frame - delay,
    fade = Math.max(1, Math.min(Math.round(fps * 0.6), Math.floor(d / 2))),
    length = settings.durationFrames;
  if (local < 0 && ['exit', 'background', 'emphasis'].includes(preset?.category ?? '')) return {};
  let sampled = local;
  if (length) {
    if (preset?.category === 'exit') sampled = d - fade + ((local - (d - length)) * fade) / length;
    else if (effect === 'typewriter' || effect === 'word-reveal')
      sampled = (Math.max(0, local) * Math.max(1, d * 0.6)) / length;
    else if (preset?.category === 'emphasis' || effect === 'float')
      sampled = (Math.max(0, local) * (effect === 'float' ? fps * 2 : fps)) / length;
    else if (preset?.category === 'background')
      sampled = (Math.max(0, local) * Math.max(1, d - 1)) / length;
    else sampled = (Math.max(0, local) * fade) / length;
  }
  const fx = baseEffect(effect, sampled, d, fps, settings.easing);
  if (fx.opacity !== undefined) fx.opacity = clamp(1 + (fx.opacity - 1) * intensity);
  if (fx.scale !== undefined) fx.scale = Math.max(0.001, 1 + (fx.scale - 1) * intensity);
  for (const key of ['x', 'y', 'rotation', 'blur', 'letterSpacing'] as const)
    if (fx[key] !== undefined) fx[key]! *= intensity;
  if (fx.visibleProgress !== undefined)
    fx.visibleProgress = clamp(1 + (fx.visibleProgress - 1) * intensity);
  if (fx.clipPath?.startsWith('inset('))
    fx.clipPath = fx.clipPath.replace(
      /([\d.]+)%/g,
      (_, value) => `${clamp(Number(value) * intensity, 0, 100)}%`,
    );
  if (fx.clipPath?.startsWith('circle('))
    fx.clipPath = fx.clipPath.replace(
      /circle\(([\d.]+)%/,
      (_, value) => `circle(${72 - (72 - Number(value)) * Math.min(1, intensity)}%`,
    );
  if (settings.direction && settings.direction !== 'auto') {
    const angles = { right: 0, down: 90, left: 180, up: -90 },
      defaults: Record<string, number> = {
        'slide-up': 90,
        'slide-down': 90,
        'text-rise': 90,
        'pan-left': 180,
        'pan-right': 0,
        bounce: -90,
        float: 90,
      };
    if (effect && effect in defaults) {
      const inverse = effect === 'slide-up' || effect === 'text-rise' ? 180 : 0,
        angle = ((angles[settings.direction] + inverse - defaults[effect]) * Math.PI) / 180,
        x = fx.x ?? 0,
        y = fx.y ?? 0;
      fx.x = x * Math.cos(angle) - y * Math.sin(angle);
      fx.y = x * Math.sin(angle) + y * Math.cos(angle);
    }
    if (effect?.startsWith('wipe-') && fx.clipPath) {
      const amount = fx.clipPath.match(/([\d.]+)%/)?.[1] ?? '0';
      fx.clipPath =
        settings.direction === 'left'
          ? `inset(0 ${amount}% 0 0)`
          : settings.direction === 'right'
            ? `inset(0 0 0 ${amount}%)`
            : settings.direction === 'up'
              ? `inset(${amount}% 0 0 0)`
              : `inset(0 0 ${amount}% 0)`;
    }
  }
  return fx;
}

export function evaluateElement(
  element: StudioElement,
  frame: number,
  durationFrames: number,
  fps = 30,
  reducedMotion = false,
): MotionValues {
  const start = Math.max(0, element.startFrame ?? 0),
    end = Math.min(durationFrames, element.endFrame ?? durationFrames),
    local = frame - start;
  const keys = element.keyframes ?? [];
  const numeric = (property: Keyframe['property'], fallback: number) =>
    Number(sampleKeyframes(keys, reducedMotion ? start : frame, property, fallback));
  const fx = reducedMotion
    ? {}
    : computeEffect(element.effect, local, end - start, fps, element.effectSettings);
  return {
    x: numeric('x', element.x) + (fx.x ?? 0),
    y: numeric('y', element.y) + (fx.y ?? 0),
    opacity: clamp(numeric('opacity', element.opacity ?? 1) * (fx.opacity ?? 1)),
    rotation: numeric('rotation', element.rotation ?? 0) + (fx.rotation ?? 0),
    scale: numeric('scale', 1) * (fx.scale ?? 1),
    color:
      String(sampleKeyframes(keys, reducedMotion ? start : frame, 'color', element.color ?? '')) ||
      undefined,
    blur: fx.blur ?? 0,
    clipPath: fx.clipPath,
    letterSpacing: fx.letterSpacing ?? 0,
    visibleProgress: fx.visibleProgress ?? 1,
    wordReveal: fx.wordReveal ?? false,
    visible: frame >= start && frame < end,
  };
}

export function visibleText(text: string, progress: number, words = false): string {
  const parts = words ? text.split(/(\s+)/) : Array.from(text);
  return parts.slice(0, Math.ceil(parts.length * clamp(progress))).join('');
}

/** Keep clips and endpoint keys usable when the scene is shortened. */
export function resizeSceneDuration(scene: MotionScene, durationFrames: number): MotionScene {
  const duration = Math.max(1, Math.min(36000, Math.round(durationFrames)));
  return {
    ...scene,
    durationFrames: duration,
    elements: scene.elements.map((element) => {
      const startFrame = Math.min(element.startFrame ?? 0, duration - 1),
        endFrame = Math.max(
          startFrame + 1,
          Math.min(
            element.endFrame === scene.durationFrames ? duration : (element.endFrame ?? duration),
            duration,
          ),
        );
      const keys = new Map<string, Keyframe>();
      for (const key of [...(element.keyframes ?? [])].sort((a, b) => a.frame - b.frame)) {
        const clamped = { ...key, frame: Math.min(key.frame, duration - 1) };
        keys.set(`${clamped.property}:${clamped.frame}`, clamped);
      }
      return {
        ...element,
        startFrame: element.startFrame === undefined ? undefined : startFrame,
        endFrame: element.endFrame === undefined ? undefined : endFrame,
        keyframes: element.keyframes
          ? [...keys.values()].sort((a, b) => a.frame - b.frame)
          : undefined,
      };
    }),
  };
}
