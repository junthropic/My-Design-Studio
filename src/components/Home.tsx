import {
  ArrowUpRight,
  Plus,
  Presentation,
  Globe,
  Clapperboard,
  FolderOpen,
  Clock,
  Download,
  CheckCircle2,
  AlertCircle,
  Palette,
  ChevronRight,
  Loader2,
} from 'lucide-react';
import type { Project, Job } from '../core/types';
import { STYLES } from '../core/presets';
import './Home.css';

export interface HomeProps {
  project: Project;
  projects: Project[];
  jobs: Job[];
  onOpenProject: (project: Project) => void;
  onNavigate: (page: string) => void;
  onNew: () => void;
  onExport: (format: string) => void;
}
const dateText = (value: string) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('ko-KR', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(date)
    : '수정일 없음';
};
const formats: Record<string, string> = {
  pptx: 'PowerPoint',
  web: '웹사이트',
  mp4: 'MP4 영상',
  webm: '투명 WebM',
  'png-sequence': 'PNG 시퀀스',
  tokens: '디자인 토큰',
  project: '프로젝트 백업',
  'after-effects': 'After Effects',
  blender: 'Blender',
};
const statusNames: Record<Job['status'], string> = {
  queued: '대기 중',
  running: '출력 중',
  completed: '완료',
  failed: '실패',
  canceled: '취소됨',
};

