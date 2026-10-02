import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  PanelsTopLeft,
  Palette,
  Presentation,
  Globe,
  Clapperboard,
  FolderOpen,
  ShieldCheck,
  Settings2,
  Plus,
  ArrowUpRight,
  ChevronDown,
  Undo2,
  Redo2,
  Sun,
  Moon,
  Upload,
  Download,
  Sparkles,
  X,
  Check,
  Command,
  Clock,
  ChevronRight,
  Home,
  Loader2,
} from 'lucide-react';
import { useStudio } from './store';
import { api, upload } from './api';
import type { Project, Job } from './core/types';
import { Gallery } from './components/Gallery';
import { Home as HomePage } from './components/Home';
import { DesignPanel } from './components/DesignPanel';
import { SlideEditor } from './components/SlideEditor';
import { WebEditor } from './components/WebEditor';
import { AssetsPanel } from './components/AssetsPanel';
import { ExportPanel } from './components/ExportPanel';
import { Connections } from './components/Connections';
import { AIPanel } from './components/AIPanel';
const MotionEditor = lazy(() => import('./motion/MotionEditor'));
const NAV = [
  { id: 'home', name: '홈', icon: Home },
  { id: 'gallery', name: '디자인 갤러리', icon: PanelsTopLeft },
  { id: 'design', name: '디자인 시스템', icon: Palette },
  { id: 'ppt', name: 'PowerPoint', icon: Presentation },
  { id: 'web', name: '웹사이트', icon: Globe },
  { id: 'motion', name: '모션그래픽', icon: Clapperboard },
  { id: 'assets', name: '자산·데이터', icon: FolderOpen },
  { id: 'export', name: '검사·내보내기', icon: ShieldCheck },
  { id: 'settings', name: '연결·설정', icon: Settings2 },
];
let initialization: Promise<Project> | null = null;
export default function App() {
  const { project, change, setProject, undo, redo, past, future, dirty, saveState } = useStudio();
  const [page, setPage] = useState('home'),
    [ai, setAI] = useState(false),
    [projects, setProjects] = useState<Project[]>([]),
    [projectMenu, setProjectMenu] = useState(false),
    [jobs, setJobs] = useState<Job[]>([]),
    [toast, setToast] = useState<{ message: string; error: boolean } | null>(null),
    [bootError, setBootError] = useState(''),
    [history, setHistory] = useState<any[] | null>(null),
    [newModal, setNewModal] = useState(false),
    [newName, setNewName] = useState('새 디자인 프로젝트');
  const importInput = useRef<HTMLInputElement>(null),
    savePromise = useRef<Promise<void> | null>(null),
    toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const notify = useCallback((message: string, error = false) => {
    setToast({ message, error });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), error ? 9000 : 4500);
  }, []);
  const onError = useCallback(
    (e: unknown) => notify(e instanceof Error ? e.message : String(e), true),
    [notify],
  );
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  }, [page]);
  useEffect(() => {
    if (!initialization)
      initialization = (async () => {
        const list = await api<Project[]>('/projects');
        return list[0] || (await api<Project>('/projects', { method: 'POST', body: '{}' }));
      })();
    initialization
      .then((p) => {
        setProject(p);
        void api<Project[]>('/projects').then(setProjects);
      })
      .catch((e) => setBootError(String(e.message)));
  }, [setProject]);
  const flush = useCallback(async () => {
    if (savePromise.current) {
      await savePromise.current;
      if (useStudio.getState().dirty) return flush();
      return;
    }
    const state = useStudio.getState();
    if (!state.project || !state.dirty) return;
    const snapshot = state.project;
    useStudio.setState({ saveState: '저장 중…' });
    const promise = (async () => {
      try {
        const saved = await api<Project>(`/projects/${snapshot.id}`, {
          method: 'PUT',
          body: JSON.stringify({ project: snapshot, baseRevision: snapshot.revision }),
        });
        const current = useStudio.getState().project;
        if (current?.id === snapshot.id) {
          const unchanged = current === snapshot;
          useStudio.setState({
            project: { ...current, revision: saved.revision, updatedAt: saved.updatedAt },
            dirty: !unchanged,
            saveState: unchanged ? '로컬에 저장됨' : '저장 대기',
          });
          setProjects((p) => p.map((x) => (x.id === saved.id ? saved : x)));
        }
      } catch (e) {
        useStudio.setState({ saveState: '저장 오류 · 다시 시도 필요' });
        throw e;
      } finally {
        savePromise.current = null;
      }
    })();
    savePromise.current = promise;
    return promise;
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const timeout = setTimeout(() => void flush().catch(onError), 750);
    return () => clearTimeout(timeout);
  }, [project, dirty, flush, onError]);
  useEffect(() => {
    if (!project) return;
    let alive = true;
    const poll = () =>
      api<Job[]>('/jobs?projectId=' + project.id)
        .then((r) => {
          if (alive) setJobs(r);
        })
        .catch(() => {});
    void poll();
    const t = setInterval(poll, 2500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [project?.id]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        void flush()
          .then(() => notify('프로젝트를 저장했습니다.'))
          .catch(onError);
      }
      if (
        (e.ctrlKey || e.metaKey) &&
        e.key === 'z' &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement)
      ) {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      }
      if (e.key === 'Escape') {
        setAI(false);
        setProjectMenu(false);
        setHistory(null);
        setNewModal(false);
      }
    };
    window.addEventListener('keydown', key);
    const before = (e: BeforeUnloadEvent) => {
      if (useStudio.getState().dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', before);
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('beforeunload', before);
    };
  }, [flush, notify, onError, undo, redo]);
  async function switchProject(p: Project) {
    try {
      await flush();
      setProject(await api('/projects/' + p.id));
      setProjectMenu(false);
    } catch (e) {
      onError(e);
    }
  }
  async function createNew() {
    try {
      await flush();
      const p = await api<Project>('/projects', {
        method: 'POST',
        body: JSON.stringify({ name: newName }),
      });
      setProject(p);
      setProjects([p, ...projects]);
      setNewModal(false);
      setPage('gallery');
      notify('새 작업실을 만들었습니다.');
    } catch (e) {
      onError(e);
    }
  }
  async function onExport(format: string) {
    try {
      await flush();
      const current = useStudio.getState().project!;
      const job = await api<Job>(`/projects/${current.id}/export`, {
        method: 'POST',
        body: JSON.stringify({ format }),
      });
      setJobs((j) => [job, ...j]);
      setPage('export');
      notify('내보내기 작업을 시작했습니다.');
    } catch (e) {
      onError(e);
    }
  }
  async function importFile(file: File) {
    try {
      await flush();
      const result = await upload('/import', file);
      const p = result.project || result;
      setProject(p);
      setProjects(await api('/projects'));
      const report = await api<any>(`/projects/${p.id}/import-report`).catch(() => null);
      if (report?.warnings?.length) result.warnings = report.warnings;
      notify(
        result.warnings?.length
          ? `프로젝트를 가져왔습니다. 이전 보고: ${result.warnings.join(' / ')}`
          : '프로젝트를 가져왔습니다.',
      );
    } catch (e) {
      onError(e);
    }
  }
  if (!project)
    return (
      <div className="boot-screen">
        <div className="brand-mark">
          <PanelsTopLeft size={26} />
        </div>
        <h1>Design Studio</h1>
        {bootError ? (
          <>
            <p>{bootError}</p>
            <button
              className="button primary"
              onClick={() => {
                initialization = null;
                location.reload();
              }}
            >
              다시 연결
            </button>
          </>
        ) : (
          <>
            <Loader2 className="spin" />
            <p>작업실을 준비하고 있습니다.</p>
          </>
        )}
      </div>
    );
  return (
    <div className={`app-shell ${ai ? 'ai-open' : ''}`}>
      <link
        rel="stylesheet"
        href={`/api/fonts.css?projectId=${project.id}&revision=${project.revision}`}
      />
      <aside className="sidebar">
        <div className="app-brand">
          <div className="brand-mark">
            <PanelsTopLeft size={20} />
          </div>
          <div>
            <strong>Design Studio</strong>
            <span>YOUR CREATIVE SPACE</span>
          </div>
        </div>
        <div className="workspace-switch">
          <button onClick={() => setProjectMenu(!projectMenu)}>
            <span className="workspace-avatar">J</span>
            <span>
              <strong>{project.name}</strong>
              <small>개인 작업 공간</small>
            </span>
            <ChevronDown size={15} />
          </button>
          {projectMenu && (
            <div className="project-menu">
              {projects.map((p) => (
                <button key={p.id} onClick={() => void switchProject(p)}>
                  <span>{p.name}</span>
                  {p.id === project.id && <Check size={14} />}
                </button>
              ))}
              <button
                onClick={() => {
                  setNewModal(true);
                  setProjectMenu(false);
                }}
              >
                <Plus size={14} />새 프로젝트
              </button>
            </div>
          )}
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {NAV.map((n, i) => (
            <div key={n.id}>
              {i === 3 && <div className="nav-label spaced">CREATE</div>}
              {i === 6 && <div className="nav-separator" />}
              <button
                className={`nav-item ${page === n.id ? 'active' : ''}`}
                onClick={() => setPage(n.id)}
              >
                <n.icon size={18} />
                <span>{n.name}</span>
                {page === n.id && <span className="nav-active-dot" />}
                {n.id === 'assets' && project.assets.length > 0 && (
                  <small>{project.assets.length}</small>
                )}
              </button>
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-status">
            <span className="status-dot" />
            <div>
              <strong>로컬 작업 공간</strong>
              <small>프로젝트는 이 PC에 저장됩니다.</small>
            </div>
          </div>
          <button className="sidebar-create" onClick={() => setNewModal(true)}>
            <Plus size={16} />새 프로젝트
            <ArrowUpRight size={16} />
          </button>
          <div className="version-line">
            <span>DESIGN STUDIO</span>
            <code>v0.1.0</code>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <Home size={14} />
            <ChevronRight size={12} />
            <span>작업 공간</span>
            <ChevronRight size={12} />
            <strong>{NAV.find((n) => n.id === page)?.name}</strong>
          </div>
          <div className="topbar-actions">
            <button
              className="save-indicator"
              title="저장하기"
              onClick={() => void flush().catch(onError)}
            >
              <span className={dirty ? 'unsaved-dot' : 'status-dot'} />
              {saveState}
            </button>
            <div className="topbar-divider" />
            <button
              className="icon-button"
              title="되돌리기 (Ctrl+Z)"
              aria-label="되돌리기"
              disabled={!past.length}
              onClick={undo}
            >
              <Undo2 size={16} />
            </button>
            <button
              className="icon-button"
              title="다시 실행 (Ctrl+Shift+Z)"
              aria-label="다시 실행"
              disabled={!future.length}
              onClick={redo}
            >
              <Redo2 size={16} />
            </button>
            <button
              className="icon-button"
              title="변경 이력"
              aria-label="변경 이력"
              onClick={() =>
                void flush()
                  .then(() => api<any[]>(`/projects/${project.id}/revisions`))
                  .then(setHistory)
                  .catch(onError)
              }
            >
              <Clock size={16} />
            </button>
            <div className="theme-switch">
              <button
                aria-label="라이트 모드"
                className={project.mode === 'light' ? 'active' : ''}
                onClick={() => change({ ...project, mode: 'light' })}
              >
                <Sun size={14} />
              </button>
              <button
                aria-label="다크 모드"
                className={project.mode === 'dark' ? 'active' : ''}
                onClick={() => change({ ...project, mode: 'dark' })}
              >
                <Moon size={14} />
              </button>
            </div>
            <button className="button secondary small" onClick={() => importInput.current?.click()}>
              <Upload size={14} />
              불러오기
            </button>
            <button className="button primary small" onClick={() => setPage('export')}>
              <Download size={14} />
              내보내기
            </button>
          </div>
        </header>
        <input
          ref={importInput}
          hidden
          type="file"
          accept=".designstudio,.zip,.json"
          onChange={(e) => {
            if (e.target.files?.[0]) void importFile(e.target.files[0]);
            e.target.value = '';
          }}
        />
        <main className={`main-content page-${page}`}>
          {page === 'home' ? (
            <HomePage
              project={project}
              projects={projects}
              jobs={jobs}
              onOpenProject={(p) => void switchProject(p)}
              onNavigate={setPage}
              onNew={() => setNewModal(true)}
              onExport={(f) => void onExport(f)}
            />
          ) : page === 'gallery' ? (
            <Gallery project={project} onChange={change} onEdit={() => setPage('design')} />
          ) : page === 'design' ? (
            <DesignPanel project={project} onChange={change} />
          ) : page === 'ppt' ? (
            <SlideEditor project={project} onChange={change} onExport={(f) => void onExport(f)} />
          ) : page === 'web' ? (
            <WebEditor project={project} onChange={change} onExport={(f) => void onExport(f)} />
          ) : page === 'motion' ? (
            <Suspense
              fallback={
                <div className="empty-state">
                  <Loader2 className="spin" />
                  모션 작업실을 준비합니다.
                </div>
              }
            >
              <MotionEditor
                project={project}
                onChange={change}
                onExport={(f) => void onExport(f)}
              />
            </Suspense>
          ) : page === 'assets' ? (
            <AssetsPanel
              project={project}
              onChange={change}
              onSaved={setProject}
              beforeAction={flush}
              onError={onError}
            />
          ) : page === 'settings' ? (
            <Connections
              project={project}
              onSaved={setProject}
              beforeAction={flush}
              onError={onError}
            />
          ) : (
            <ExportPanel
              project={project}
              jobs={jobs}
              onExport={(f) => void onExport(f)}
              onCancel={(id) =>
                void api(`/jobs/${id}/cancel`, { method: 'POST', body: '{}' }).catch(onError)
              }
            />
          )}
          <footer className="page-footer">
            <span>좋은 디자인은, 나만의 기준에서.</span>
            <span>
              {project.brand.name} <i /> {project.mode === 'dark' ? 'Dark' : 'Light'} <i /> Revision{' '}
              {project.revision}
            </span>
          </footer>
        </main>
      </div>
      {!ai && (
        <button className="ai-fab" aria-label="AI 디자인 파트너 열기" onClick={() => setAI(true)}>
          <Sparkles size={20} />
          <span>디자인 파트너</span>
        </button>
      )}
      {ai && (
        <AIPanel
          project={project}
          onClose={() => setAI(false)}
          onSaved={setProject}
          beforeAction={flush}
          onError={onError}
        />
      )}
      {toast && (
        <div
          className={`toast ${toast.error ? 'error' : ''}`}
          role={toast.error ? 'alert' : 'status'}
        >
          {toast.error ? <X size={17} /> : <Check size={17} />}
          <span>{toast.message}</span>
          <button aria-label="알림 닫기" onClick={() => setToast(null)}>
            <X size={14} />
          </button>
        </div>
      )}
      {newModal && (
        <div className="modal-backdrop">
          <section className="modal" role="dialog" aria-modal="true" aria-label="새 프로젝트">
            <div className="modal-title">
              <h2>새로운 작업을 시작하세요.</h2>
              <button
                className="icon-button"
                aria-label="새 프로젝트 닫기"
                onClick={() => setNewModal(false)}
              >
                <X size={18} />
              </button>
            </div>
            <label>
              프로젝트 이름
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newName.trim()) void createNew();
                }}
              />
            </label>
            <p className="help">스타일 6종, 슬라이드 10장, 웹 3종, 15초 모션 예시로 시작합니다.</p>
            <button
              className="button primary"
              disabled={!newName.trim()}
              onClick={() => void createNew()}
            >
              <Plus size={15} />
              작업실 만들기
            </button>
          </section>
        </div>
      )}
      {history && (
        <div className="modal-backdrop">
          <section className="modal" role="dialog" aria-modal="true" aria-label="변경 이력">
            <div className="modal-title">
              <h2>프로젝트 변경 이력</h2>
              <button
                className="icon-button"
                aria-label="변경 이력 닫기"
                onClick={() => setHistory(null)}
              >
                <X size={18} />
              </button>
            </div>
            <div className="history-list">
              {history.map((r: any, i) => (
                <div key={i}>
                  <div>
                    <strong>Revision {r.revision ?? r.version}</strong>
                    <small>
                      {new Date(r.createdAt || r.updatedAt || r.at).toLocaleString('ko-KR')}
                    </small>
                  </div>
                  <button
                    className="button secondary"
                    onClick={() =>
                      void flush()
                        .then(() =>
                          api<Project>(`/projects/${project.id}/restore`, {
                            method: 'POST',
                            body: JSON.stringify({
                              revision: r.revision,
                              baseRevision: useStudio.getState().project!.revision,
                            }),
                          }),
                        )
                        .then((p) => {
                          setProject(p);
                          setHistory(null);
                          notify('선택한 버전을 복원했습니다.');
                        })
                        .catch(onError)
                    }
                  >
                    이 버전 복원
                  </button>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
