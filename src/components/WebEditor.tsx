import { useMemo, useState, useEffect, useRef } from 'react';
import {
  Plus,
  Trash2,
  ChevronUp,
  ChevronDown,
  Download,
  Monitor,
  Smartphone,
  Tablet,
  Eye,
  EyeOff,
} from 'lucide-react';
import type { Project, WebSection } from '../core/types';
import { makeSection, makeWebPage } from '../core/templates';
import { renderWebHTML } from '../exporters/web';
export function WebEditor({
  project,
  onChange,
  onExport,
}: {
  project: Project;
  onChange: (p: Project) => void;
  onExport: (f: string) => void;
}) {
  const [pageId, setPageId] = useState(project.webPages[0]?.id),
    [sectionId, setSectionId] = useState(''),
    [width, setWidth] = useState(1280),
    [type, setType] = useState<WebSection['type']>('features');
  const frame = useRef<HTMLIFrameElement | null>(null);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        event.source === frame.current?.contentWindow &&
        event.data?.type === 'design-studio:web-page' &&
        project.webPages.some((p) => p.id === event.data.pageId)
      ) {
        setPageId(event.data.pageId);
        setSectionId('');
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [project.webPages]);
  const page = project.webPages.find((p) => p.id === pageId) || project.webPages[0],
    section = page?.sections.find((s) => s.id === sectionId) || page?.sections[0];
  const html = useMemo(() => (page ? renderWebHTML(project, page.id) : ''), [project, page?.id]);
  if (!page)
    return (
      <button onClick={() => onChange({ ...project, webPages: [makeWebPage('portfolio')] })}>
        페이지 만들기
      </button>
    );
  const changeSection = (patch: Partial<WebSection>) =>
    onChange({
      ...project,
      webPages: project.webPages.map((p) =>
        p.id === page.id
          ? {
              ...p,
              sections: p.sections.map((s) => (s.id === section?.id ? { ...s, ...patch } : s)),
            }
          : p,
      ),
    });
  const move = (delta: number) => {
    const list = [...page.sections],
      at = list.findIndex((s) => s.id === section.id),
      to = at + delta;
    if (to < 0 || to >= list.length) return;
    [list[at], list[to]] = [list[to], list[at]];
    onChange({
      ...project,
      webPages: project.webPages.map((p) => (p.id === page.id ? { ...p, sections: list } : p)),
    });
  };
  return (
    <>
      <div className="page-heading compact">
        <div>
          <span className="eyebrow">WEB STUDIO</span>
          <h1>화면 너머의 경험까지.</h1>
          <p>반응형 페이지를 구성하고 실제 동작하는 웹사이트로 내보냅니다.</p>
        </div>
        <button className="button primary" onClick={() => onExport('web')}>
          <Download size={16} />웹 패키지 내보내기
        </button>
      </div>
      <div className="editor-shell web-shell">
        <aside className="slide-rail">
          <div className="rail-head">
            페이지
            <select
              aria-label="웹 페이지 선택"
              value={page.id}
              onChange={(e) => {
                setPageId(e.target.value);
                setSectionId('');
              }}
            >
              {project.webPages.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="rail-head">
            섹션 <span>{page.sections.length}</span>
          </div>
          {page.sections.map((s, i) => (
            <button
              key={s.id}
              className={`section-list-item ${s.id === section?.id ? 'active' : ''}`}
              onClick={() => setSectionId(s.id)}
            >
              <small>{String(i + 1).padStart(2, '0')}</small>
              <span>
                {s.type}
                <strong>{s.title}</strong>
              </span>
              {!s.enabled && <EyeOff size={14} />}
            </button>
          ))}
          <div className="add-section">
            <select
              aria-label="추가할 섹션"
              value={type}
              onChange={(e) => setType(e.target.value as WebSection['type'])}
            >
              {[
                'hero',
                'features',
                'projects',
                'about',
                'stats',
                'table',
                'chart',
                'faq',
                'contact',
                'pricing',
              ].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
            <button
              className="button secondary"
              onClick={() => {
                const s = makeSection(type);
                onChange({
                  ...project,
                  webPages: project.webPages.map((p) =>
                    p.id === page.id ? { ...p, sections: [...p.sections, s] } : p,
                  ),
                });
                setSectionId(s.id);
              }}
            >
              <Plus size={14} />
              섹션 추가
            </button>
          </div>
        </aside>
        <div className="web-workspace">
          <div className="canvas-toolbar">
            <div className="segmented">
              {[390, 768, 1280, 1440].map((w) => (
                <button key={w} className={width === w ? 'active' : ''} onClick={() => setWidth(w)}>
                  {w === 390 ? (
                    <Smartphone size={14} />
                  ) : w === 768 ? (
                    <Tablet size={14} />
                  ) : (
                    <Monitor size={14} />
                  )}{' '}
                  {w}
                </button>
              ))}
            </div>
            <span className="muted">CSS px · 미리보기 배율 조절</span>
          </div>
          <div className="website-frame-area">
            <div className="website-frame" style={{ width: `min(100%, ${width}px)` }}>
              <div className="website-address">
                <i />
                <i />
                <i />
                <span>{page.kind}.preview</span>
              </div>
              <div
                className="scaled-website"
                style={{ aspectRatio: width === 390 ? '390/780' : '1.3' }}
              >
                <iframe
                  title={`${page.name} ${width}px 미리보기`}
                  sandbox="allow-scripts"
                  srcDoc={html}
                  style={{
                    width: width,
                    height: width === 390 ? 780 : 900,
                    transform: `scale(var(--web-scale, 1))`,
                  }}
                  ref={(node) => {
                    frame.current = node;
                    if (node) {
                      const container = node.parentElement!;
                      const resize = () => {
                        const scale = container.clientWidth / width;
                        node.style.transform = `scale(${scale})`;
                        container.style.height = `${(width === 390 ? 780 : 900) * scale}px`;
                      };
                      resize();
                      const observer = new ResizeObserver(resize);
                      observer.observe(container);
                      return () => observer.disconnect();
                    }
                  }}
                />
              </div>
            </div>
          </div>
        </div>
        <aside className="element-inspector">
          <div className="panel-heading">
            <h3>섹션 속성</h3>
            <span>{section?.type}</span>
          </div>
          {section && (
            <>
              <label>
                제목
                <textarea
                  value={section.title}
                  onChange={(e) => changeSection({ title: e.target.value })}
                />
              </label>
              <label>
                설명
                <textarea
                  value={section.body}
                  onChange={(e) => changeSection({ body: e.target.value })}
                />
              </label>
              <div className="property-grid">
                <label>
                  열 수
                  <input
                    type="number"
                    min="1"
                    max="6"
                    value={section.columns}
                    onChange={(e) =>
                      changeSection({ columns: Math.max(1, Math.min(6, Number(e.target.value))) })
                    }
                  />
                </label>
                <label>
                  모바일 열
                  <input
                    type="number"
                    min="1"
                    max="3"
                    value={section.mobileColumns || 1}
                    onChange={(e) =>
                      changeSection({
                        mobileColumns: Math.max(1, Math.min(3, Number(e.target.value))),
                      })
                    }
                  />
                </label>
              </div>
              <label>
                정렬
                <select
                  value={section.align || 'left'}
                  onChange={(e) => changeSection({ align: e.target.value as 'left' | 'center' })}
                >
                  <option value="left">왼쪽</option>
                  <option value="center">가운데</option>
                </select>
              </label>
              <label>
                연결 데이터
                <select
                  value={section.dataId || ''}
                  onChange={(e) => changeSection({ dataId: e.target.value || undefined })}
                >
                  <option value="">기본 데이터</option>
                  {project.datasets.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                이미지
                <select
                  value={section.assetId || ''}
                  onChange={(e) => changeSection({ assetId: e.target.value || undefined })}
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
              {section.items && (
                <div className="inspector-section">
                  <h3>항목 편집</h3>
                  {section.items.map((item, i) => (
                    <div className="item-fields" key={i}>
                      <input
                        aria-label={`항목 ${i + 1} 제목`}
                        value={item.title}
                        onChange={(e) =>
                          changeSection({
                            items: section.items!.map((x, j) =>
                              j === i ? { ...x, title: e.target.value } : x,
                            ),
                          })
                        }
                      />
                      <textarea
                        aria-label={`항목 ${i + 1} 설명`}
                        value={item.body}
                        onChange={(e) =>
                          changeSection({
                            items: section.items!.map((x, j) =>
                              j === i ? { ...x, body: e.target.value } : x,
                            ),
                          })
                        }
                      />
                    </div>
                  ))}
                </div>
              )}
              <div className="button-row">
                <button className="icon-button" aria-label="섹션 위로" onClick={() => move(-1)}>
                  <ChevronUp size={16} />
                </button>
                <button className="icon-button" aria-label="섹션 아래로" onClick={() => move(1)}>
                  <ChevronDown size={16} />
                </button>
                <button
                  className="icon-button"
                  aria-label="섹션 표시 전환"
                  onClick={() => changeSection({ enabled: !section.enabled })}
                >
                  {section.enabled ? <Eye size={16} /> : <EyeOff size={16} />}
                </button>
                <button
                  className="icon-button"
                  aria-label="섹션 삭제"
                  onClick={() =>
                    onChange({
                      ...project,
                      webPages: project.webPages.map((p) =>
                        p.id === page.id
                          ? { ...p, sections: p.sections.filter((s) => s.id !== section.id) }
                          : p,
                      ),
                    })
                  }
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </>
          )}
          <div className="inspector-section">
            <h3>검색·공유 정보</h3>
            <label>
              페이지 제목
              <input
                value={page.title}
                onChange={(e) =>
                  onChange({
                    ...project,
                    webPages: project.webPages.map((p) =>
                      p.id === page.id ? { ...p, title: e.target.value } : p,
                    ),
                  })
                }
              />
            </label>
            <label>
              메타 설명
              <textarea
                value={page.description}
                onChange={(e) =>
                  onChange({
                    ...project,
                    webPages: project.webPages.map((p) =>
                      p.id === page.id ? { ...p, description: e.target.value } : p,
                    ),
                  })
                }
              />
            </label>
          </div>
        </aside>
      </div>
    </>
  );
}