export function Home({
  project,
  projects,
  jobs,
  onOpenProject,
  onNavigate,
  onNew,
  onExport,
}: HomeProps) {
  const recent = [...new Map([...projects, project].map((p) => [p.id, p])).values()].sort(
    (a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0),
  );
  const currentJobs = jobs
      .filter((j) => j.projectId === project.id)
      .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0)),
    activeJobs = currentJobs.filter((j) => j.status === 'queued' || j.status === 'running');
  const duration =
    project.motion.scenes.reduce((sum, s) => sum + s.durationFrames, 0) / project.motion.fps;
  const style = [...STYLES, ...project.customStyles].find((s) => s.id === project.styleId);
  const media = [
    {
      id: 'ppt',
      name: 'PowerPoint',
      description: '이야기를 장표로 정리하세요.',
      count: `${project.slides.length}장 · ${project.slides.filter((s) => s.hidden).length}장 숨김`,
      icon: Presentation,
      format: 'pptx',
      code: 'SLIDE STUDIO',
    },
    {
      id: 'web',
      name: '웹사이트',
      description: '페이지를 구성하고 경험을 연결하세요.',
      count: `${project.webPages.length}페이지 · ${project.webPages.reduce((n, p) => n + p.sections.filter((s) => s.enabled).length, 0)}개 활성 섹션`,
      icon: Globe,
      format: 'web',
      code: 'WEB STUDIO',
    },
    {
      id: 'motion',
      name: '모션그래픽',
      description: '시간과 움직임으로 메시지를 전하세요.',
      count: `${project.motion.scenes.length}개 장면 · ${duration.toLocaleString('ko-KR', { maximumFractionDigits: 1 })}초`,
      icon: Clapperboard,
      format: 'mp4',
      code: 'MOTION STUDIO',
    },
  ];
  return (
    <div className="home-dashboard">
      <div className="page-heading">
        <div>
          <span className="eyebrow">YOUR CREATIVE WORKSPACE</span>
          <h1>다음 작업을 이어가세요.</h1>
          <p>이 PC에 저장한 프로젝트와 제작 중인 결과물을 한눈에 살펴봅니다.</p>
        </div>
        <button className="button secondary" onClick={onNew}>
          <Plus size={16} />새 프로젝트
        </button>
      </div>
      <section className="home-current">
        <div className="home-current-copy">
          <span className="tiny-label">
            <span className="status-dot" />
            현재 작업 중
          </span>
          <h2>{project.name}</h2>
          <p>
            {project.brand.name}
            <span> / </span>
            {style?.name || '사용자 스타일'}
            <span> / </span>
            {project.mode === 'dark' ? '다크' : '라이트'}
          </p>
          <div className="home-current-meta">
            <span>
              <Clock size={12} />
              {dateText(project.updatedAt)}
            </span>
            <span>Revision {project.revision}</span>
          </div>
          <div className="button-row">
            <button className="button primary" onClick={() => onNavigate(project.target)}>
              작업 이어가기 <ArrowUpRight size={16} />
            </button>
            <button className="button secondary" onClick={() => onNavigate('gallery')}>
              <Palette size={14} />
              스타일 고르기
            </button>
          </div>
        </div>
        <div className="home-project-map" aria-label="현재 프로젝트 구성">
          {media.map((m) => (
            <button
              key={m.id}
              className={`home-map-row ${project.target === m.id ? 'active' : ''}`}
              onClick={() => onNavigate(m.id)}
            >
              <m.icon size={20} />
              <span>
                <strong>{m.name}</strong>
                <small>{m.count}</small>
              </span>
              <ChevronRight size={15} />
            </button>
          ))}
        </div>
      </section>
      <div className="home-stat-row">
        <button
          onClick={() =>
            document
              .getElementById('home-recent-projects')
              ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }
        >
          <span>로컬 프로젝트</span>
          <strong>
            {recent.length}
            <small>개</small>
          </strong>
        </button>
        <button onClick={() => onNavigate('assets')}>
          <span>현재 프로젝트 자산</span>
          <strong>
            {project.assets.length}
            <small>개</small>
          </strong>
        </button>
        <button onClick={() => onNavigate('assets')}>
          <span>연결된 데이터</span>
          <strong>
            {project.datasets.length}
            <small>개</small>
          </strong>
        </button>
        <button onClick={() => onNavigate('export')}>
          <span>진행 중인 출력</span>
          <strong className={activeJobs.length ? 'home-active-count' : ''}>
            {activeJobs.length}
            <small>건</small>
          </strong>
        </button>
      </div>
      <div className="section-heading">
        <div>
          <h2>매체별 작업실</h2>
          <p>같은 브랜드 설정으로 필요한 결과물을 만듭니다.</p>
        </div>
      </div>
      <div className="home-media-grid">
        {media.map((m) => (
          <article className={`home-media-card home-media-${m.id}`} key={m.id}>
            <div className="home-media-top">
              <span className="home-media-icon">
                <m.icon size={23} />
              </span>
              <small>{m.code}</small>
            </div>
            <h3>{m.name}</h3>
            <p>{m.description}</p>
            <span className="home-media-count">{m.count}</span>
            <div className="home-media-actions">
              <button className="button secondary" onClick={() => onNavigate(m.id)}>
                작업실 열기 <ArrowUpRight size={14} />
              </button>
              <button
                className="icon-button"
                title={`${m.name} 내보내기`}
                aria-label={`${m.name} 바로 내보내기`}
                onClick={() => onExport(m.format)}
              >
                <Download size={16} />
              </button>
            </div>
          </article>
        ))}
      </div>
      <div className="home-lower-grid">
        <section className="panel home-recent" id="home-recent-projects">
          <div className="panel-heading">
            <div>
              <h2>최근 프로젝트</h2>
              <p>마지막 수정 순서</p>
            </div>
            <button className="icon-button" aria-label="새 프로젝트 만들기" onClick={onNew}>
              <Plus size={18} />
            </button>
          </div>
          <div className="home-project-list">
            {recent.slice(0, 6).map((p) => (
              <button
                key={p.id}
                className={`home-project-row ${p.id === project.id ? 'current' : ''}`}
                onClick={() => onOpenProject(p)}
              >
                <span
                  className="home-project-avatar"
                  style={{ background: p.brand.color + '25', color: p.brand.color }}
                >
                  <FolderOpen size={19} />
                </span>
                <span className="home-project-info">
                  <strong>
                    {p.name}
                    {p.id === project.id && <em>열림</em>}
                  </strong>
                  <small>
                    {p.slides.length}장 · {p.webPages.length}페이지 · {p.motion.scenes.length}개
                    장면
                  </small>
                </span>
                <span className="home-project-date">{dateText(p.updatedAt)}</span>
                <ChevronRight size={14} />
              </button>
            ))}
          </div>
        </section>
        <section className="panel home-recent-jobs">
          <div className="panel-heading">
            <div>
              <h2>최근 출력</h2>
              <p>{project.name}</p>
            </div>
            <button className="text-button" onClick={() => onNavigate('export')}>
              전체 보기 <ArrowUpRight size={12} />
            </button>
          </div>
          {currentJobs.length ? (
            <div className="home-job-list">
              {currentJobs.slice(0, 5).map((j) => (
                <article key={j.id} className="home-job-row">
                  <span className={`home-job-status ${j.status}`}>
                    {j.status === 'completed' ? (
                      <CheckCircle2 size={18} />
                    ) : j.status === 'failed' ? (
                      <AlertCircle size={18} />
                    ) : j.status === 'running' ? (
                      <Loader2 size={18} className="spin" />
                    ) : (
                      <Clock size={18} />
                    )}
                  </span>
                  <div>
                    <strong>
                      {formats[j.format] || j.format}
                      <span>{statusNames[j.status]}</span>
                    </strong>
                    <p title={j.error || j.message}>
                      {j.error || j.message || dateText(j.createdAt)}
                    </p>
                    <small>
                      {dateText(j.createdAt)} · Rev {j.revision}
                    </small>
                    {j.status === 'running' && (
                      <progress
                        aria-label={`${formats[j.format] || j.format} 진행률`}
                        max={100}
                        value={j.progress}
                      />
                    )}
                  </div>
                  {j.status === 'completed' && j.files?.length ? (
                    <a
                      className="icon-button"
                      aria-label={`${formats[j.format] || j.format} 결과 다운로드`}
                      href={`/api/jobs/${j.id}/files/0`}
                      download
                    >
                      <Download size={16} />
                    </a>
                  ) : (
                    <button
                      className="icon-button"
                      aria-label="출력 작업 확인"
                      onClick={() => onNavigate('export')}
                    >
                      <ChevronRight size={15} />
                    </button>
                  )}
                </article>
              ))}
            </div>
          ) : (
            <div className="home-no-jobs">
              <Download size={24} />
              <h3>아직 출력한 결과물이 없습니다.</h3>
              <p>작업을 마치면 검사와 함께 결과물을 내보내세요.</p>
              <button className="button secondary" onClick={() => onNavigate('export')}>
                검사·내보내기 열기
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
