import type { MotionScene, StudioElement } from '../core/types';

export const MOTION_PRESETS = [
  { id: 'landscape', name: '가로 16:9 · 1080p', width: 1920, height: 1080, fps: 30 },
  { id: 'portrait', name: '세로 9:16 · 1080p', width: 1080, height: 1920, fps: 30 },
  { id: 'square', name: '정사각형 · 1080p', width: 1080, height: 1080, fps: 30 },
  { id: 'preview', name: '가벼운 가로 · 720p', width: 1280, height: 720, fps: 30 },
];
export const SCENE_TEMPLATES = [
  { id: 'title', name: '타이틀', description: '제목과 부제로 시작하는 장면' },
  { id: 'lower-third', name: '이름 자막', description: '인물·프로젝트 이름과 설명' },
  { id: 'quote', name: '인용문', description: '문장 하나를 강조하는 구성' },
  { id: 'statistics', name: '수치 강조', description: '핵심 수치와 표준 막대 차트' },
  { id: 'comparison', name: '비교표', description: '항목별 이전·이후 비교' },
  { id: 'closing', name: '마무리', description: '다음 행동과 브랜드 이름' },
];
export const uid = () =>
  globalThis.crypto?.randomUUID?.() ??
  'motion-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
export function makeScene(template: string, width = 1920, height = 1080, fps = 30): MotionScene {
  const sx = width / 1920,
    sy = height / 1080,
    unit = Math.min(sx, sy),
    vertical = height > width,
    margin = width * 0.07;
  const elements: StudioElement[] = [];
  const add = (e: Omit<StudioElement, 'id'>) => elements.push({ id: uid(), ...e });
  const text = (
    text: string,
    x: number,
    y: number,
    w: number,
    h: number,
    size: number,
    effect = 'slide-up',
    color?: string,
  ) => add({ type: 'text', text, x, y, w, h, fontSize: size, fontWeight: 700, effect, color });
  const titleSize = (vertical ? 86 : 92) * unit;
  if (template === 'title') {
    add({
      type: 'shape',
      shape: 'rect',
      x: margin,
      y: height * 0.22,
      w: 96 * unit,
      h: 10 * unit,
      fill: '$color.accent',
      effect: 'wipe-left',
    });
    text(
      '나의 이야기를\n시작합니다',
      margin,
      height * 0.3,
      width - margin * 2,
      height * 0.33,
      titleSize,
    );
    text(
      '디자인으로 전하는 명확한 메시지',
      margin,
      height * 0.69,
      width - margin * 2,
      120 * unit,
      34 * unit,
      'fade-in',
      '$color.muted',
    );
  } else if (template === 'lower-third') {
    add({
      type: 'shape',
      shape: 'rect',
      x: margin,
      y: height * 0.68,
      w: width - margin * 2,
      h: height * 0.2,
      fill: '$color.surface',
      effect: 'wipe-left',
    });
    add({
      type: 'shape',
      shape: 'rect',
      x: margin,
      y: height * 0.68,
      w: 10 * unit,
      h: height * 0.2,
      fill: '$color.accent',
      effect: 'fade-in',
    });
    text(
      '프로젝트 이름',
      margin + 40 * unit,
      height * 0.705,
      width - margin * 2 - 80 * unit,
      80 * unit,
      52 * unit,
      'slide-up',
    );
    text(
      '역할 · 소속 · 짧은 소개',
      margin + 40 * unit,
      height * 0.805,
      width - margin * 2 - 80 * unit,
      64 * unit,
      28 * unit,
      'fade-in',
      '$color.muted',
    );
  } else if (template === 'quote') {
    text(
      '“',
      margin,
      height * 0.13,
      200 * unit,
      180 * unit,
      180 * unit,
      'scale-in',
      '$color.accent',
    );
    text(
      '좋은 디자인은\n생각을 명확하게 만듭니다.',
      margin,
      height * 0.35,
      width - margin * 2,
      height * 0.4,
      64 * unit,
      'word-reveal',
    );
    text(
      '— 출처를 적어 주세요',
      margin,
      height * 0.8,
      width - margin * 2,
      64 * unit,
      28 * unit,
      'fade-in',
      '$color.muted',
    );
  } else if (template === 'statistics') {
    text('변화를 보여 주는 숫자', margin, height * 0.09, width - margin * 2, 110 * unit, 60 * unit);
    text(
      '42%',
      margin,
      height * 0.26,
      width * 0.42,
      180 * unit,
      150 * unit,
      'scale-in',
      '$color.accent',
    );
    text(
      '샘플 데이터 · 실제 값으로 교체',
      margin,
      height * 0.49,
      width - margin * 2,
      80 * unit,
      26 * unit,
      'fade-in',
      '$color.muted',
    );
    add({
      type: 'chart',
      x: margin,
      y: height * 0.62,
      w: width - margin * 2,
      h: height * 0.28,
      chartData: { type: 'bar', labels: ['이전', '현재', '목표'], values: [34, 61, 82] },
      effect: 'wipe-up',
    });
  } else if (template === 'comparison') {
    text('이전과 이후', margin, height * 0.11, width - margin * 2, 120 * unit, 72 * unit);
    add({
      type: 'table',
      x: margin,
      y: height * 0.33,
      w: width - margin * 2,
      h: height * 0.42,
      tableData: [
        ['항목', '이전', '이후'],
        ['일관성', '개별 설정', '통합 토큰'],
        ['수정', '반복 작업', '한 번에 반영'],
        ['전달', '이미지', '편집 가능한 결과'],
      ],
      effect: 'fade-in',
      fontSize: 32 * unit,
    });
    text(
      '비교 데이터는 예시입니다',
      margin,
      height * 0.83,
      width - margin * 2,
      64 * unit,
      26 * unit,
      'fade-in',
      '$color.muted',
    );
  } else {
    text(
      '다음 이야기를\n함께 만듭니다',
      margin,
      height * 0.24,
      width - margin * 2,
      height * 0.38,
      titleSize,
      'scale-in',
    );
    add({
      type: 'shape',
      shape: 'rect',
      x: margin,
      y: height * 0.72,
      w: width - margin * 2,
      h: height * 0.12,
      fill: '$color.accent',
      effect: 'wipe-left',
    });
    text(
      '나의 브랜드 · 연락처',
      margin + 32 * unit,
      height * 0.735,
      width - margin * 2 - 64 * unit,
      height * 0.09,
      36 * unit,
      'fade-in',
      '$color.onAccent',
    );
  }
  return {
    id: uid(),
    name: SCENE_TEMPLATES.find((t) => t.id === template)?.name ?? '새 장면',
    template,
    durationFrames: Math.max(1, Math.round(fps * 5)),
    effect: 'none',
    elements,
  };
}

/** SRT timestamps are seconds, so changing project FPS preserves subtitle timing. */
export function parseSrt(source: string): { start: number; end: number; text: string }[] {
  const timestamp = (value: string) => {
    const m = value.match(/^\s*(\d{1,3}):([0-5]\d):([0-5]\d)[,.](\d{3})(?:\s|$)/);
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000 : NaN;
  };
  const result = [];
  for (const block of source
    .replace(/^\uFEFF/, '')
    .replace(/\r/g, '')
    .trim()
    .split(/\n\s*\n/)) {
    const lines = block.split('\n'),
      index = lines.findIndex((l) => l.includes('-->'));
    if (index < 0) continue;
    const [left, right] = lines[index].split('-->'),
      start = timestamp(left),
      end = timestamp(right),
      text = lines
        .slice(index + 1)
        .join('\n')
        .replace(/<[^>]*>/g, '')
        .trim();
    if (Number.isFinite(start) && Number.isFinite(end) && end > start && text)
      result.push({ start, end, text });
  }
  return result.sort((a, b) => a.start - b.start);
}
