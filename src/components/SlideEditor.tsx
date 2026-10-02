import { useRef, useState } from 'react';
import {
  Plus,
  Copy,
  Trash2,
  ChevronUp,
  ChevronDown,
  Type,
  Square,
  Image,
  BarChart3,
  Table2,
  Download,
  Lock,
  Unlock,
  AlignLeft,
  AlignCenter,
  Eye,
  EyeOff,
  Layers,
} from 'lucide-react';
import type { Project, StudioElement, Slide } from '../core/types';
import { SLIDE_LAYOUTS, makeSlide, uid } from '../core/templates';
import { resolveDesign } from '../core/design';
import { ProjectSchema } from '../core/schema';
import { SlideChart } from './SlideChart';
function color(
  value: string | undefined,
  t: Record<string, string | number>,
  fallback = 'color.text',
) {
  const key = value?.match(/^\{(.+)\}$/)?.[1];
  return String(key ? t[key] : value || t[fallback]);
}
export function SlideArt({
  project,
  slide,
  selected = [],
  onDown,
  onSelect,
}: {
  project: Project;
  slide: Slide;
  selected?: string[];
  onDown?: (e: React.PointerEvent, id: string, resize?: boolean) => void;
  onSelect?: (e: React.MouseEvent, id: string) => void;
}) {
  const d = resolveDesign(project, 'ppt');
  const t = d.tokens;
  return (
    <svg
      className="slide-svg"
      viewBox={`0 0 ${project.slideSize.width} ${project.slideSize.height}`}
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label={slide.name}
    >
      <rect width="100%" height="100%" fill={String(t['color.bg'])} />
      {project.brand.logoAssetId &&
        project.assets.some(
          (a) => a.id === project.brand.logoAssetId && a.mime.startsWith('image/'),
        ) && (
          <image
            href={'/api/assets/' + project.brand.logoAssetId}
            x={project.slideSize.width - 105}
            y={24}
            width={60}
            height={32}
            preserveAspectRatio="xMidYMid meet"
          />
        )}
      {slide.elements.map((e) => (
        <g
          key={e.id}
          opacity={e.opacity ?? 1}
          transform={`rotate(${e.rotation || 0} ${e.x + e.w / 2} ${e.y + e.h / 2})`}
          onPointerDown={(ev) => onDown?.(ev, e.id)}
          onClick={(ev) => onSelect?.(ev, e.id)}
          style={{ cursor: onDown && !e.locked ? 'move' : 'default' }}
        >
          {e.type === 'shape' ? (
            e.shape === 'ellipse' ? (
              <ellipse
                cx={e.x + e.w / 2}
                cy={e.y + e.h / 2}
                rx={e.w / 2}
                ry={e.h / 2}
                fill={color(e.fill, t, 'color.accent')}
              />
            ) : e.shape === 'line' ? (
              <line
                x1={e.x}
                y1={e.y}
                x2={e.x + e.w}
                y2={e.y + e.h}
                stroke={color(e.fill, t, 'color.accent')}
                strokeWidth={3}
              />
            ) : (
              <rect
                x={e.x}
                y={e.y}
                width={e.w}
                height={e.h}
                rx={Number(t['radius.card'])}
                fill={color(e.fill, t, 'color.accent')}
              />
            )
          ) : e.type === 'text' ? (
            <foreignObject x={e.x} y={e.y} width={e.w} height={e.h}>
              <div
                style={{
                  fontFamily: `"${t['font.family']}","Malgun Gothic",sans-serif`,
                  fontSize: e.fontSize || t['font.body'],
                  fontWeight: e.fontWeight || 400,
                  color: color(e.color, t),
                  lineHeight: 1.24,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'keep-all',
                  height: '100%',
                  overflow: 'hidden',
                }}
              >
                {e.text}
              </div>
            </foreignObject>
          ) : e.type === 'image' || e.type === 'video' ? (
            e.assetId ? (
              <image
                href={'/api/assets/' + e.assetId}
                x={e.x}
                y={e.y}
                width={e.w}
                height={e.h}
                preserveAspectRatio="xMidYMid slice"
              />
            ) : (
              <>
                <rect x={e.x} y={e.y} width={e.w} height={e.h} fill={String(t['color.surface'])} />
                <text x={e.x + 20} y={e.y + 40} fill={String(t['color.muted'])} fontSize="20">
                  이미지를 선택하세요
                </text>
              </>
            )
          ) : e.type === 'chart' ? (
            <SlideChart element={e} tokens={t} />
          ) : e.type === 'table' ? (
            <g>
              {(e.tableData || []).map((row, i) =>
                row.map((v, j) => {
                  const rh = e.h / Math.max(1, e.tableData!.length),
                    cw = e.w / row.length;
                  return (
                    <g key={`${i}-${j}`}>
                      <rect
                        x={e.x + j * cw}
                        y={e.y + i * rh}
                        width={cw}
                        height={rh}
                        fill={i === 0 ? String(t['color.accent']) : String(t['color.surface'])}
                        stroke={String(t['color.border'])}
                      />
                      <text
                        x={e.x + j * cw + 14}
                        y={e.y + i * rh + rh / 2 + 6}
                        fill={String(t[i === 0 ? 'color.onAccent' : 'color.text'])}
                        fontSize="18"
                      >
                        {v}
                      </text>
                    </g>
                  );
                }),
              )}
            </g>
          ) : null}
          {onDown && (
            <rect
              x={e.x}
              y={e.y}
              width={e.w}
              height={e.h}
              fill="transparent"
              stroke={selected.includes(e.id) ? '#889aff' : 'transparent'}
              strokeWidth="2"
            />
          )}
          {selected.includes(e.id) && onDown && !e.locked && (
            <rect
              x={e.x + e.w - 6}
              y={e.y + e.h - 6}
              width="12"
              height="12"
              fill="#b8c4ff"
              stroke="#273250"
              style={{ cursor: 'nwse-resize' }}
              onPointerDown={(ev) => {
                ev.stopPropagation();
                onDown(ev, e.id, true);
              }}
            />
          )}
        </g>
      ))}
    </svg>
  );
}
export function SlideEditor({
  project,
  onChange,
  onExport,
}: {
  project: Project;
  onChange: (p: Project) => void;
  onExport: (f: string) => void;
}) {
  const [index, setIndex] = useState(0),
    [selection, setSelection] = useState<string[]>([]),
    [layout, setLayout] = useState('cover'),
    [pending, setPending] = useState<Slide | null>(null),
    [jsonError, setJsonError] = useState('');
  const canvas = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    startX: number;
    startY: number;
    ids: string[];
    slide: Slide;
    resize: boolean;
  } | null>(null);
  const slide = project.slides[Math.min(index, project.slides.length - 1)];
  if (!slide)
    return (
      <button onClick={() => onChange({ ...project, slides: [makeSlide()] })}>새 슬라이드</button>
    );
  const active = (pending || slide).elements.find((e) => e.id === selection[0]);
  const update = (next: Slide) =>
    onChange({ ...project, slides: project.slides.map((s) => (s.id === slide.id ? next : s)) });
  const patch = (changes: Partial<StudioElement>) =>
    update({
      ...slide,
      elements: slide.elements.map((e) => (selection.includes(e.id) ? { ...e, ...changes } : e)),
    });
  function add(type: StudioElement['type']) {
    const e: StudioElement = {
      id: uid(),
      type,
      x: 100,
      y: 160,
      w: type === 'text' ? 500 : 300,
      h: type === 'text' ? 70 : 200,
      text: type === 'text' ? '새로운 메시지' : undefined,
      fontSize: 32,
      fontWeight: 500,
      fill: '{color.accent}',
      color: '{color.text}',
    };
    if (type === 'chart')
      e.chartData = { labels: ['A', 'B', 'C', 'D'], values: [30, 55, 42, 80], type: 'bar' };
    if (type === 'table')
      e.tableData = [
        ['항목', '값'],
        ['내용 A', '12'],
        ['내용 B', '24'],
      ];
    if (type === 'image') e.assetId = project.assets.find((a) => a.mime.startsWith('image/'))?.id;
    update({ ...slide, elements: [...slide.elements, e] });
    setSelection([e.id]);
  }
  function reorder(delta: number) {
    const at = project.slides.findIndex((s) => s.id === slide.id),
      to = at + delta;
    if (to < 0 || to >= project.slides.length) return;
    const list = [...project.slides];
    [list[at], list[to]] = [list[to], list[at]];
    onChange({ ...project, slides: list });
    setIndex(to);
  }
  function down(e: React.PointerEvent, id: string, resize = false) {
    const element = slide.elements.find((x) => x.id === id)!;
    if (element.locked) return;
    const grouped = element.group
      ? slide.elements.filter((x) => x.group === element.group && !x.locked).map((x) => x.id)
      : [id];
    const ids = e.shiftKey
      ? [...new Set([...selection, id])]
      : selection.includes(id)
        ? selection
        : grouped;
    setSelection(ids);
    drag.current = {
      startX: e.clientX,
      startY: e.clientY,
      ids,
      slide: structuredClone(slide),
      resize,
    };
    canvas.current?.setPointerCapture(e.pointerId);
    e.preventDefault();
  }
  function move(e: React.PointerEvent) {
    const dr = drag.current,
      rect = canvas.current?.getBoundingClientRect();
    if (!dr || !rect) return;
    const dx = ((e.clientX - dr.startX) * project.slideSize.width) / rect.width,
      dy = ((e.clientY - dr.startY) * project.slideSize.height) / rect.height;
    setPending({
      ...dr.slide,
      elements: dr.slide.elements.map((x) =>
        dr.ids.includes(x.id)
          ? dr.resize
            ? { ...x, w: Math.max(12, Math.round(x.w + dx)), h: Math.max(12, Math.round(x.h + dy)) }
            : { ...x, x: Math.round(x.x + dx), y: Math.round(x.y + dy) }
          : x,
      ),
    });
  }
  function up() {
    if (pending) update(pending);
    drag.current = null;
    setPending(null);
  }
  const align = (axis: 'x' | 'y', edge: 'start' | 'middle' | 'end') => {
    const els = slide.elements.filter((e) => selection.includes(e.id) && !e.locked);
    const dimension = axis === 'x' ? 'w' : 'h',
      low = Math.min(...els.map((e) => e[axis])),
      high = Math.max(...els.map((e) => e[axis] + e[dimension]));
    update({
      ...slide,
      elements: slide.elements.map((e) =>
        els.includes(e)
          ? {
              ...e,
              [axis]:
                edge === 'start'
                  ? low
                  : edge === 'end'
                    ? high - e[dimension]
                    : (low + high - e[dimension]) / 2,
            }
          : e,
      ),
    });
  };
  const remove = () => {
    update({ ...slide, elements: slide.elements.filter((e) => !selection.includes(e.id)) });
    setSelection([]);
  };
  return (
    <>
      <div className="page-heading compact">
        <div>
          <span className="eyebrow">PRESENTATION STUDIO</span>
          <h1>메시지가 남는 프레젠테이션.</h1>
          <p>텍스트·표·차트를 PowerPoint에서 계속 편집할 수 있습니다.</p>
        </div>
        <button className="button primary" onClick={() => onExport('pptx')}>
          <Download size={16} />
          PPTX 내보내기
        </button>
      </div>
      <div className="editor-shell">
        <aside className="slide-rail">
          <div className="rail-head">
            <span>슬라이드 {project.slides.length}</span>
            <button
              className="icon-button"
              aria-label="슬라이드 추가"
              onClick={() => {
                const s = makeSlide(layout, project.brand.name);
                onChange({ ...project, slides: [...project.slides, s] });
                setIndex(project.slides.length);
                setSelection([]);
              }}
            >
              <Plus size={17} />
            </button>
          </div>
          <select
            aria-label="슬라이드 레이아웃"
            value={layout}
            onChange={(e) => setLayout(e.target.value)}
          >
            {SLIDE_LAYOUTS.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
          {project.slides.map((s, i) => (
            <button
              key={s.id}
              onClick={() => {
                setIndex(i);
                setSelection([]);
              }}
              className={`slide-thumb ${s.id === slide.id ? 'active' : ''} ${s.hidden ? 'hidden-slide' : ''}`}
            >
              <span>{String(i + 1).padStart(2, '0')}</span>
              <SlideArt project={project} slide={s} />
              <small>
                {s.name}
                {s.hidden ? ' · 숨김' : ''}
              </small>
            </button>
          ))}
        </aside>
        <div className="slide-workspace">
          <div className="canvas-toolbar">
            {[
              [Type, '텍스트', 'text'],
              [Square, '도형', 'shape'],
              [Image, '이미지', 'image'],
              [BarChart3, '차트', 'chart'],
              [Table2, '표', 'table'],
            ].map(([Icon, label, type]) => {
              const I = Icon as typeof Type;
              return (
                <button key={String(type)} onClick={() => add(type as StudioElement['type'])}>
                  <I size={16} />
                  {String(label)}
                </button>
              );
            })}
            <span className="toolbar-divider" />
            <button
              title="선택 요소 복제"
              disabled={!selection.length}
              onClick={() => {
                const els = slide.elements
                  .filter((x) => selection.includes(x.id))
                  .map((x) => ({ ...x, id: uid(), x: x.x + 20, y: x.y + 20 }));
                update({ ...slide, elements: [...slide.elements, ...els] });
                setSelection(els.map((x) => x.id));
              }}
            >
              <Copy size={15} />
            </button>
            <button title="선택 요소 삭제" disabled={!selection.length} onClick={remove}>
              <Trash2 size={15} />
            </button>
          </div>
          <div className="slide-stage">
            <div
              className="slide-canvas"
              ref={canvas}
              style={{ aspectRatio: `${project.slideSize.width}/${project.slideSize.height}` }}
              onPointerMove={move}
              onPointerUp={up}
              onPointerCancel={up}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Delete') {
                  remove();
                  e.preventDefault();
                }
              }}
            >
              <SlideArt
                project={project}
                slide={pending || slide}
                selected={selection}
                onDown={down}
              />
            </div>
            <div className="canvas-caption">
              <span>
                {project.slideSize.width} × {project.slideSize.height} pt
              </span>
              <span>Shift + 클릭으로 여러 요소 선택 · 드래그로 이동</span>
              <span>
                {index + 1} / {project.slides.length}
              </span>
            </div>
          </div>
          <div className="slide-bottom">
            <div className="slide-actions">
              <button className="icon-button" title="이전으로" onClick={() => reorder(-1)}>
                <ChevronUp size={15} />
              </button>
              <button className="icon-button" title="다음으로" onClick={() => reorder(1)}>
                <ChevronDown size={15} />
              </button>
              <button
                className="icon-button"
                title="장표 복제"
                onClick={() => {
                  const next = {
                    ...structuredClone(slide),
                    id: uid(),
                    name: slide.name + ' 복사',
                    elements: slide.elements.map((e) => ({ ...e, id: uid() })),
                  };
                  onChange({
                    ...project,
                    slides: [
                      ...project.slides.slice(0, index + 1),
                      next,
                      ...project.slides.slice(index + 1),
                    ],
                  });
                  setIndex(index + 1);
                }}
              >
                <Copy size={15} />
              </button>
              <button
                className="icon-button"
                title="장표 숨김"
                onClick={() => update({ ...slide, hidden: !slide.hidden })}
              >
                {slide.hidden ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
              <button
                className="icon-button"
                title="장표 삭제"
                disabled={project.slides.length === 1}
                onClick={() => {
                  onChange({ ...project, slides: project.slides.filter((s) => s.id !== slide.id) });
                  setIndex(Math.max(0, index - 1));
                }}
              >
                <Trash2 size={15} />
              </button>
            </div>
            <label>
              발표자 노트
              <textarea
                placeholder="발표할 내용과 출처를 기록하세요."
                value={slide.notes}
                onChange={(e) => update({ ...slide, notes: e.target.value })}
              />
            </label>
          </div>
        </div>
        <aside className="element-inspector">
          <div className="panel-heading">
            <h3>속성</h3>
            <span>{selection.length ? `${selection.length}개 선택` : '슬라이드'}</span>
          </div>
          {active ? (
            <>
              <label>
                콘텐츠
                {active.type === 'text' && (
                  <textarea
                    value={active.text || ''}
                    onChange={(e) => patch({ text: e.target.value })}
                  />
                )}
              </label>
              <div className="property-grid">
                {(['x', 'y', 'w', 'h'] as const).map((k) => (
                  <label key={k}>
                    {{ x: 'X', y: 'Y', w: '너비', h: '높이' }[k]}
                    <input
                      type="number"
                      value={active[k]}
                      min={k === 'w' || k === 'h' ? 1 : undefined}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        if (
                          Number.isFinite(n) &&
                          (k === 'x' || k === 'y' ? Math.abs(n) <= 10000 : n > 0 && n <= 10000)
                        )
                          patch({ [k]: n });
                      }}
                    />
                  </label>
                ))}
              </div>
              {active.type === 'text' && (
                <div className="property-grid">
                  <label>
                    글자 크기
                    <input
                      type="number"
                      min="1"
                      max="300"
                      value={active.fontSize || 24}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        if (n >= 1 && n <= 300) patch({ fontSize: n });
                      }}
                    />
                  </label>
                  <label>
                    굵기
                    <select
                      value={active.fontWeight || 400}
                      onChange={(e) => patch({ fontWeight: Number(e.target.value) })}
                    >
                      {[400, 500, 600, 700, 800].map((n) => (
                        <option key={n}>{n}</option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
              <div className="property-grid">
                <label>
                  회전
                  <input
                    type="number"
                    value={active.rotation || 0}
                    onChange={(e) => patch({ rotation: Number(e.target.value) })}
                  />
                </label>
                <label>
                  불투명도
                  <input
                    type="number"
                    step=".1"
                    min="0"
                    max="1"
                    value={active.opacity ?? 1}
                    onChange={(e) =>
                      patch({ opacity: Math.max(0, Math.min(1, Number(e.target.value))) })
                    }
                  />
                </label>
              </div>
              <label>
                색상
                <select
                  value={active.type === 'shape' ? active.fill : active.color}
                  onChange={(e) =>
                    patch(
                      active.type === 'shape'
                        ? { fill: e.target.value }
                        : { color: e.target.value },
                    )
                  }
                >
                  {['text', 'muted', 'accent', 'surface', 'bg', 'success', 'danger'].map((k) => (
                    <option key={k} value={`{color.${k}}`}>
                      {k}
                    </option>
                  ))}
                </select>
              </label>
              {active.type === 'image' && (
                <label>
                  이미지 자산
                  <select
                    value={active.assetId || ''}
                    onChange={(e) => patch({ assetId: e.target.value })}
                  >
                    <option value="">자산 선택</option>
                    {project.assets
                      .filter((a) => a.mime.startsWith('image/'))
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                  </select>
                  <input
                    aria-label="이미지 대체 텍스트"
                    placeholder="이미지 설명"
                    value={active.alt || ''}
                    onChange={(e) => patch({ alt: e.target.value })}
                  />
                </label>
              )}
              {(active.type === 'table' || active.type === 'chart') && (
                <label>
                  데이터 (JSON)
                  <textarea
                    key={active.id}
                    className="code-area"
                    defaultValue={JSON.stringify(
                      active.type === 'table' ? active.tableData : active.chartData,
                      null,
                      2,
                    )}
                    onBlur={(e) => {
                      try {
                        const val = JSON.parse(e.target.value);
                        const changes =
                          active.type === 'table' ? { tableData: val } : { chartData: val };
                        ProjectSchema.parse({
                          ...project,
                          slides: project.slides.map((s) =>
                            s.id === slide.id
                              ? {
                                  ...s,
                                  elements: s.elements.map((el) =>
                                    el.id === active.id ? { ...el, ...changes } : el,
                                  ),
                                }
                              : s,
                          ),
                        });
                        patch(changes);
                        setJsonError('');
                      } catch {
                        setJsonError(
                          '표: 문자열 배열, 차트: labels 배열·숫자 values 배열을 입력하세요.',
                        );
                      }
                    }}
                  />
                  <small className="error-text">{jsonError}</small>
                </label>
              )}
              {selection.length > 1 && (
                <div className="inspector-section">
                  <h3>여러 요소 정렬</h3>
                  <div className="button-row">
                    <button className="button secondary" onClick={() => align('x', 'start')}>
                      왼쪽
                    </button>
                    <button className="button secondary" onClick={() => align('x', 'middle')}>
                      중앙
                    </button>
                    <button className="button secondary" onClick={() => align('y', 'start')}>
                      위쪽
                    </button>
                  </div>
                  <button className="button secondary" onClick={() => patch({ group: uid() })}>
                    선택 요소 그룹
                  </button>
                </div>
              )}
              {active.group && (
                <button className="button secondary" onClick={() => patch({ group: undefined })}>
                  그룹 해제
                </button>
              )}
              <div className="button-row">
                <button
                  className="button secondary"
                  onClick={() => patch({ locked: !active.locked })}
                >
                  {active.locked ? <Unlock size={14} /> : <Lock size={14} />}
                  {active.locked ? '잠금 해제' : '잠금'}
                </button>
                <button
                  className="button secondary"
                  onClick={() => patch({ x: (project.slideSize.width - active.w) / 2 })}
                >
                  <AlignCenter size={14} />
                  가운데
                </button>
              </div>
              <div className="button-row">
                <button
                  className="button secondary"
                  onClick={() =>
                    update({
                      ...slide,
                      elements: [
                        ...slide.elements.filter((x) => !selection.includes(x.id)),
                        ...slide.elements.filter((x) => selection.includes(x.id)),
                      ],
                    })
                  }
                >
                  맨 앞으로
                </button>
                <button
                  className="button secondary"
                  onClick={() =>
                    update({
                      ...slide,
                      elements: [
                        ...slide.elements.filter((x) => selection.includes(x.id)),
                        ...slide.elements.filter((x) => !selection.includes(x.id)),
                      ],
                    })
                  }
                >
                  맨 뒤로
                </button>
              </div>
            </>
          ) : (
            <>
              <label>
                장표 이름
                <input
                  value={slide.name}
                  onChange={(e) => update({ ...slide, name: e.target.value })}
                />
              </label>
              <label>
                화면비
                <select
                  value={
                    project.slideSize.width === 960
                      ? 'wide'
                      : project.slideSize.width === 720
                        ? 'standard'
                        : 'custom'
                  }
                  onChange={(e) => {
                    if (e.target.value === 'custom') return;
                    const w = e.target.value === 'wide' ? 960 : 720;
                    onChange({
                      ...project,
                      slideSize: { width: w, height: 540 },
                      slides: project.slides.map((s) => ({
                        ...s,
                        elements: s.elements.map((el) => ({
                          ...el,
                          x: (el.x * w) / project.slideSize.width,
                          w: (el.w * w) / project.slideSize.width,
                        })),
                      })),
                    });
                  }}
                >
                  <option value="wide">16:9 · 와이드</option>
                  <option value="standard">4:3 · 표준</option>
                  <option value="custom">사용자 지정</option>
                </select>
              </label>
              <p className="help">
                요소를 선택하면 위치·크기·텍스트를 수정할 수 있습니다. 복잡한 장식은 출력 보고서에서
                변환 범위를 확인하세요.
              </p>
            </>
          )}
          <div className="inspector-section">
            <h3>
              <Layers size={14} />
              레이어
            </h3>
            {[...slide.elements].reverse().map((e) => (
              <button
                key={e.id}
                className={`layer-row ${selection.includes(e.id) ? 'selected' : ''}`}
                onClick={() => setSelection([e.id])}
              >
                <span>{e.type === 'text' ? e.text?.slice(0, 18) : e.type}</span>
                {e.locked && <Lock size={12} />}
              </button>
            ))}
          </div>
        </aside>
      </div>
    </>
  );
}
