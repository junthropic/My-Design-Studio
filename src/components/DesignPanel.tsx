import { useState, useEffect } from 'react';
import {
  RotateCcw,
  Search,
  Check,
  AlertCircle,
  ArrowUpRight,
  SlidersHorizontal,
} from 'lucide-react';
import { TOKEN_META } from '../core/presets';
import { resolveDesign, contrastPairs } from '../core/design';
import type { Project, TokenValue } from '../core/types';
import { MiniPreview } from './Preview';
import { api } from '../api';
export function DesignPanel({
  project,
  onChange,
}: {
  project: Project;
  onChange: (p: Project) => void;
}) {
  const [group, setGroup] = useState('전체'),
    [query, setQuery] = useState('');
  const [fonts, setFonts] = useState<string[]>([]);
  useEffect(() => {
    api<any[]>(`/fonts?projectId=${project.id}`)
      .then((rows) => setFonts(rows.map((r) => r.fontFamily)))
      .catch(() => {});
  }, [project.id, project.assets.length]);
  const d = resolveDesign(project);
  const pairs = contrastPairs(d);
  const groups = ['전체', ...new Set(Object.values(TOKEN_META).map((x) => x.group))];
  function edit(key: string, value: TokenValue) {
    onChange({
      ...project,
      overrides: {
        ...project.overrides,
        [project.mode]: { ...project.overrides[project.mode], [key]: value },
      },
    });
  }
  function reset(key: string) {
    const values = { ...project.overrides[project.mode] };
    delete values[key];
    onChange({ ...project, overrides: { ...project.overrides, [project.mode]: values } });
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">DESIGN SYSTEM</span>
          <h1>디자인의 기준을 만듭니다.</h1>
          <p>바꾼 값은 미리보기와 내보내기에 같은 방식으로 적용됩니다.</p>
        </div>
        <span className="pill">편집 중 · {project.mode === 'dark' ? '다크' : '라이트'}</span>
      </div>
      <div className="stat-strip">
        <div>
          <span>적용한 스타일</span>
          <strong>{d.style.name}</strong>
        </div>
        <div>
          <span>바뀐 토큰</span>
          <strong>
            {Object.keys(project.overrides.light).length +
              Object.keys(project.overrides.dark).length}
            <small>개</small>
          </strong>
        </div>
        <div>
          <span>토큰 대비 검사</span>
          <strong className="green">
            {pairs.filter((x) => x.pass).length}
            <small> / {pairs.length} 통과</small>
          </strong>
        </div>
        <div className="stat-note">
          브랜드 원색은 보존하고
          <br />
          UI에 필요한 대비를 따로 보정합니다.
        </div>
      </div>
      <div className="design-layout">
        <div>
          <section className="panel">
            <div className="panel-heading">
              <h2>브랜드</h2>
              <span>모든 제작물의 공통 기준</span>
            </div>
            <div className="brand-inputs">
              <label>
                브랜드명
                <input
                  value={project.brand.name}
                  onChange={(e) =>
                    onChange({ ...project, brand: { ...project.brand, name: e.target.value } })
                  }
                />
              </label>
              <label>
                브랜드 원색
                <div className="color-control">
                  <input
                    type="color"
                    value={project.brand.color}
                    onChange={(e) =>
                      onChange({ ...project, brand: { ...project.brand, color: e.target.value } })
                    }
                  />
                  <code>{project.brand.color.toUpperCase()}</code>
                </div>
              </label>
              <label>
                브랜드 로고
                <select
                  value={project.brand.logoAssetId || ''}
                  onChange={(e) =>
                    onChange({
                      ...project,
                      brand: { ...project.brand, logoAssetId: e.target.value || undefined },
                    })
                  }
                >
                  <option value="">없음</option>
                  {project.assets
                    .filter((a) => a.mime.startsWith('image/'))
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                기본 글꼴
                <select
                  value={project.brand.font}
                  onChange={(e) =>
                    onChange({ ...project, brand: { ...project.brand, font: e.target.value } })
                  }
                >
                  {[
                    ...new Set([
                      'Pretendard',
                      'Malgun Gothic',
                      'Arial',
                      'Georgia',
                      'Noto Sans KR',
                      'D2Coding',
                      project.brand.font,
                      ...fonts,
                    ]),
                  ].map((f) => (
                    <option key={f}>{f}</option>
                  ))}
                </select>
              </label>
            </div>
          </section>
          <div className="token-navigation">
            <label className="search-field">
              <Search size={14} />
              <input
                aria-label="토큰 검색"
                placeholder="토큰 검색"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <div className="filter-tabs scroll">
              {groups.map((g) => (
                <button key={g} className={group === g ? 'active' : ''} onClick={() => setGroup(g)}>
                  {g}
                </button>
              ))}
            </div>
          </div>
          {groups
            .slice(1)
            .filter((g) => group === '전체' || g === group)
            .map((g) => (
              <section className="panel token-panel" key={g}>
                <div className="panel-heading">
                  <h2>{g}</h2>
                  <span>
                    {g === '효과와 모션'
                      ? '표현의 강도와 움직임'
                      : g === '타이포그래피'
                        ? '다람쥐 헌 쳇바퀴에 타고파 0123'
                        : '역할에 맞는 값을 선택하세요'}
                  </span>
                </div>
                {Object.entries(TOKEN_META)
                  .filter(
                    ([k, m]) =>
                      m.group === g &&
                      `${k} ${m.label} ${m.description} ${d.tokens[k]}`
                        .toLowerCase()
                        .includes(query.toLowerCase()),
                  )
                  .map(([k, m]) => (
                    <div className="token-row" key={k}>
                      <div
                        className="token-sample"
                        style={m.type === 'color' ? { background: String(d.tokens[k]) } : {}}
                      >
                        {m.type === 'font'
                          ? 'Aa'
                          : m.type === 'number'
                            ? m.unit === 'ms'
                              ? '↝'
                              : '⌑'
                            : ''}
                      </div>
                      <div className="token-info">
                        <strong>{m.label}</strong>
                        <code>{k}</code>
                        <small>{d.sources[k]}</small>
                      </div>
                      <div className="token-input">
                        {m.type === 'color' ? (
                          <>
                            <input
                              aria-label={m.label}
                              type="color"
                              value={String(d.tokens[k])}
                              onChange={(e) => edit(k, e.target.value)}
                            />
                            <code>{String(d.tokens[k]).toUpperCase()}</code>
                          </>
                        ) : m.type === 'font' ? (
                          <input
                            aria-label={m.label}
                            value={String(d.tokens[k])}
                            onChange={(e) => edit(k, e.target.value)}
                          />
                        ) : (
                          <>
                            <input
                              aria-label={m.label}
                              type="number"
                              min={m.min}
                              max={m.max}
                              step={m.step || 1}
                              value={Number(d.tokens[k])}
                              onChange={(e) => {
                                const n = Number(e.target.value);
                                if (
                                  Number.isFinite(n) &&
                                  n >= (m.min ?? 0) &&
                                  n <= (m.max ?? 10000)
                                )
                                  edit(k, n);
                              }}
                            />
                            <small>{m.unit}</small>
                          </>
                        )}
                      </div>
                      <button
                        className="icon-button"
                        aria-label={`${m.label} 초기화`}
                        title="이 토큰 초기화"
                        disabled={!(k in project.overrides[project.mode])}
                        onClick={() => reset(k)}
                      >
                        <RotateCcw size={14} />
                      </button>
                    </div>
                  ))}
              </section>
            ))}
          <section className="panel">
            <div className="panel-heading">
              <h2>대비 검사</h2>
              <span>등록된 색 쌍 · 자동 검사</span>
            </div>
            {pairs.map((p) => (
              <div className="contrast-row" key={p.name}>
                <span
                  className="contrast-example"
                  style={{ background: String(d.tokens[p.bg]), color: String(d.tokens[p.fg]) }}
                >
                  Aa
                </span>
                <span>{p.name}</span>
                <strong>{p.ratio.toFixed(2)}:1</strong>
                <span className={p.pass ? 'check-pass' : 'check-fail'}>
                  {p.pass ? <Check size={15} /> : <AlertCircle size={15} />}{' '}
                  {p.pass ? '통과' : '미달'}
                </span>
              </div>
            ))}
            <p className="help">
              이미지·반투명 효과 위 글자와 대상 앱의 실제 글꼴은 출력 후 별도로 확인합니다.
            </p>
          </section>
        </div>
        <aside className="design-preview">
          <div className="panel sticky-panel">
            <div className="panel-heading">
              <h2>라이브 미리보기</h2>
              <span className="live-dot">LIVE</span>
            </div>
            <MiniPreview project={project} large kind={project.target} />
            <div className="preview-mode-switch segmented">
              {(['web', 'ppt', 'motion'] as const).map((t) => (
                <button
                  key={t}
                  className={project.target === t ? 'active' : ''}
                  onClick={() => onChange({ ...project, target: t })}
                >
                  {t === 'web' ? '웹' : t === 'ppt' ? 'PPT' : '모션'}
                </button>
              ))}
            </div>
            <div className="inspector-section">
              <h3>
                <SlidersHorizontal size={14} />
                보기 조절
              </h3>
              <label className="range-field">
                표면 깊이 <span>{project.view.depth.toFixed(1)}</span>
                <input
                  aria-label="표면 깊이"
                  type="range"
                  min="0"
                  max="1"
                  step=".1"
                  value={project.view.depth}
                  onChange={(e) =>
                    onChange({
                      ...project,
                      view: { ...project.view, depth: Number(e.target.value) },
                    })
                  }
                />
              </label>
              <label className="range-field">
                글자 배율 <span>{project.view.typeScale.toFixed(1)}×</span>
                <input
                  aria-label="글자 배율"
                  type="range"
                  min=".8"
                  max="1.6"
                  step=".1"
                  value={project.view.typeScale}
                  onChange={(e) =>
                    onChange({
                      ...project,
                      view: { ...project.view, typeScale: Number(e.target.value) },
                    })
                  }
                />
              </label>
            </div>
            <div className="inspector-section">
              <h3>접근성 옵션</h3>
              {(
                [
                  ['highContrast', '고대비'],
                  ['largeText', '글자 확대'],
                  ['reducedMotion', '동작 줄이기'],
                ] as const
              ).map(([key, label]) => (
                <label className="switch-row" key={key}>
                  {label}
                  <input
                    type="checkbox"
                    checked={project.accessibility[key]}
                    onChange={(e) =>
                      onChange({
                        ...project,
                        accessibility: { ...project.accessibility, [key]: e.target.checked },
                      })
                    }
                  />
                </label>
              ))}
            </div>
            <p className="help">
              {project.brand.font}가 설치되지 않은 환경에서는 시스템 글꼴로 보일 수 있습니다.
            </p>
          </div>
        </aside>
      </div>
    </>
  );
}
