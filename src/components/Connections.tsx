import { useEffect, useState } from 'react';
import {
  KeyRound,
  Check,
  Link2,
  Sparkles,
  Loader2,
  ArrowUpRight,
  Plug,
  Eye,
  EyeOff,
} from 'lucide-react';
import { api } from '../api';
import type { Project } from '../core/types';
export function Connections({
  project,
  onSaved,
  onError,
  beforeAction,
}: {
  project: Project;
  onSaved: (p: Project) => void;
  onError: (e: unknown) => void;
  beforeAction: () => Promise<void>;
}) {
  const [settings, setSettings] = useState<any>(null),
    [keys, setKeys] = useState<Record<string, string>>({}),
    [models, setModels] = useState<Record<string, string>>({}),
    [endpoint, setEndpoint] = useState(''),
    [input, setInput] = useState('{\n  "prompt": "A minimal abstract brand animation"\n}'),
    [quote, setQuote] = useState<any>(null),
    [job, setJob] = useState<any>(null),
    [busy, setBusy] = useState(''),
    [blender, setBlender] = useState<any>(null),
    [generationJobs, setGenerationJobs] = useState<any[]>([]),
    [budget, setBudget] = useState<any>(null),
    [dailyBudget, setDailyBudget] = useState(10);
  async function load() {
    try {
      const s = await api('/settings');
      setSettings(s);
      setModels(s.aiModels || {});
      setEndpoint(s.higgsfield?.modelEndpoint || '');
    } catch (e) {
      onError(e);
    }
  }
  async function refreshJobs() {
    const [list, b] = await Promise.all([
      api<any[]>('/higgsfield/jobs?projectId=' + project.id),
      api<any>('/higgsfield/budget'),
    ]);
    setGenerationJobs(list);
    setBudget(b);
    setDailyBudget(b.dailyBudgetUsd);
  }
  useEffect(() => {
    void load();
    void refreshJobs().catch(onError);
  }, [project.id]);
  async function run(name: string, fn: () => Promise<void>) {
    setBusy(name);
    try {
      await fn();
    } catch (e) {
      onError(e);
    } finally {
      setBusy('');
      void refreshJobs().catch(() => {});
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">CONNECTED WORKSPACE</span>
          <h1>작업 도구를 연결하세요.</h1>
          <p>필요한 서비스를 선택하고, 사용하는 계정의 API 키로 연결합니다.</p>
        </div>
        <span className="pill">
          <KeyRound size={13} />
          {settings?.secretPersistence === 'os-encrypted'
            ? 'OS 암호화 저장'
            : '키는 현재 실행 세션에만 보관'}
        </span>
      </div>
      <div className="connection-grid">
        {[
          ['openai', 'OpenAI', '텍스트·구조화된 디자인 변경안'],
          ['anthropic', 'Anthropic', '문서·슬라이드·표현 개선'],
          ['gemini', 'Google Gemini', '콘텐츠·시각 자료 해석'],
          ['higgsfield', 'Higgsfield', '이미지·영상 생성'],
        ].map(([id, name, description]) => (
          <section className="panel connection-card" key={id}>
            <div className="connection-title">
              <div className={`provider-icon ${id}`}>{name[0]}</div>
              <div>
                <h2>{name}</h2>
                <p>{description}</p>
              </div>
              <span className={settings?.secrets?.[id] ? 'connected' : 'not-connected'}>
                {settings?.secrets?.[id] ? '키 연결됨' : '연결 전'}
              </span>
            </div>
            <label>
              {id === 'higgsfield' ? 'KEY_ID:KEY_SECRET' : 'API 키'}
              <input
                type="password"
                autoComplete="off"
                placeholder={settings?.secrets?.[id] ? '새 키를 입력하여 교체' : '키를 입력하세요'}
                value={keys[id] || ''}
                onChange={(e) => setKeys({ ...keys, [id]: e.target.value })}
              />
            </label>
            {id !== 'higgsfield' && (
              <label>
                모델 ID
                <input
                  value={models[id] || ''}
                  placeholder="계정에서 사용 가능한 모델 ID"
                  onChange={(e) => setModels({ ...models, [id]: e.target.value })}
                />
              </label>
            )}
            <div className="button-row">
              <button
                className="button primary"
                disabled={!keys[id] || !!busy}
                onClick={() =>
                  void run(id, async () => {
                    await api(`/settings/secrets/${id}`, {
                      method: 'PUT',
                      body: JSON.stringify({ key: keys[id] }),
                    });
                    if (id !== 'higgsfield')
                      await api('/settings', {
                        method: 'PUT',
                        body: JSON.stringify({ aiModels: models }),
                      });
                    setKeys({ ...keys, [id]: '' });
                    await load();
                  })
                }
              >
                <KeyRound size={14} />키 저장
              </button>
              {id !== 'higgsfield' && (
                <button
                  className="button secondary"
                  onClick={() =>
                    void run(id, async () => {
                      await api('/settings', {
                        method: 'PUT',
                        body: JSON.stringify({ aiModels: models }),
                      });
                      await load();
                    })
                  }
                >
                  모델 저장
                </button>
              )}
              {settings?.secrets?.[id] && (
                <button
                  className="text-button"
                  onClick={() =>
                    void run(id, async () => {
                      await api(`/settings/secrets/${id}`, { method: 'DELETE' });
                      await load();
                    })
                  }
                >
                  연결 해제
                </button>
              )}
            </div>
          </section>
        ))}
      </div>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Higgsfield 생성 작업</h2>
            <p>견적을 확인한 후에만 유료 생성 요청을 보냅니다.</p>
          </div>
          <Sparkles size={19} />
        </div>
        <div className="two-columns">
          <div>
            <label>
              모델 엔드포인트
              <input
                value={endpoint}
                placeholder="higgsfield-ai/soul/v2/standard"
                onChange={(e) => {
                  setEndpoint(e.target.value);
                  setQuote(null);
                }}
              />
            </label>
            <label>
              모델 입력 JSON
              <textarea
                className="code-area tall"
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  setQuote(null);
                }}
              />
            </label>
            <button
              className="button secondary"
              disabled={!!busy || !endpoint}
              onClick={() =>
                void run('quote', async () => {
                  await beforeAction();
                  const q = await api('/higgsfield/quote', {
                    method: 'POST',
                    body: JSON.stringify({
                      projectId: project.id,
                      modelEndpoint: endpoint,
                      input: JSON.parse(input),
                    }),
                  });
                  setQuote({ ...q, requestKey: q.requestKey || crypto.randomUUID() });
                })
              }
            >
              {busy === 'quote' ? <Loader2 className="spin" size={15} /> : <Sparkles size={15} />}
              비용 견적 확인
            </button>
          </div>
          <div className="generation-status">
            <h3>생성 상태</h3>
            <div className="generation-budget">
              <label>
                일일 견적 한도 (USD)
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={dailyBudget}
                  onChange={(e) => setDailyBudget(Math.max(0, Number(e.target.value)))}
                />
              </label>
              <button
                className="button secondary"
                disabled={!!busy}
                onClick={() =>
                  void run('budget', async () => {
                    await api('/settings', {
                      method: 'PUT',
                      body: JSON.stringify({ higgsfield: { dailyBudgetUsd: dailyBudget } }),
                    });
                  })
                }
              >
                한도 저장
              </button>
              <p className="help">
                이 앱에서 예약한 견적 ${budget?.reservedUsd?.toFixed(2) || '0.00'} / $
                {budget?.dailyBudgetUsd?.toFixed(2) || '10.00'}. 실제 청구액은 제공자 계정에서
                확인합니다.
              </p>
            </div>
            {quote ? (
              <>
                <pre>{JSON.stringify(quote, null, 2)}</pre>
                <button
                  className="button primary"
                  disabled={!!busy}
                  onClick={() =>
                    void run('generate', async () => {
                      const j = await api('/higgsfield/submit', {
                        method: 'POST',
                        body: JSON.stringify({
                          quoteId: quote.id || quote.quoteId,
                          idempotencyKey: quote.requestKey || crypto.randomUUID(),
                          confirmPaid: true,
                          priceAcknowledged: true,
                          maxCostUsd: quote.estimatedCostUsd ?? undefined,
                        }),
                      });
                      setJob(j);
                      setQuote(null);
                    })
                  }
                >
                  견적 비용으로 생성
                </button>
              </>
            ) : (
              <p className="help">연결한 모델의 입력 규격에 맞게 값을 넣고 견적을 요청하세요.</p>
            )}
            {job && (
              <>
                <pre>
                  {JSON.stringify(
                    {
                      status: job.status,
                      requestId: job.requestId,
                      cost: job.estimatedCostUsd,
                      error: job.error,
                      createdAt: job.createdAt,
                    },
                    null,
                    2,
                  )}
                </pre>
                <div className="button-row">
                  {job.status === 'submission-unknown' && (
                    <button
                      className="button primary"
                      disabled={!!busy}
                      onClick={() =>
                        void run('retry', async () =>
                          setJob(
                            await api(`/higgsfield/jobs/${job.id}/retry`, {
                              method: 'POST',
                              body: JSON.stringify({ confirmRetry: true }),
                            }),
                          ),
                        )
                      }
                    >
                      같은 요청·키로 재확인
                    </button>
                  )}
                  <button
                    className="button secondary"
                    onClick={() =>
                      void run('status', async () =>
                        setJob(await api(`/higgsfield/jobs/${job.id}`)),
                      )
                    }
                  >
                    상태 확인
                  </button>
                  <button
                    className="button secondary"
                    onClick={() =>
                      void run('download', async () => {
                        const r = await api(`/higgsfield/jobs/${job.id}/download`, {
                          method: 'POST',
                          body: JSON.stringify({ index: 0 }),
                        });
                        if (r.project) onSaved(r.project);
                        setJob({ ...job, localResult: r });
                      })
                    }
                  >
                    결과 가져오기
                  </button>
                  <button
                    className="button secondary"
                    onClick={() =>
                      void run('cancel', async () =>
                        setJob(
                          await api(`/higgsfield/jobs/${job.id}/cancel`, {
                            method: 'POST',
                            body: '{}',
                          }),
                        ),
                      )
                    }
                  >
                    대기 작업 취소
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <h2>생성 작업 이력</h2>
          <button className="button secondary" onClick={() => void refreshJobs().catch(onError)}>
            목록 새로고침
          </button>
        </div>
        {generationJobs.length ? (
          generationJobs.map((j) => (
            <div className="job-row" key={j.id}>
              <div className="job-info">
                <strong>{j.status}</strong>
                <small>
                  {new Date(j.createdAt).toLocaleString('ko-KR')} · $
                  {j.estimatedCostUsd?.toFixed(2) || '0.00'} 견적
                </small>
              </div>
              <button className="button secondary" onClick={() => setJob(j)}>
                작업 열기
              </button>
            </div>
          ))
        ) : (
          <p>생성 작업이 없습니다. API 키와 모델을 연결한 후 시작하세요.</p>
        )}
      </section>
      <div className="two-columns">
        <section className="panel">
          <div className="panel-heading">
            <h2>Blender MCP</h2>
            <Plug size={18} />
          </div>
          <p>
            Blender에서 MCP 애드온을 시작한 뒤 연결하세요. 장면 정보 조회와 제한된 오브젝트 작업을
            지원합니다.
          </p>
          <button
            className="button secondary"
            disabled={!!busy}
            onClick={() =>
              void run('blender', async () =>
                setBlender(
                  await api('/blender/connect', {
                    method: 'POST',
                    body: JSON.stringify({ command: 'uvx', args: ['mcp-for-blender'] }),
                  }),
                ),
              )
            }
          >
            로컬 MCP 연결
          </button>
          {blender && (
            <>
              <pre>{JSON.stringify(blender, null, 2)}</pre>
              <button
                className="button secondary"
                onClick={() =>
                  void run('scene', async () =>
                    setBlender(
                      await api('/blender/call', {
                        method: 'POST',
                        body: JSON.stringify({ operation: 'scene-info' }),
                      }),
                    ),
                  )
                }
              >
                장면 정보 조회
              </button>
            </>
          )}
          <p className="help">
            MCP 런타임·애드온 설치와 실행은 별도입니다. 연결 시 사용 중인 Blender 장면을 확인하세요.
          </p>
        </section>
        <section className="panel">
          <div className="panel-heading">
            <h2>After Effects</h2>
            <ArrowUpRight size={18} />
          </div>
          <p>
            검사·내보내기에서 JSX·JSON·자산 패키지를 생성하고, After Effects의 새 프로젝트에서
            스크립트를 실행하세요.
          </p>
          <ol className="steps">
            <li>After Effects 패키지 내보내기</li>
            <li>압축 해제 후 포함된 JSX 실행</li>
            <li>생성된 레이어·키프레임 확인</li>
            <li>AE에서 편집 가능한 AEP 저장</li>
          </ol>
          <p className="help">After Effects가 설치되어 있어야 AEP 생성과 렌더를 할 수 있습니다.</p>
        </section>
      </div>
    </>
  );
}
