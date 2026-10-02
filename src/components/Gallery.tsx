import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Heart,
  Check,
  ArrowUpRight,
  Copy,
  Columns3,
  X,
  Plus,
  Search,
  FolderPlus,
  Folder,
  Pencil,
  Trash2,
} from 'lucide-react';
import { STYLES } from '../core/presets';
import { uid } from '../core/templates';
import type { Project, StylePreset, Target } from '../core/types';
import { MiniPreview } from './Preview';
import './Gallery.css';
type Modal =
  | { kind: 'style'; source: StylePreset; snapshot: boolean; edit: boolean }
  | { kind: 'collection'; id?: string }
  | { kind: 'assign'; styleId: string }
  | { kind: 'delete'; styleId: string };
function GalleryDialog({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = ref.current!;
    node.showModal();
    return () => {
      if (node.open) node.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal gallery-dialog ${wide ? 'wide' : ''}`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      aria-label={title}
    >
      <div className="modal-title">
        <h2>{title}</h2>
        <button className="icon-button" aria-label="대화상자 닫기" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
function matchesMedium(style: StylePreset, medium: string) {
  if (medium === 'all') return true;
  return {
    web: /웹|포트폴리오|대시보드|제품/,
    ppt: /PPT|프레젠테이션|보고서|업무/,
    motion: /모션|영상|시네마틱/,
  }[medium as Target]?.test(style.tags.join(' '));
}
export function Gallery({
  project,
  onChange,
  onEdit,
}: {
  project: Project;
  onChange: (p: Project) => void;
  onEdit: () => void;
}) {
  const [query, setQuery] = useState(''),
    [filter, setFilter] = useState('전체'),
    [medium, setMedium] = useState('all'),
    [tag, setTag] = useState(''),
    [collection, setCollection] = useState(''),
    [compare, setCompare] = useState<string[]>([]),
    [showCompare, setShowCompare] = useState(false),
    [modal, setModal] = useState<Modal | null>(null),
    [name, setName] = useState(''),
    [description, setDescription] = useState(''),
    [tags, setTags] = useState(''),
    [saveMedium, setSaveMedium] = useState('all'),
    [memberships, setMemberships] = useState<string[]>([]),
    [error, setError] = useState('');
  useEffect(() => {
    setCompare([]);
    setShowCompare(false);
    setModal(null);
    setCollection('');
    setTag('');
  }, [project.id]);
  const styles = [...STYLES, ...project.customStyles],
    selected = styles.find((x) => x.id === project.styleId) || STYLES[0],
    allTags = [...new Set(styles.flatMap((s) => s.tags))].sort((a, b) => a.localeCompare(b, 'ko'));
  const chosenCollection = project.collections.find((c) => c.id === collection),
    compared = compare
      .map((id) => styles.find((s) => s.id === id))
      .filter((s): s is StylePreset => !!s),
    words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const visible = styles.filter(
    (s) =>
      (filter !== '즐겨찾기' || project.favorites.includes(s.id)) &&
      (filter !== '내 스타일' || project.customStyles.some((c) => c.id === s.id)) &&
      (!chosenCollection || chosenCollection.styleIds.includes(s.id)) &&
      (!tag || s.tags.includes(tag)) &&
      matchesMedium(s, medium) &&
      words.every((w) =>
        `${s.name} ${s.english} ${s.description} ${s.tags.join(' ')}`.toLowerCase().includes(w),
      ),
  );
  function apply(s: StylePreset) {
    onChange({ ...project, styleId: s.id, overrides: { light: {}, dark: {} } });
  }
  function openStyle(source: StylePreset, snapshot = false, edit = false) {
    setName(edit ? source.name : snapshot ? `${source.name} · 내 스타일` : `${source.name} 사본`);
    setDescription(source.description);
    setTags(source.tags.join(', '));
    setSaveMedium('all');
    setError('');
    setModal({ kind: 'style', source, snapshot, edit });
  }
  function saveStyle() {
    if (modal?.kind !== 'style') return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError('스타일 이름을 입력하세요.');
      return;
    }
    if (
      styles.some(
        (s) =>
          s.name.toLowerCase() === trimmed.toLowerCase() &&
          !(modal.edit && s.id === modal.source.id),
      )
    ) {
      setError('같은 이름의 스타일이 있습니다. 다른 이름을 입력하세요.');
      return;
    }
    const id = modal.edit ? modal.source.id : 'custom-' + uid(),
      parsedTags = [
        ...new Set(
          tags
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean),
        ),
      ].slice(0, 20),
      mediumName = { web: '웹', ppt: 'PPT', motion: '모션' }[saveMedium as Target];
    if (mediumName && !parsedTags.includes(mediumName)) parsedTags.push(mediumName);
    const custom: StylePreset = {
      ...modal.source,
      id,
      name: trimmed.slice(0, 100),
      description: description.trim().slice(0, 1000),
      english: 'MY STYLE',
      tags: parsedTags.map((t) => t.slice(0, 100)),
      custom: true,
      accent: modal.snapshot ? project.brand.color : modal.source.accent,
      dark: modal.snapshot
        ? {
            ...modal.source.dark,
            'color.accent': project.brand.color,
            'font.family': project.brand.font,
            ...project.overrides.dark,
          }
        : { ...modal.source.dark },
      light: modal.snapshot
        ? {
            ...modal.source.light,
            'color.accent': project.brand.color,
            'font.family': project.brand.font,
            ...project.overrides.light,
          }
        : { ...modal.source.light },
    };
    onChange({
      ...project,
      customStyles: modal.edit
        ? project.customStyles.map((s) => (s.id === id ? custom : s))
        : [...project.customStyles, custom],
      ...(!modal.edit ? { styleId: id, overrides: { light: {}, dark: {} } } : {}),
      ...(chosenCollection && !modal.edit
        ? {
            collections: project.collections.map((c) =>
              c.id === chosenCollection.id ? { ...c, styleIds: [...c.styleIds, id] } : c,
            ),
          }
        : {}),
    });
    setModal(null);
  }
  function openCollection(id?: string) {
    setName(project.collections.find((c) => c.id === id)?.name || '');
    setError('');
    setModal({ kind: 'collection', id });
  }
  function saveCollection() {
    if (modal?.kind !== 'collection') return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError('컬렉션 이름을 입력하세요.');
      return;
    }
    if (
      project.collections.some(
        (c) => c.id !== modal.id && c.name.toLowerCase() === trimmed.toLowerCase(),
      )
    ) {
      setError('같은 이름의 컬렉션이 있습니다.');
      return;
    }
    const id = modal.id || 'collection-' + uid();
    onChange({
      ...project,
      collections: modal.id
        ? project.collections.map((c) => (c.id === id ? { ...c, name: trimmed } : c))
        : [...project.collections, { id, name: trimmed, styleIds: [] }],
    });
    setCollection(id);
    setModal(null);
  }
  function deleteStyle(id: string) {
    onChange({
      ...project,
      customStyles: project.customStyles.filter((s) => s.id !== id),
      favorites: project.favorites.filter((s) => s !== id),
      collections: project.collections.map((c) => ({
        ...c,
        styleIds: c.styleIds.filter((s) => s !== id),
      })),
      ...(project.styleId === id
        ? { styleId: STYLES[0].id, overrides: { light: {}, dark: {} } }
        : {}),
    });
    setCompare((ids) => ids.filter((s) => s !== id));
    setModal(null);
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">YOUR CREATIVE FOUNDATION</span>
          <h1>나만의 디자인, 한곳에서.</h1>
          <p>마음에 드는 스타일을 고르고, 당신의 색으로 완성하세요.</p>
        </div>
        <button className="button secondary" onClick={() => openStyle(selected, true)}>
          <Plus size={16} />내 스타일 저장
        </button>
      </div>
      <div className="gallery-feature">
        <div className="feature-copy">
          <span className="tiny-label">
            <span className="status-dot" />
            현재 프로젝트에 적용 중
          </span>
          <h2>{selected.name}</h2>
          <p>{selected.description}</p>
          <div className="feature-tags">
            {selected.tags.slice(0, 4).map((t) => (
              <span key={t}>{t}</span>
            ))}
          </div>
          <button className="button primary" onClick={onEdit}>
            디자인 편집 <ArrowUpRight size={16} />
          </button>
        </div>
        <div className="feature-preview">
          <MiniPreview project={project} large kind={project.target} />
        </div>
        <div className="feature-number">
          {String(styles.findIndex((s) => s.id === selected.id) + 1).padStart(2, '0')}
          <small> / YOUR STYLE</small>
        </div>
      </div>
      <div className="section-heading">
        <div>
          <h2>
            스타일 라이브러리 <span>{styles.length.toString().padStart(2, '0')}</span>
          </h2>
          <p>동일한 콘텐츠와 브랜드 색으로 스타일의 차이를 비교해 보세요.</p>
        </div>
        <div className="segmented" aria-label="미리보기 매체">
          {(['web', 'ppt', 'motion'] as Target[]).map((t) => (
            <button
              key={t}
              aria-pressed={project.target === t}
              className={project.target === t ? 'active' : ''}
              onClick={() => onChange({ ...project, target: t })}
            >
              {t === 'web' ? '웹사이트' : t === 'ppt' ? 'PowerPoint' : '모션'}
            </button>
          ))}
        </div>
      </div>
      <div className="filter-row">
        <div className="filter-tabs">
          {['전체', '즐겨찾기', '내 스타일'].map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={filter === f ? 'active' : ''}
              aria-pressed={filter === f}
            >
              {f}
            </button>
          ))}
        </div>
        <label className="search-field">
          <Search size={15} />
          <input
            aria-label="스타일 검색"
            placeholder="이름, 분위기, 용도 검색"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>
      <div className="gallery-filters">
        <label>
          <Folder size={14} />
          <select
            aria-label="컬렉션 필터"
            value={collection}
            onChange={(e) => setCollection(e.target.value)}
          >
            <option value="">모든 컬렉션</option>
            {project.collections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.styleIds.filter((id) => styles.some((s) => s.id === id)).length}
              </option>
            ))}
          </select>
        </label>
        <button className="icon-button" aria-label="컬렉션 만들기" onClick={() => openCollection()}>
          <FolderPlus size={16} />
        </button>
        {chosenCollection && (
          <button
            className="icon-button"
            aria-label="컬렉션 이름 변경"
            onClick={() => openCollection(chosenCollection.id)}
          >
            <Pencil size={14} />
          </button>
        )}
        <select
          aria-label="용도 태그 필터"
          value={medium}
          onChange={(e) => setMedium(e.target.value)}
        >
          <option value="all">모든 용도 태그</option>
          <option value="web">웹 · 제품 · 포트폴리오</option>
          <option value="ppt">PPT · 업무 · 보고서</option>
          <option value="motion">모션 · 영상</option>
        </select>
        <select aria-label="스타일 태그 필터" value={tag} onChange={(e) => setTag(e.target.value)}>
          <option value="">모든 태그</option>
          {allTags.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        <span className="gallery-results" aria-live="polite">
          {visible.length}개 스타일
        </span>
        {(query || filter !== '전체' || medium !== 'all' || tag || collection) && (
          <button
            className="text-button"
            onClick={() => {
              setQuery('');
              setFilter('전체');
              setMedium('all');
              setTag('');
              setCollection('');
            }}
          >
            필터 초기화
          </button>
        )}
      </div>
      <div className="style-grid">
        {visible.map((s, i) => (
          <article
            key={s.id}
            className={`style-card ${project.styleId === s.id ? 'selected' : ''}`}
          >
            <div
              className="style-visual"
              onClick={() => apply(s)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  apply(s);
                }
              }}
              aria-label={`${s.name} 적용`}
            >
              <MiniPreview project={project} style={s} kind={project.target} />
              <span className="preview-badge">{project.mode === 'dark' ? 'DARK' : 'LIGHT'}</span>
            </div>
            <div className="style-details">
              <div>
                <span className="style-index">
                  {String(i + 1).padStart(2, '0')} / {s.english}
                </span>
                <h3>
                  {s.name}
                  {project.styleId === s.id && (
                    <span className="applied">
                      <Check size={12} />
                      적용 중
                    </span>
                  )}
                </h3>
                <p>{s.description}</p>
              </div>
              <button
                title="즐겨찾기"
                aria-label={`${s.name} 즐겨찾기`}
                aria-pressed={project.favorites.includes(s.id)}
                className={`icon-button ${project.favorites.includes(s.id) ? 'favorite' : ''}`}
                onClick={() =>
                  onChange({
                    ...project,
                    favorites: project.favorites.includes(s.id)
                      ? project.favorites.filter((x) => x !== s.id)
                      : [...project.favorites, s.id],
                  })
                }
              >
                <Heart
                  size={17}
                  fill={project.favorites.includes(s.id) ? 'currentColor' : 'none'}
                />
              </button>
            </div>
            <div className="gallery-card-tags">
              {s.tags.slice(0, 5).map((t) => (
                <button key={t} onClick={() => setTag(t)} title={`${t} 태그로 필터`}>
                  {t}
                </button>
              ))}
            </div>
            <div className="style-bottom">
              <div className="swatches">
                {[
                  s[project.mode]['color.bg'],
                  s[project.mode]['color.surface'],
                  s[project.mode]['color.text'],
                  project.brand.color,
                ].map((c, j) => (
                  <i key={j} style={{ background: String(c) }} />
                ))}
              </div>
              <button
                className={compare.includes(s.id) ? 'compare-check checked' : 'compare-check'}
                aria-pressed={compare.includes(s.id)}
                disabled={!compare.includes(s.id) && compared.length >= 4}
                onClick={() =>
                  setCompare(
                    compare.includes(s.id) ? compare.filter((x) => x !== s.id) : [...compare, s.id],
                  )
                }
              >
                <span>{compare.includes(s.id) && <Check size={11} />}</span>비교에 추가
              </button>
            </div>
            <div className="gallery-card-actions">
              <button
                className="text-button"
                onClick={() => openStyle(s)}
                aria-label={`${s.name} 복제`}
              >
                <Copy size={12} />
                복제
              </button>
              <button
                className="text-button"
                onClick={() => {
                  setMemberships(
                    project.collections.filter((c) => c.styleIds.includes(s.id)).map((c) => c.id),
                  );
                  setModal({ kind: 'assign', styleId: s.id });
                }}
                aria-label={`${s.name} 컬렉션 지정`}
              >
                <FolderPlus size={13} />
                컬렉션
              </button>
              {project.customStyles.some((c) => c.id === s.id) && (
                <>
                  <button
                    className="icon-button"
                    aria-label={`${s.name} 이름과 태그 편집`}
                    onClick={() => openStyle(s, false, true)}
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    className="icon-button gallery-delete"
                    aria-label={`${s.name} 삭제`}
                    onClick={() => setModal({ kind: 'delete', styleId: s.id })}
                  >
                    <Trash2 size={13} />
                  </button>
                </>
              )}
            </div>
          </article>
        ))}
      </div>
      {!visible.length && (
        <div className="empty-state">
          {chosenCollection
            ? `‘${chosenCollection.name}’에 일치하는 스타일이 없습니다. 전체 컬렉션으로 돌아가 카드의 컬렉션 버튼으로 스타일을 추가하세요.`
            : '일치하는 스타일이 없습니다. 검색어를 바꾸거나 새 스타일을 저장하세요.'}
        </div>
      )}
      {compared.length > 0 && (
        <div className="compare-tray">
          <Columns3 size={18} />
          <span>{compared.length}개 스타일 선택</span>
          <div className="compare-names">
            {compared.map((s) => (
              <span key={s.id}>{s.name}</span>
            ))}
          </div>
          <button
            className="button primary"
            disabled={compared.length < 2}
            onClick={() => setShowCompare(true)}
          >
            나란히 비교
          </button>
          <button
            className="icon-button"
            aria-label="비교 선택 지우기"
            onClick={() => setCompare([])}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {showCompare && (
        <GalleryDialog title="같은 내용, 다른 인상." onClose={() => setShowCompare(false)} wide>
          <p className="help">콘텐츠와 미리보기 크기를 통일해 비교합니다.</p>
          <div
            className="comparison-grid"
            style={{ gridTemplateColumns: `repeat(${Math.min(compared.length, 2)},1fr)` }}
          >
            {compared.map((s) => (
              <div key={s.id}>
                <MiniPreview project={project} style={s} kind={project.target} large />
                <h3>{s.name}</h3>
                <p>{s.description}</p>
                <button
                  className="button secondary"
                  onClick={() => {
                    apply(s);
                    setShowCompare(false);
                  }}
                >
                  <Check size={15} />이 스타일 적용
                </button>
              </div>
            ))}
          </div>
        </GalleryDialog>
      )}
      {modal?.kind === 'style' && (
        <GalleryDialog
          title={
            modal.edit
              ? '내 스타일 편집'
              : modal.snapshot
                ? '현재 디자인을 내 스타일로 저장'
                : '스타일 복제'
          }
          onClose={() => setModal(null)}
        >
          <form
            className="gallery-form"
            onSubmit={(e) => {
              e.preventDefault();
              saveStyle();
            }}
          >
            <label>
              스타일 이름
              <input
                autoFocus
                maxLength={100}
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </label>
            <label>
              설명
              <textarea
                maxLength={1000}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            <label>
              태그 · 쉼표로 구분
              <input
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="예: 포트폴리오, 차분한, 웹"
              />
            </label>
            <label>
              용도 태그 추가
              <select value={saveMedium} onChange={(e) => setSaveMedium(e.target.value)}>
                <option value="all">추가하지 않음</option>
                <option value="web">웹</option>
                <option value="ppt">PPT</option>
                <option value="motion">모션</option>
              </select>
            </label>
            {modal.snapshot && (
              <p className="help">
                현재 브랜드 색, 글꼴, 라이트·다크 토큰 변경사항을 함께 저장합니다.
              </p>
            )}
            {error && (
              <p className="error-text" role="alert">
                {error}
              </p>
            )}
            <div className="button-row">
              <button type="button" className="button secondary" onClick={() => setModal(null)}>
                취소
              </button>
              <button className="button primary" type="submit">
                <Check size={15} />
                {modal.edit ? '변경 저장' : '스타일 저장'}
              </button>
            </div>
          </form>
        </GalleryDialog>
      )}
      {modal?.kind === 'collection' && (
        <GalleryDialog
          title={modal.id ? '컬렉션 이름 변경' : '컬렉션 만들기'}
          onClose={() => setModal(null)}
        >
          <form
            className="gallery-form"
            onSubmit={(e) => {
              e.preventDefault();
              saveCollection();
            }}
          >
            <label>
              컬렉션 이름
              <input
                autoFocus
                maxLength={200}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="예: 업무 발표, 개인 포트폴리오"
                required
              />
            </label>
            {error && (
              <p className="error-text" role="alert">
                {error}
              </p>
            )}
            <div className="button-row">
              <button type="button" className="button secondary" onClick={() => setModal(null)}>
                취소
              </button>
              <button type="submit" className="button primary">
                저장
              </button>
            </div>
          </form>
        </GalleryDialog>
      )}
      {modal?.kind === 'assign' && (
        <GalleryDialog title="스타일을 컬렉션에 담기" onClose={() => setModal(null)}>
          <p className="help">
            {styles.find((s) => s.id === modal.styleId)?.name} · 여러 컬렉션에 담을 수 있습니다.
          </p>
          {project.collections.length ? (
            <>
              <div className="gallery-memberships">
                {project.collections.map((c) => (
                  <label key={c.id}>
                    <input
                      type="checkbox"
                      checked={memberships.includes(c.id)}
                      onChange={(e) =>
                        setMemberships((v) =>
                          e.target.checked ? [...v, c.id] : v.filter((id) => id !== c.id),
                        )
                      }
                    />
                    <span>{c.name}</span>
                    <small>{c.styleIds.length}개 스타일</small>
                  </label>
                ))}
              </div>
              <button
                className="button primary"
                onClick={() => {
                  onChange({
                    ...project,
                    collections: project.collections.map((c) => ({
                      ...c,
                      styleIds: memberships.includes(c.id)
                        ? [...new Set([...c.styleIds, modal.styleId])]
                        : c.styleIds.filter((id) => id !== modal.styleId),
                    })),
                  });
                  setModal(null);
                }}
              >
                컬렉션 지정 저장
              </button>
            </>
          ) : (
            <>
              <p className="help">먼저 컬렉션을 만들어 주세요.</p>
              <button className="button primary" onClick={() => openCollection()}>
                <FolderPlus size={14} />
                컬렉션 만들기
              </button>
            </>
          )}
        </GalleryDialog>
      )}
      {modal?.kind === 'delete' && (
        <GalleryDialog title="내 스타일을 삭제할까요?" onClose={() => setModal(null)}>
          <p className="gallery-delete-copy">
            ‘{styles.find((s) => s.id === modal.styleId)?.name}’을 라이브러리, 즐겨찾기와 컬렉션에서
            제거합니다.
            {project.styleId === modal.styleId &&
              ` 현재 프로젝트에는 ‘${STYLES[0].name}’이 적용됩니다.`}
          </p>
          <div className="button-row">
            <button className="button secondary" autoFocus onClick={() => setModal(null)}>
              취소
            </button>
            <button className="button gallery-danger" onClick={() => deleteStyle(modal.styleId)}>
              <Trash2 size={14} />
              스타일 삭제
            </button>
          </div>
        </GalleryDialog>
      )}
    </>
  );
}
