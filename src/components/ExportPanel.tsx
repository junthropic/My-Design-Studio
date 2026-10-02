import {
  Download,
  FileCheck,
  CheckCircle2,
  AlertCircle,
  Clock,
  X,
  Package,
  Monitor,
  Film,
  FileText,
  ArrowUpRight,
} from 'lucide-react';
import type { Project, Job } from '../core/types';
import { resolveDesign, validateDocument } from '../core/design';
const formats = [
  ['pptx', 'PowerPoint', '편집 가능한 장표 · 텍스트·도형·표·차트', FileText],
  ['web', '웹사이트', '반응형 정적 웹 + React 소스', Monitor],
  ['mp4', 'MP4 영상', 'H.264 · 선택한 해상도와 fps', Film],
  ['webm', '투명 WebM', '알파 채널을 포함한 영상', Film],
  ['png-sequence', 'PNG 시퀀스', '개별 프레임 이미지 묶음', Film],
  ['tokens', '디자인 토큰', 'DTCG · CSS · DESIGN 문서', FileCheck],
  ['project', '프로젝트 백업', '원본·자산을 담은 .designstudio', Package],
  ['after-effects', 'After Effects', 'JSX·장면 JSON·자산 전달 패키지', ArrowUpRight],
  ['blender', 'Blender', '장면 설정·Python·자산 패키지', ArrowUpRight],
] as const;
export function ExportPanel({
  project,
  jobs,
  onExport,
  onCancel,
}: {
  project: Project;
  jobs: Job[];
  onExport: (f: string) => void;
  onCancel: (id: string) => void;
}) {
  const report = validateDocument(project, resolveDesign(project));
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">PREFLIGHT & EXPORT</span>
          <h1>확인하고, 세상으로.</h1>
          <p>현재 버전을 고정한 뒤 결과물과 변환 보고서를 함께 만듭니다.</p>
        </div>
        <span className="pill">REV {project.revision.toString().padStart(3, '0')}</span>
      </div>
      <div className="stat-strip">
        <div>
          <span>자동 검사 통과</span>
          <strong className="green">
            {report.passed}
            <small>개 색 쌍</small>
          </strong>
        </div>
        <div>
          <span>수정 필요</span>
          <strong>
            {report.failed}
            <small>개 오류</small>
          </strong>
        </div>
        <div>
          <span>직접 확인</span>
          <strong>
            {report.manual}
            <small>개 항목</small>
          </strong>
        </div>
        <div className="stat-note">
          자동 검사 통과는
          <br />
          전체 접근성 검수를 대신하지 않습니다.
        </div>
      </div>
      <section className="panel">
        <div className="panel-heading">
          <h2>출력 전 확인</h2>
          <span>현재 문서 기준</span>
        </div>
        {report.issues.map((i) => (
          <div className={`issue-row ${i.severity}`} key={i.id}>
            {i.severity === 'error' ? <AlertCircle size={16} /> : <Clock size={16} />}
            <span className="issue-label">
              {i.severity === 'error' ? '오류' : i.severity === 'warning' ? '주의' : '수동 확인'}
            </span>
            <span>{i.message}</span>
          </div>
        ))}
      </section>
      <div className="section-heading">
        <div>
          <h2>내보내기 형식</h2>
          <p>각 매체에서 지원하는 표현은 함께 생성되는 보고서에 기록됩니다.</p>
        </div>
      </div>
      <div className="export-grid">
        {formats.map(([id, name, description, Icon]) => (
          <button className="export-card" key={id} onClick={() => onExport(id)}>
            <span className="export-icon">
              <Icon size={22} />
            </span>
            <strong>{name}</strong>
            <p>{description}</p>
            <span className="export-arrow">
              <Download size={16} />
            </span>
          </button>
        ))}
      </div>
      <section className="panel job-panel">
        <div className="panel-heading">
          <h2>작업 이력</h2>
          <span>{jobs.length}개 작업</span>
        </div>
        {!jobs.length ? (
          <p className="help">출력 형식을 선택하면 작업이 여기에 표시됩니다.</p>
        ) : (
          jobs.map((j) => (
            <div className="job-row" key={j.id}>
              <div className={`job-icon ${j.status}`}>
                {j.status === 'completed' ? (
                  <CheckCircle2 size={18} />
                ) : j.status === 'failed' ? (
                  <AlertCircle size={18} />
                ) : (
                  <Clock size={18} />
                )}
              </div>
              <div className="job-info">
                <strong>
                  {formats.find((f) => f[0] === j.format)?.[1] || j.format}
                  <span>REV {j.revision}</span>
                </strong>
                <p>
                  {j.error ||
                    j.message ||
                    {
                      queued: '대기 중',
                      running: '만드는 중',
                      completed: '완료',
                      failed: '실패',
                      canceled: '취소됨',
                    }[j.status]}
                </p>
                {j.status === 'running' && <progress max="100" value={j.progress} />}
                <small>{new Date(j.createdAt).toLocaleString('ko-KR')}</small>
              </div>
              <div className="job-files">
                {j.files?.map((f, i) => (
                  <a
                    key={i}
                    className="button secondary"
                    href={`/api/jobs/${j.id}/files/${i}`}
                    download
                  >
                    <Download size={13} />
                    {f.name}
                  </a>
                ))}
                {(j.status === 'queued' || j.status === 'running') && (
                  <button
                    className="icon-button"
                    aria-label="작업 취소"
                    onClick={() => onCancel(j.id)}
                  >
                    <X size={16} />
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </section>
    </>
  );
}
