import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Copy, Pencil, Plus, Trash2, X } from 'lucide-react';
import type { Project } from '../core/types';

export type ProjectAction = 'duplicate' | 'rename' | 'delete';
export function ProjectMenu({
  project,
  projects,
  onSelect,
  onNew,
  onAction,
  onError,
}: {
  project: Project;
  projects: Project[];
  onSelect: (p: Project) => Promise<void>;
  onNew: () => void;
  onAction: (action: ProjectAction, p: Project, name: string) => Promise<void>;
  onError: (e: unknown) => void;
}) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ action: ProjectAction; project: Project } | null>(null);
  const [name, setName] = useState(''),
    [error, setError] = useState('');
  const root = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null),
    pending = useRef(false);
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, []);
  useEffect(() => {
    if (editing) dialog.current?.showModal();
  }, [editing]);
  function close() {
    if (!pending.current) {
      dialog.current?.close();
      setEditing(null);
      trigger.current?.focus();
    }
  }
  function edit(action: ProjectAction, p: Project) {
    let copyName = p.name.slice(0, 188) + ' · 사본',
      suffix = 2;
    while (projects.some((x) => x.name === copyName))
      copyName = p.name.slice(0, 180) + ` · 사본 ${suffix++}`;
    setName(action === 'duplicate' ? copyName : p.name);
    setError('');
    setEditing({ action, project: p });
    setOpen(false);
  }
  const title =
    editing?.action === 'delete'
      ? '프로젝트 삭제'
      : editing?.action === 'rename'
        ? '프로젝트 이름 변경'
        : '프로젝트 복제';
  return (
    <div className="workspace-switch" ref={root}>
      <button
        ref={trigger}
        aria-label="프로젝트 선택"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen(!open)}
      >
        <span className="workspace-avatar">{project.name.slice(0, 1)}</span>
        <span>
          <strong>{project.name}</strong>
          <small>개인 작업 공간</small>
        </span>
        <ChevronDown size={15} />
      </button>
      {open && (
        <div className="project-menu" role="region" aria-label="프로젝트 목록">
          {projects.map((p) => (
            <div className="project-menu-row" key={p.id}>
              <button
                className="project-menu-select"
                aria-label={`${p.name} 열기`}
                aria-current={p.id === project.id ? 'true' : undefined}
                disabled={busy}
                onClick={async () => {
                  if (pending.current) return;
                  pending.current = true;
                  setBusy(true);
                  try {
                    await onSelect(p);
                    setOpen(false);
                  } catch (e) {
                    onError(e);
                  } finally {
                    pending.current = false;
                    setBusy(false);
                  }
                }}
              >
                <span>{p.name}</span>
                {p.id === project.id && <Check size={14} />}
              </button>
              <div className="project-menu-tools">
                <button
                  aria-label={`${p.name} 이름 변경`}
                  title="이름 변경"
                  onClick={() => edit('rename', p)}
                >
                  <Pencil size={14} />
                </button>
                <button
                  aria-label={`${p.name} 복제`}
                  title="복제"
                  onClick={() => edit('duplicate', p)}
                >
                  <Copy size={14} />
                </button>
                <button
                  aria-label={`${p.name} 삭제`}
                  title="삭제"
                  onClick={() => edit('delete', p)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
          <button
            onClick={() => {
              setOpen(false);
              onNew();
            }}
          >
            <Plus size={14} />새 프로젝트
          </button>
        </div>
      )}
      {editing && (
        <dialog
          ref={dialog}
          className="modal project-dialog"
          aria-label={title}
          onCancel={(e) => {
            e.preventDefault();
            close();
          }}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (pending.current || !name.trim()) return;
              pending.current = true;
              setBusy(true);
              setError('');
              try {
                await onAction(editing.action, editing.project, name.trim());
                pending.current = false;
                close();
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally {
                pending.current = false;
                setBusy(false);
              }
            }}
          >
            <div className="modal-title">
              <h2>{title}</h2>
              <button
                type="button"
                className="icon-button"
                aria-label="프로젝트 작업 닫기"
                disabled={busy}
                onClick={close}
              >
                <X size={18} />
              </button>
            </div>
            {editing.action === 'delete' ? (
              <p>
                “{editing.project.name}” 프로젝트와 편집 이력을 삭제합니다. 되돌릴 수 없습니다.
                복제본의 자산과 이미 내보낸 파일은 유지됩니다. 필요한 경우 먼저 프로젝트를
                내보내세요.
              </p>
            ) : (
              <label>
                프로젝트 이름
                <input
                  autoFocus
                  maxLength={200}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={busy}
                />
              </label>
            )}
            {editing.action === 'duplicate' && (
              <p className="help">
                현재 편집 내용을 저장한 뒤 디자인·슬라이드·웹·모션·자산·데이터를 복제합니다. 변경
                이력과 출력 작업은 새로 시작합니다.
              </p>
            )}
            {error && (
              <p role="alert" className="error-text">
                {error}
              </p>
            )}
            <div className="button-row">
              <button
                type="button"
                className="button secondary"
                autoFocus={editing.action === 'delete'}
                disabled={busy}
                onClick={close}
              >
                취소
              </button>
              <button
                className={`button ${editing.action === 'delete' ? 'danger' : 'primary'}`}
                disabled={busy || !name.trim()}
              >
                {busy ? '처리 중…' : title}
              </button>
            </div>
          </form>
        </dialog>
      )}
    </div>
  );
}
