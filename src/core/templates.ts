import type { Project, Slide, StudioElement, WebPage, WebSection } from './types';
export const uid = () => crypto.randomUUID();
export const SLIDE_LAYOUTS = [
  { id: 'cover', name: '표지' },
  { id: 'section', name: '섹션 구분' },
  { id: 'summary', name: '핵심 요약' },
  { id: 'body', name: '제목 + 본문' },
  { id: 'compare', name: '2열 비교' },
  { id: 'image', name: '이미지 + 설명' },
  { id: 'kpi', name: 'KPI' },
  { id: 'chart', name: '차트' },
  { id: 'table', name: '표' },
  { id: 'timeline', name: '타임라인' },
  { id: 'process', name: '프로세스' },
  { id: 'closing', name: '마무리' },
];
const text = (
  x: number,
  y: number,
  w: number,
  h: number,
  value: string,
  size = 28,
  extra: Partial<StudioElement> = {},
): StudioElement => ({
  id: uid(),
  type: 'text',
  x,
  y,
  w,
  h,
  text: value,
  fontSize: size,
  color: '{color.text}',
  ...extra,
});
const shape = (
  x: number,
  y: number,
  w: number,
  h: number,
  fill = '{color.accent}',
): StudioElement => ({ id: uid(), type: 'shape', x, y, w, h, fill });
export function makeSlide(layout = 'cover', brand = '나의 디자인', index = 0): Slide {
  let elements: StudioElement[] = [
    text(56, 50, 848, 64, SLIDE_LAYOUTS.find((l) => l.id === layout)?.name || '새 슬라이드', 38, {
      fontWeight: 700,
    }),
    shape(56, 126, 64, 4),
    text(56, 492, 760, 20, brand, 12, { color: '{color.muted}' }),
  ];
  if (layout === 'cover')
    elements = [
      text(58, 52, 600, 26, 'DESIGN / PORTFOLIO', 14, { color: '{color.accent}', fontWeight: 600 }),
      text(58, 153, 620, 158, '생각을 디자인으로,\n디자인을 경험으로.', 54, { fontWeight: 700 }),
      text(62, 350, 650, 54, '같은 브랜드에서 시작하는 프레젠테이션, 웹, 모션.', 21, {
        color: '{color.muted}',
      }),
      shape(744, 137, 148, 258, '{color.surface}'),
      shape(776, 176, 84, 84),
      shape(776, 292, 84, 5),
      text(62, 476, 500, 22, brand, 14),
    ];
  else if (layout === 'section')
    elements = [
      text(58, 74, 700, 34, `SECTION ${String(index + 1).padStart(2, '0')}`, 16, {
        color: '{color.accent}',
      }),
      text(58, 205, 830, 104, '더 나은 경험을\n만드는 과정', 52, { fontWeight: 700 }),
      shape(58, 416, 160, 5),
    ];
  else if (layout === 'summary' || layout === 'process')
    for (let i = 0; i < 3; i++) {
      elements.push(
        shape(56 + i * 292, 174, 264, 242, '{color.surface}'),
        text(76 + i * 292, 193, 216, 42, `0${i + 1}`, 28, {
          color: '{color.accent}',
          fontWeight: 700,
        }),
        text(76 + i * 292, 262, 216, 46, ['관찰합니다', '연결합니다', '완성합니다'][i], 27, {
          fontWeight: 600,
        }),
        text(
          76 + i * 292,
          325,
          216,
          62,
          [
            '문제와 사용자를\n정확히 이해합니다.',
            '콘텐츠와 디자인의\n관계를 설계합니다.',
            '실제 결과물로 만들고\n사용성을 확인합니다.',
          ][i],
          18,
          { color: '{color.muted}' },
        ),
      );
    }
  else if (layout === 'compare') {
    for (let i = 0; i < 2; i++)
      elements.push(
        shape(56 + i * 440, 168, 408, 272, '{color.surface}'),
        text(80 + i * 440, 188, 352, 40, ['기존 경험', '새로운 경험'][i], 28, { fontWeight: 700 }),
        text(
          80 + i * 440,
          266,
          346,
          135,
          [
            '각 도구에서 별도로 제작\n스타일을 반복해서 설정\n수작업으로 결과물 확인',
            '하나의 브랜드로 제작\n매체에 맞는 템플릿 활용\n검사 결과와 함께 출력',
          ][i],
          22,
          { color: i ? '{color.accent}' : '{color.muted}' },
        ),
      );
  } else if (layout === 'kpi') {
    ['24', '6', '3'].forEach((v, i) =>
      elements.push(
        text(56 + i * 290, 193, 256, 108, v, 78, { fontWeight: 700, color: '{color.accent}' }),
        text(56 + i * 290, 331, 256, 42, ['모션 효과', '디자인 스타일', '제작 매체'][i], 23),
        text(56 + i * 290, 388, 256, 28, '라이브러리 구성 예시', 14, { color: '{color.muted}' }),
      ),
    );
  } else if (layout === 'chart')
    elements.push(
      {
        id: uid(),
        type: 'chart',
        x: 70,
        y: 166,
        w: 820,
        h: 280,
        chartData: {
          type: 'bar',
          labels: ['1월', '2월', '3월', '4월', '5월'],
          values: [28, 42, 38, 65, 82],
        },
      },
      text(70, 450, 820, 24, '예시 데이터 · 단위: 건', 13, { color: '{color.muted}' }),
    );
  else if (layout === 'table')
    elements.push({
      id: uid(),
      type: 'table',
      x: 56,
      y: 172,
      w: 848,
      h: 256,
      tableData: [
        ['제작물', '주요 내용', '상태'],
        ['프레젠테이션', '편집 가능한 장표', '검토 중'],
        ['웹사이트', '반응형 페이지', '진행 중'],
        ['모션그래픽', '브랜드 영상', '기획 중'],
      ],
    });
  else if (layout === 'timeline') {
    elements.push(shape(88, 275, 784, 3, '{color.border}'));
    ['발견', '설계', '제작', '검증'].forEach((v, i) =>
      elements.push(
        shape(88 + i * 238, 258, 28, 28),
        text(74 + i * 238, 186, 176, 46, `0${i + 1}`, 28, { color: '{color.accent}' }),
        text(74 + i * 238, 321, 176, 42, v, 27, { fontWeight: 600 }),
      ),
    );
  } else if (layout === 'image')
    elements.push(
      shape(56, 163, 444, 284, '{color.surface}'),
      text(91, 269, 372, 52, '이미지를 추가하세요', 24, { color: '{color.muted}' }),
      text(546, 174, 352, 73, '장면이 전달하는\n이야기', 33, { fontWeight: 700 }),
      text(
        546,
        297,
        342,
        135,
        '자산에서 이미지를 선택하고 설명을 작성하세요. 이미지와 텍스트는 각각 편집할 수 있습니다.',
        23,
        { color: '{color.muted}' },
      ),
    );
  else if (layout === 'closing')
    elements = [
      text(58, 126, 844, 136, '다음 장면을\n함께 만듭니다.', 56, { fontWeight: 700 }),
      text(62, 333, 800, 44, brand, 25, { color: '{color.accent}' }),
      text(62, 402, 800, 32, '연락처를 입력하세요', 18, { color: '{color.muted}' }),
    ];
  else
    elements.push(
      text(
        56,
        173,
        814,
        203,
        '전달할 핵심 메시지를 입력하세요.\n\n이유와 근거를 구체적으로 설명하고,\n읽는 사람이 다음 행동을 알 수 있도록 작성합니다.',
        27,
      ),
    );
  return {
    id: uid(),
    name: SLIDE_LAYOUTS.find((l) => l.id === layout)?.name || '새 장표',
    layout,
    hidden: false,
    notes: '',
    elements,
  };
}
export function makeSection(type: WebSection['type']): WebSection {
  const copy: Record<string, [string, string]> = {
    hero: [
      '생각을 경험으로 만듭니다.',
      '브랜드의 본질을 찾아, 읽히고 움직이는 디자인으로 연결합니다.',
    ],
    features: [
      '작은 디테일에서 시작합니다.',
      '명확한 구조와 일관된 표현으로 브랜드의 이야기를 전달합니다.',
    ],
    projects: ['선택한 작업', '문제의 발견부터 완성까지, 작업에 담긴 생각을 살펴보세요.'],
    about: [
      '디자인의 이유를 찾습니다.',
      '화려함보다 맥락을 먼저 봅니다. 사용자와 비즈니스가 만나는 지점을 설계합니다.',
    ],
    stats: ['이번 달의 흐름', '프로젝트 데이터 · 예시'],
    table: ['프로젝트 현황', '행을 선택하면 상세 정보를 볼 수 있습니다.'],
    chart: ['진행 추이', '기간별 수치 · 예시 데이터'],
    faq: ['자주 묻는 질문', '궁금한 내용을 확인하세요.'],
    contact: ['다음 프로젝트를 이야기해요.', '연락처를 입력하고 문의 연결을 설정하세요.'],
    pricing: ['필요에 맞는 구성', '프로젝트의 범위에 맞게 선택하세요.'],
  };
  return {
    id: uid(),
    type,
    title: copy[type][0],
    body: copy[type][1],
    enabled: true,
    columns: type === 'hero' ? 1 : 3,
    items: [
      { title: '브랜드 디자인', body: '핵심을 담는 일관된 시각 언어' },
      { title: '디지털 경험', body: '자연스럽게 이어지는 사용자 흐름' },
      { title: '모션 이야기', body: '시간 속에서 전달되는 메시지' },
    ],
  };
}
export function makeWebPage(kind: WebPage['kind']): WebPage {
  const types: Record<WebPage['kind'], WebSection['type'][]> = {
    portfolio: ['hero', 'projects', 'about', 'contact'],
    landing: ['hero', 'features', 'projects', 'pricing', 'faq', 'contact'],
    dashboard: ['stats', 'chart', 'table'],
  };
  return {
    id: uid(),
    name: { portfolio: '포트폴리오', landing: '랜딩페이지', dashboard: '데이터 대시보드' }[kind],
    kind,
    title: '나의 디자인 스튜디오',
    description: '브랜드와 경험을 연결하는 디자인 작업.',
    sections: types[kind].map(makeSection),
  };
}
export function createProject(name = '나의 디자인 작업실'): Project {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: uid(),
    name,
    revision: 0,
    updatedAt: now,
    brand: { name: 'Junho Studio', color: '#adbcff', font: 'Pretendard' },
    styleId: 'glass',
    mode: 'dark',
    target: 'web',
    overrides: { light: {}, dark: {} },
    accessibility: { highContrast: false, largeText: false, reducedMotion: false },
    view: { depth: 0, typeScale: 1, decor: 1 },
    slideSize: { width: 960, height: 540 },
    slides: [
      'cover',
      'summary',
      'compare',
      'kpi',
      'chart',
      'table',
      'timeline',
      'image',
      'body',
      'closing',
    ].map((id, i) => makeSlide(id, 'Junho Studio', i)),
    webPages: ['portfolio', 'landing', 'dashboard'].map((k) => makeWebPage(k as WebPage['kind'])),
    motion: {
      id: uid(),
      width: 1920,
      height: 1080,
      fps: 30,
      seed: 42,
      scenes: [
        {
          id: uid(),
          name: '브랜드 인트로',
          template: 'intro',
          durationFrames: 150,
          effect: 'fade-in',
          elements: [
            {
              ...text(140, 330, 1640, 240, '생각을 디자인으로.', 110, { fontWeight: 700 }),
              effect: 'slide-up',
            },
            {
              ...text(146, 668, 1300, 72, 'JUNHO STUDIO', 32, { color: '{color.accent}' }),
              effect: 'fade-in',
            },
          ],
        },
        {
          id: uid(),
          name: '메시지',
          template: 'typography',
          durationFrames: 150,
          effect: 'slide-up',
          elements: [
            text(140, 320, 1640, 320, '하나의 브랜드.\n새로운 가능성.', 100, { fontWeight: 700 }),
          ],
        },
        {
          id: uid(),
          name: '엔딩',
          template: 'ending',
          durationFrames: 150,
          effect: 'fade-in',
          elements: [
            text(140, 400, 1600, 200, '다음 장면을 만듭니다.', 94, { fontWeight: 700 }),
            text(146, 654, 1200, 60, 'Junho Studio', 34, { color: '{color.accent}' }),
          ],
        },
      ],
    },
    assets: [],
    datasets: [
      {
        id: uid(),
        name: '프로젝트 현황 · 예시',
        columns: ['프로젝트', '유형', '상태', '진행률'],
        rows: [
          { 프로젝트: '브랜드 리뉴얼', 유형: '브랜드', 상태: '진행 중', 진행률: 75 },
          { 프로젝트: '포트폴리오', 유형: '웹', 상태: '검토 중', 진행률: 90 },
          { 프로젝트: '브랜드 인트로', 유형: '모션', 상태: '기획 중', 진행률: 30 },
          { 프로젝트: '서비스 소개', 유형: 'PPT', 상태: '완료', 진행률: 100 },
        ],
        source: 'sample',
        updatedAt: now,
      },
    ],
    favorites: ['glass', 'editorial'],
    customStyles: [],
    collections: [],
  };
}
