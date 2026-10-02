import { useState } from 'react';
import { X, Sparkles, ArrowUpRight, Check, Loader2 } from 'lucide-react';
import { api } from '../api';
import type { Project } from '../core/types';
export function AIPanel({
  project,
  onClose,
  onSaved,
  beforeAction,
  onError,
}: {
  project: Project;
  onClose: () => void;
  onSaved: (p: Project) => void;
  beforeAction: () => Promise<void>;
  onError: (e: unknown) => void;
}) {
  const [provider, setProvider] = useState('openai'),
    [instruction, setInstruction] = useState(''),
    [busy, setBusy] = useState(false),
    [proposal, setProposal] = useState<any>(null),
    [revision, setRevision] = useState(project.revision),
    [chosen, setChosen] = useState<number[]>([]);
  async function propose() {
    setBusy(true);
    try {
      await beforeAction();
      const current = await api<Project>(`/projects/${project.id}`);
      setRevision(current.revision);
      const result = await api('/ai/propose', {
        method: 'POST',
        body: JSON.stringify({ provider, projectId: project.id, instruction }),
      });
      setProposal(result);
      setChosen(
        (result.commands || result.proposal?.commands || []).map((_: unknown, i: number) => i),
      );
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }
  const p = proposal?.proposal || proposal;
  async function apply() {
    setBusy(true);
    try {
      await beforeAction();
      const r = await api('/ai/apply', {
        method: 'POST',
        body: JSON.stringify({
          projectId: project.id,
          baseRevision: revision,
          commands: p.commands.filter((_: unknown, i: number) => chosen.includes(i)),
        }),
      });
      onSaved(r.project || r);
      setProposal(null);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="ai-panel">
      <div className="ai-heading">
        <div>
          <span className="ai-symbol">
            <Sparkles size={19} />
          </span>
          <h2>
            디자인 파트너<small>당신의 아이디어를 구체적으로.</small>
          </h2>
        </div>
        <button className="icon-button" aria-label="AI 패널 닫기" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <div className="ai-context">
        <span>작업 중인 프로젝트</span>
        <strong>{project.name}</strong>
        <small>
          {project.brand.name} · REV {project.revision}
        </small>
      </div>
      <label>
        AI 제공자
        <select value={provider} onChange={(e) => setProvider(e.target.value)}>
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic</option>
          <option value="gemini">Google Gemini</option>
        </select>
      </label>
      <div className="ai-prompts">
        {[
          '전체 분위기를 조금 더 차분하게 바꿔줘',
          '슬라이드 제목을 더 간결하게 다듬어줘',
          '강조색과 보조 글자의 대비를 높여줘',
        ].map((s) => (
          <button key={s} onClick={() => setInstruction(s)}>
            {s}
            <ArrowUpRight size={13} />
          </button>
        ))}
      </div>
      <textarea
        className="ai-instruction"
        placeholder="바꾸고 싶은 점을 설명하세요…"
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
      />
      <button
        className="button primary"
        disabled={busy || !instruction.trim()}
        onClick={() => void propose()}
      >
        {busy ? <Loader2 size={16} className="spin" /> : <Sparkles size={16} />}변경안 만들기
      </button>
      <p className="help">
        현재 프로젝트의 브랜드·텍스트·토큰을 선택한 제공자에게 보냅니다. 연결·설정에서 API 키와
        모델을 먼저 지정하세요.
      </p>
      {p && (
        <section className="ai-proposal">
          <h3>{p.summary || '변경안'}</h3>
          {(p.commands || []).map((c: any, i: number) => (
            <label className="proposal-item" key={i}>
              <input
                type="checkbox"
                checked={chosen.includes(i)}
                onChange={() =>
                  setChosen(chosen.includes(i) ? chosen.filter((x) => x !== i) : [...chosen, i])
                }
              />
              <div>
                <code>{c.path}</code>
                <span>{String(c.value)}</span>
              </div>
            </label>
          ))}
          <button
            className="button primary"
            disabled={busy || !chosen.length}
            onClick={() => void apply()}
          >
            <Check size={15} />
            선택한 {chosen.length}개 적용
          </button>
        </section>
      )}
    </div>
  );
}
