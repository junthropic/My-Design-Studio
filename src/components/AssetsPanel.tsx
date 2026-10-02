import { useEffect, useRef, useState } from 'react';
import {
  Upload,
  FileImage,
  FileSpreadsheet,
  Link2,
  Plus,
  Database,
  Music,
  Film,
  Trash2,
} from 'lucide-react';
import type { Project, Dataset } from '../core/types';
import { api, upload } from '../api';
export function AssetsPanel({
  project,
  onChange,
  onSaved,
  beforeAction,
  onError,
}: {
  project: Project;
  onChange: (p: Project) => void;
  onSaved: (p: Project) => void;
  beforeAction: () => Promise<void>;
  onError: (e: unknown) => void;
}) {
  const assetInput = useRef<HTMLInputElement>(null),
    dataInput = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState('assets'),
    [busy, setBusy] = useState(false),
    [dataId, setDataId] = useState(project.datasets[0]?.id),
    [url, setUrl] = useState(''),
    [responsePath, setResponsePath] = useState(''),
    [search, setSearch] = useState(''),
    [headers, setHeaders] = useState('{}'),
    [secret, setSecret] = useState(''),
    [workbook, setWorkbook] = useState<{ file: File; info: any } | null>(null),
    [sheet, setSheet] = useState(''),
    [range, setRange] = useState('');
  const workbookDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (workbook && !workbookDialog.current?.open) workbookDialog.current?.showModal();
  }, [workbook]);
  const data = project.datasets.find((d) => d.id === dataId) || project.datasets[0];
  async function addFile(file: File, kind: 'assets' | 'datasets', fields?: Record<string, string>) {
    setBusy(true);
    try {
      if (kind === 'datasets' && /\.xlsx$/i.test(file.name) && !fields) {
        const info = await upload('/datasets/inspect', file);
        const first = info.sheets.find((s: any) => !s.hidden) || info.sheets[0];
        setWorkbook({ file, info });
        setSheet(first?.name || '');
        setRange(first?.defaultRange || '');
        return;
      }
      await beforeAction();
      const result = await upload(`/projects/${project.id}/${kind}`, file, fields);
      setWorkbook(null);
      onSaved(result.project);
      if (result.dataset) setDataId(result.dataset.id);
      setSecret('');
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }
  async function fetchData() {
    setBusy(true);
    try {
      await beforeAction();
      const secretRef = secret ? `data_${project.id}` : undefined;
      if (secretRef)
        await api(`/settings/secrets/${secretRef}`, {
          method: 'PUT',
          body: JSON.stringify({ key: secret }),
        });
      const result = await api(`/projects/${project.id}/datasets/fetch`, {
        method: 'POST',
        body: JSON.stringify({
          url,
          responsePath,
          headers: JSON.parse(headers),
          secretRef,
          name: 'API 데이터',
        }),
      });
      onSaved(result.project);
      setDataId(result.dataset.id);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {workbook && (
        <dialog
          ref={workbookDialog}
          className="modal gallery-dialog workbook-modal"
          onCancel={(e) => {
            e.preventDefault();
            setWorkbook(null);
          }}
          aria-label="Excel 가져오기"
        >
          <div className="modal-title">
            <h2>시트와 범위를 선택하세요.</h2>
            <button className="button secondary" onClick={() => setWorkbook(null)}>
              닫기
            </button>
          </div>
          <p>{workbook.file.name}</p>
          <div className="two-columns">
            <label>
              시트
              <select
                value={sheet}
                onChange={(e) => {
                  setSheet(e.target.value);
                  setRange(
                    workbook.info.sheets.find((s: any) => s.name === e.target.value)
                      ?.defaultRange || '',
                  );
                }}
              >
                {workbook.info.sheets.map((s: any) => (
                  <option key={s.name} value={s.name}>
                    {s.name} · {s.rowCount}행{s.hidden ? ' (숨김)' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label>
              범위
              <input
                aria-label="가져올 셀 범위"
                placeholder="A1:F10000"
                value={range}
                onChange={(e) => setRange(e.target.value)}
              />
            </label>
          </div>
          <p className="help">
            선택한 범위의 첫 행을 열 이름으로 사용합니다. 수식은 Excel에서 저장된 결과를 읽습니다.
          </p>
          <div className="data-table-wrap">
            <table>
              <tbody>
                {(workbook.info.sheets.find((s: any) => s.name === sheet)?.preview || []).map(
                  (r: string[], i: number) => (
                    <tr key={i}>
                      {r.map((v, j) => (
                        <td key={j}>{v}</td>
                      ))}
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
          <button
            className="button primary"
            disabled={busy || !sheet}
            onClick={() =>
              void addFile(workbook.file, 'datasets', { sheet, ...(range ? { range } : {}) })
            }
          >
            {busy ? '가져오는 중…' : '선택 범위 가져오기'}
          </button>
        </dialog>
      )}
      <div className="page-heading">
        <div>
          <span className="eyebrow">ASSETS & DATA</span>
          <h1>작업의 재료를 모으세요.</h1>
          <p>한 번 추가한 자산을 모든 제작물에서 함께 사용합니다.</p>
        </div>
        <button
          className="button primary"
          disabled={busy}
          onClick={() =>
            tab === 'assets' ? assetInput.current?.click() : dataInput.current?.click()
          }
        >
          <Upload size={16} />
          {busy ? '가져오는 중…' : tab === 'assets' ? '자산 가져오기' : '데이터 가져오기'}
        </button>
      </div>
      <input
        ref={assetInput}
        type="file"
        hidden
        accept="image/*,video/*,audio/*,.woff,.woff2,.ttf,.otf"
        onChange={(e) => {
          if (e.target.files?.[0]) void addFile(e.target.files[0], 'assets');
          e.target.value = '';
        }}
      />
      <input
        ref={dataInput}
        type="file"
        hidden
        accept=".csv,.xlsx,.json"
        onChange={(e) => {
          if (e.target.files?.[0]) void addFile(e.target.files[0], 'datasets');
          e.target.value = '';
        }}
      />
      <div className="filter-tabs page-tabs">
        {[
          ['assets', '자산 라이브러리'],
          ['data', '데이터 연결'],
        ].map(([id, label]) => (
          <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
            {label}
            <span>{id === 'assets' ? project.assets.length : project.datasets.length}</span>
          </button>
        ))}
      </div>
      {tab === 'assets' ? (
        <>
          <div
            className="upload-zone"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (e.dataTransfer.files[0]) void addFile(e.dataTransfer.files[0], 'assets');
            }}
          >
            <div className="upload-symbol">
              <Upload size={24} />
            </div>
            <h3>이미지·영상·오디오·글꼴을 추가하세요.</h3>
            <p>파일을 여기에 놓거나 가져오기 버튼을 사용하세요.</p>
            <button className="button secondary" onClick={() => assetInput.current?.click()}>
              파일 선택
            </button>
          </div>
          <div className="asset-grid">
            {project.assets.map((a) => (
              <article className="asset-card" key={a.id}>
                <div className="asset-thumb">
                  {a.mime.startsWith('image/') ? (
                    <img src={'/api/assets/' + a.id} alt={a.name} />
                  ) : a.mime.startsWith('video/') ? (
                    <video src={'/api/assets/' + a.id} controls preload="metadata" />
                  ) : a.mime.startsWith('audio/') ? (
                    <>
                      <Music />
                      <audio src={'/api/assets/' + a.id} controls />
                    </>
                  ) : (
                    <span className="font-specimen">Aa 가</span>
                  )}
                </div>
                <div className="asset-caption">
                  <strong title={a.name}>{a.name}</strong>
                  <span>
                    {(a.size / 1024).toFixed(0)} KB · {a.mime.split('/')[1]}
                  </span>
                  <label>
                    출처
                    <input
                      placeholder="직접 제작, 다운로드 URL 등"
                      value={a.source || ''}
                      onChange={(e) =>
                        onChange({
                          ...project,
                          assets: project.assets.map((x) =>
                            x.id === a.id ? { ...x, source: e.target.value } : x,
                          ),
                        })
                      }
                    />
                  </label>
                  <label>
                    사용 조건
                    <input
                      placeholder="개인 제작 / 사용권 정보"
                      value={a.license || ''}
                      onChange={(e) =>
                        onChange({
                          ...project,
                          assets: project.assets.map((x) =>
                            x.id === a.id ? { ...x, license: e.target.value } : x,
                          ),
                        })
                      }
                    />
                  </label>
                </div>
              </article>
            ))}
          </div>
        </>
      ) : (
        <div className="data-layout">
          <aside className="panel">
            <div className="panel-heading">
              <h2>연결된 데이터</h2>
              <Database size={16} />
            </div>
            {project.datasets.map((d) => (
              <button
                key={d.id}
                className={`dataset-item ${d.id === data?.id ? 'active' : ''}`}
                onClick={() => setDataId(d.id)}
              >
                <FileSpreadsheet size={18} />
                <div>
                  <strong>{d.name}</strong>
                  <small>
                    {d.rows.length.toLocaleString()}행 · {d.columns.length}열
                  </small>
                </div>
              </button>
            ))}
            <div className="inspector-section">
              <h3>
                <Link2 size={15} />
                REST API 조회
              </h3>
              <label>
                조회 URL
                <input
                  placeholder="https://api.example.com/data"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                />
              </label>
              <label>
                응답 경로
                <input
                  placeholder="data.items (선택)"
                  value={responsePath}
                  onChange={(e) => setResponsePath(e.target.value)}
                />
              </label>
              <label>
                인증 토큰 (선택)
                <input
                  type="password"
                  autoComplete="off"
                  placeholder="Bearer 토큰 · 보안 저장"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                />
              </label>
              <label>
                공개 요청 헤더 (JSON)
                <textarea
                  className="code-area"
                  value={headers}
                  onChange={(e) => setHeaders(e.target.value)}
                />
              </label>
              <button
                className="button primary"
                disabled={busy || !url}
                onClick={() => void fetchData()}
              >
                데이터 조회
              </button>
              <p className="help">
                GET 요청만 실행합니다. 인증 정보는 내보내는 데이터 스냅샷에서 제외됩니다.
              </p>
            </div>
          </aside>
          <section className="panel data-preview">
            <div className="panel-heading">
              <div>
                <h2>{data?.name || '데이터 없음'}</h2>
                <p>앞자리 0과 원래 문자열을 보존합니다.</p>
              </div>
              <input
                aria-label="데이터 검색"
                placeholder="데이터 검색"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            {data && (
              <>
                <div className="data-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        {data.columns.map((c) => (
                          <th key={c}>
                            {c}
                            <select
                              aria-label={`${c} 형식`}
                              value={data.formats?.[c] || 'text'}
                              onChange={(e) =>
                                onChange({
                                  ...project,
                                  datasets: project.datasets.map((d) =>
                                    d.id === data.id
                                      ? {
                                          ...d,
                                          formats: { ...d.formats, [c]: e.target.value as any },
                                        }
                                      : d,
                                  ),
                                })
                              }
                            >
                              {[
                                ['text', '문자열'],
                                ['number', '숫자'],
                                ['percent', '백분율'],
                                ['currency', '통화'],
                                ['date', '날짜'],
                              ].map(([v, l]) => (
                                <option value={v} key={v}>
                                  {l}
                                </option>
                              ))}
                            </select>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {data.rows
                        .filter((r) =>
                          Object.values(r).some((v) =>
                            String(v).toLowerCase().includes(search.toLowerCase()),
                          ),
                        )
                        .slice(0, 100)
                        .map((row, i) => (
                          <tr key={i}>
                            {data.columns.map((c) => (
                              <td key={c}>{row[c] === null ? '—' : String(row[c] ?? '')}</td>
                            ))}
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
                <p className="help">
                  미리보기 최대 100행 · 전체 {data.rows.length.toLocaleString()}행 ·{' '}
                  {new Date(data.updatedAt).toLocaleString('ko-KR')}
                </p>
              </>
            )}
          </section>
        </div>
      )}
    </>
  );
}
