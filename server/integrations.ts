import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ApiError, type StudioStore } from './store';
import { type SecretVault, fetchLimited } from './security';
const HIGGS_BASE = 'https://api.higgsfield.ai';
const GenerationSchema = z
  .object({
    projectId: z.string().min(1),
    modelEndpoint: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+){1,8}$/)
      .max(250)
      .refine(
        (v) => !v.includes('..') && !/^(estimate|requests|files)\//.test(v),
        '모델 엔드포인트를 입력하세요.',
      ),
    input: z.record(z.unknown()),
  })
  .strict();
interface HiggsQuote {
  id: string;
  request: z.infer<typeof GenerationSchema>;
  estimatedCostUsd: number;
  credits: string;
  priceVerified: true;
  expiresAt: string;
}
interface HiggsJob {
  id: string;
  projectId: string;
  quoteId: string;
  status: string;
  requestId?: string;
  createdAt: string;
  error?: string;
  mediaUrls?: string[];
  idempotencyKey?: string;
  modelEndpoint?: string;
  requestBody?: string;
  statusUrl?: string;
  cancelUrl?: string;
  estimatedCostUsd?: number;
  reservedCostUsd?: number;
  budgetDay?: string;
  attempts?: number;
  updatedAt?: string;
}
const localDay = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
function providerUrl(input: unknown, kind: 'status' | 'cancel') {
  if (typeof input !== 'string') throw new ApiError(502, '제공자 응답에 작업 URL이 없습니다.');
  const url = new URL(input);
  if (
    url.origin !== HIGGS_BASE ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !new RegExp(`^/requests/[a-zA-Z0-9_-]{1,200}/${kind}$`).test(url.pathname)
  )
    throw new ApiError(502, '제공자가 허용되지 않는 작업 URL을 반환했습니다.');
  return input;
}
export class HiggsfieldConnector {
  private active = new Set<string>();
  constructor(
    private store: StudioStore,
    private vault: SecretVault,
  ) {}
  list(projectId?: string) {
    return this.store
      .rows<HiggsJob>('SELECT json FROM integrations WHERE id LIKE ?', ['higgs-job:%'])
      .filter((job) => !projectId || job.projectId === projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  budget() {
    const settings = this.store.setting<{ dailyBudgetUsd?: number }>('higgsfield', {});
    const dailyBudgetUsd = settings.dailyBudgetUsd ?? 10;
    const day = localDay();
    const reservedUsd = this.list()
      .filter((j) => j.budgetDay === day)
      .reduce((total, j) => total + (j.reservedCostUsd ?? 0), 0);
    return {
      day,
      dailyBudgetUsd,
      reservedUsd,
      remainingUsd: Math.max(0, dailyBudgetUsd - reservedUsd),
      notice:
        '이 PC의 오늘 생성 견적을 합산한 한도입니다. 제공자의 실제 청구액이나 다른 앱의 사용액은 포함하지 않습니다.',
    };
  }
  private save(job: HiggsJob) {
    job.updatedAt = new Date().toISOString();
    this.store.setIntegration('higgs-job:' + job.id, job);
    if (job.idempotencyKey) this.store.setIntegration('higgs-idem:' + job.idempotencyKey, job);
  }
  async quote(input: unknown) {
    const request = GenerationSchema.parse(input);
    this.store.project(request.projectId);
    const key = this.vault.get('higgsfield');
    if (!key) throw new ApiError(400, 'Higgsfield API 키를 연결하세요.');
    const r = await fetch(`${HIGGS_BASE}/estimate/${request.modelEndpoint}`, {
      method: 'POST',
      headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(request.input),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok)
      throw new ApiError(
        502,
        `Higgsfield 견적 조회 실패 (${r.status}). 엔드포인트와 입력값을 확인하세요.`,
      );
    const data = (await r.json()) as { usd?: string | number; credits?: string | number };
    const usd = Number(data.usd);
    if (data.usd == null || !Number.isFinite(usd) || usd < 0 || data.credits == null)
      throw new ApiError(502, '제공자 견적의 비용 형식을 확인할 수 없습니다.');
    const quote: HiggsQuote = {
      id: randomUUID(),
      request,
      estimatedCostUsd: usd,
      credits: String(data.credits),
      priceVerified: true,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    };
    this.store.setIntegration('quote:' + quote.id, quote);
    return quote;
  }
  async submit(input: unknown) {
    const body = z
      .object({
        quoteId: z.string().uuid(),
        idempotencyKey: z
          .string()
          .min(8)
          .max(255)
          .regex(/^[!-~]+$/),
        confirmPaid: z.literal(true),
        priceAcknowledged: z.literal(true),
        maxCostUsd: z.number().nonnegative().optional(),
      })
      .strict()
      .parse(input);
    const old = this.store.integration<HiggsJob>('higgs-idem:' + body.idempotencyKey);
    if (old) {
      if (old.quoteId !== body.quoteId)
        throw new ApiError(409, '이미 다른 요청에 사용한 키입니다.');
      return this.store.integration<HiggsJob>('higgs-job:' + old.id) ?? old;
    }
    const quote = this.store.integration<HiggsQuote>('quote:' + body.quoteId);
    if (!quote || Date.parse(quote.expiresAt) < Date.now())
      throw new ApiError(400, '견적 확인이 만료되었습니다. 다시 확인하세요.');
    const existingId = this.store.integration<string>('higgs-quote-job:' + quote.id);
    if (existingId) return this.store.integration<HiggsJob>('higgs-job:' + existingId);
    if (body.maxCostUsd !== undefined && quote.estimatedCostUsd > body.maxCostUsd)
      throw new ApiError(400, '견적이 확인한 비용 한도를 초과했습니다.');
    if (!this.vault.get('higgsfield')) throw new ApiError(400, 'Higgsfield API 키를 연결하세요.');
    const budget = this.budget();
    if (quote.estimatedCostUsd > budget.remainingUsd + 1e-9)
      throw new ApiError(
        400,
        '오늘의 생성 견적 한도를 초과했습니다. 연결 설정의 일일 한도를 확인하세요.',
        budget,
      );
    const job: HiggsJob = {
      id: randomUUID(),
      projectId: quote.request.projectId,
      quoteId: quote.id,
      status: 'submitting',
      createdAt: new Date().toISOString(),
      idempotencyKey: body.idempotencyKey,
      modelEndpoint: quote.request.modelEndpoint,
      requestBody: JSON.stringify(quote.request.input),
      estimatedCostUsd: quote.estimatedCostUsd,
      reservedCostUsd: quote.estimatedCostUsd,
      budgetDay: budget.day,
      attempts: 0,
    };
    this.save(job);
    this.store.setIntegration('higgs-quote-job:' + quote.id, job.id);
    return this.send(job);
  }
  private async send(job: HiggsJob) {
    if (this.active.has(job.id))
      throw new ApiError(409, '현재 같은 요청의 접수 결과를 확인하고 있습니다.');
    const key = this.vault.get('higgsfield');
    if (!key) throw new ApiError(400, 'Higgsfield API 키를 연결하세요.');
    if (!job.idempotencyKey || !job.modelEndpoint || !job.requestBody)
      throw new ApiError(
        409,
        '이전 작업의 재시도 키·원본 요청이 없습니다. 제공자 기록을 확인하세요.',
      );
    this.active.add(job.id);
    job.status = 'submitting';
    job.attempts = (job.attempts ?? 0) + 1;
    delete job.error;
    this.save(job);
    try {
      const response = await fetch(HIGGS_BASE + '/' + job.modelEndpoint, {
        method: 'POST',
        headers: {
          Authorization: `Key ${key}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': job.idempotencyKey,
        },
        body: job.requestBody,
        signal: AbortSignal.timeout(45000),
        redirect: 'error',
      });
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500) {
          job.status = job.attempts === 1 ? 'failed' : 'submission-unknown';
          if (job.attempts === 1) job.reservedCostUsd = 0;
          job.error = `Higgsfield 요청 거부 (${response.status}). 입력과 잔액을 확인하세요. 새 키로 자동 재시도하지 않습니다.`;
        } else throw new Error('provider unavailable');
      } else {
        const data = (await response.json()) as {
          request_id?: string;
          status_url?: string;
          cancel_url?: string;
        };
        if (!data.request_id || !/^[a-zA-Z0-9_-]{1,200}$/.test(data.request_id))
          throw new Error('invalid request id');
        job.requestId = data.request_id;
        job.statusUrl = providerUrl(data.status_url, 'status');
        job.cancelUrl = providerUrl(data.cancel_url, 'cancel');
        job.status = 'queued';
      }
    } catch {
      job.status = 'submission-unknown';
      job.error =
        '접수 결과를 확인하지 못했습니다. 같은 요청·키로 재확인 버튼을 누르면 제공자가 기존 요청을 돌려줍니다. 자동 재시도하지 않습니다.';
    } finally {
      this.active.delete(job.id);
      this.save(job);
    }
    return job;
  }
  async retry(id: string, input: unknown) {
    z.object({ confirmRetry: z.literal(true) })
      .strict()
      .parse(input);
    const job = this.store.integration<HiggsJob>('higgs-job:' + id);
    if (!job) throw new ApiError(404, 'Higgsfield 작업이 없습니다.');
    if (!['submitting', 'submission-unknown'].includes(job.status))
      throw new ApiError(400, '접수 결과가 불명확한 요청만 같은 키로 재확인할 수 있습니다.');
    return this.send(job);
  }
  async status(id: string) {
    const job = this.store.integration<HiggsJob>('higgs-job:' + id);
    if (!job) throw new ApiError(404, 'Higgsfield 작업이 없습니다.');
    if (!job.requestId || ['completed', 'failed', 'nsfw', 'canceled'].includes(job.status))
      return job;
    const key = this.vault.get('higgsfield');
    if (!key) throw new ApiError(400, 'API 키를 다시 연결하세요.');
    if (!job.statusUrl)
      throw new ApiError(409, '이전 작업에 제공자 상태 URL이 없습니다. 제공자 기록을 확인하세요.');
    const r = await fetch(providerUrl(job.statusUrl, 'status'), {
      headers: { Authorization: `Key ${key}` },
      signal: AbortSignal.timeout(30000),
      redirect: 'error',
    });
    if (!r.ok) throw new ApiError(502, `상태 조회 실패 (${r.status}).`);
    const data = (await r.json()) as {
      status?: string;
      video?: { url?: string };
      images?: { url: string }[];
      audio?: { url?: string };
      audios?: { url: string }[];
      error?: unknown;
    };
    if (
      !['queued', 'in_progress', 'completed', 'failed', 'nsfw', 'canceled'].includes(
        data.status ?? '',
      )
    )
      throw new ApiError(502, '제공자의 상태값을 이해할 수 없습니다.');
    job.status = data.status!;
    if (job.status === 'completed')
      job.mediaUrls = [
        ...new Set(
          [
            data.video?.url,
            ...(data.images ?? []).map((i) => i.url),
            data.audio?.url,
            ...(data.audios ?? []).map((i) => i.url),
          ].filter((v): v is string => typeof v === 'string'),
        ),
      ];
    if (['failed', 'nsfw'].includes(job.status))
      job.error =
        job.status === 'nsfw'
          ? '제공자가 입력 또는 결과의 생성 정책에 따라 거부했습니다.'
          : '제공자에서 생성에 실패했습니다. 작업 기록을 확인하세요.';
    this.save(job);
    return job;
  }
  async cancel(id: string) {
    const job = this.store.integration<HiggsJob>('higgs-job:' + id);
    if (!job?.requestId || !job.cancelUrl)
      throw new ApiError(400, '취소할 제공자 작업이 없습니다.');
    if (job.status !== 'queued')
      throw new ApiError(400, '대기 중인 생성 요청만 취소할 수 있습니다.');
    const key = this.vault.get('higgsfield');
    if (!key) throw new ApiError(400, 'API 키를 연결하세요.');
    const r = await fetch(providerUrl(job.cancelUrl, 'cancel'), {
      method: 'POST',
      headers: { Authorization: `Key ${key}` },
      signal: AbortSignal.timeout(30000),
      redirect: 'error',
    });
    if (!r.ok) throw new ApiError(502, `제공자가 취소하지 못했습니다 (${r.status}).`);
    job.status = 'canceled';
    this.save(job);
    return job;
  }
  async download(id: string, index: number) {
    const job = await this.status(id);
    const url = job.mediaUrls?.[index];
    if (job.status !== 'completed' || !url) throw new ApiError(400, '내려받을 결과가 없습니다.');
    const result = await fetchLimited(url, {}, 250 * 1024 * 1024);
    if (!/^(image|video|audio)\//.test(result.mime))
      throw new ApiError(400, '지원하는 이미지·영상·오디오 응답이 아닙니다.');
    return { job, ...result, hash: createHash('sha256').update(result.buffer).digest('hex') };
  }
}
export class BlenderConnector {
  private client?: Client;
  private transport?: StdioClientTransport;
  private toolNames: string[] = [];
  get status() {
    return {
      connected: Boolean(this.client),
      tools: this.toolNames.filter((n) =>
        ['get_scene_info', 'get_object_info', 'get_viewport_screenshot'].includes(n),
      ),
      operations: ['scene-info', 'object-info', 'screenshot', 'create-primitive', 'transform'],
      notice:
        'Blender 앱과 Blender MCP 애드온 서버를 먼저 실행해야 합니다. 임의 Python·셸 명령 입력은 지원하지 않습니다.',
    };
  }
  async connect(input: unknown) {
    const config = z
      .object({
        command: z.string().default('uvx'),
        args: z.array(z.string()).default(['mcp-for-blender']),
      })
      .strict()
      .parse(input);
    const name = path.basename(config.command).toLowerCase();
    if (
      !['uvx', 'uvx.exe'].includes(name) ||
      !['["mcp-for-blender"]', '["blender-mcp"]'].includes(JSON.stringify(config.args))
    )
      throw new ApiError(
        400,
        '허용된 실행 형식은 uvx mcp-for-blender입니다. uvx.exe의 전체 경로를 사용할 수 있습니다.',
      );
    await this.close();
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      stderr: 'pipe',
      env: { BLENDER_HOST: '127.0.0.1', BLENDER_PORT: '9876' },
    });
    transport.stderr?.on('data', () => {});
    const client = new Client({ name: 'design-studio', version: '0.1.0' }, { capabilities: {} });
    try {
      await client.connect(transport, { timeout: 20000 });
      const list = await client.listTools();
      this.toolNames = list.tools.map((t) => t.name);
      this.client = client;
      this.transport = transport;
      return this.status;
    } catch {
      await transport.close();
      throw new ApiError(
        502,
        'Blender MCP에 연결하지 못했습니다. uvx 설치와 Blender 애드온 서버를 확인하세요.',
      );
    }
  }
  async call(input: unknown) {
    if (!this.client) throw new ApiError(409, 'Blender MCP를 먼저 연결하세요.');
    const op = z
      .object({
        operation: z.enum([
          'scene-info',
          'object-info',
          'screenshot',
          'create-primitive',
          'transform',
        ]),
        name: z.string().max(100).optional(),
        primitive: z.enum(['cube', 'sphere', 'plane']).optional(),
        position: z
          .tuple([
            z.number().min(-10000).max(10000),
            z.number().min(-10000).max(10000),
            z.number().min(-10000).max(10000),
          ])
          .optional(),
        scale: z
          .tuple([
            z.number().positive().max(1000),
            z.number().positive().max(1000),
            z.number().positive().max(1000),
          ])
          .optional(),
      })
      .strict()
      .parse(input);
    let name: string;
    let args: Record<string, unknown> = {};
    if (op.operation === 'scene-info') name = 'get_scene_info';
    else if (op.operation === 'object-info') {
      name = 'get_object_info';
      args = { object_name: op.name ?? '' };
    } else if (op.operation === 'screenshot') name = 'get_viewport_screenshot';
    else {
      name = 'execute_blender_code';
      const safeName = JSON.stringify(op.name ?? 'Studio_' + randomUUID().slice(0, 8));
      const xyz = JSON.stringify(op.position ?? [0, 0, 0]);
      const scale = JSON.stringify(op.scale ?? [1, 1, 1]);
      let code = 'import bpy\n';
      if (op.operation === 'create-primitive') {
        const action = {
          cube: 'primitive_cube_add',
          sphere: 'primitive_uv_sphere_add',
          plane: 'primitive_plane_add',
        }[op.primitive ?? 'cube'];
        code += `bpy.ops.mesh.${action}(location=${xyz})\nobj=bpy.context.active_object\nobj.name=${safeName}\nobj.scale=${scale}\nprint(obj.name)`;
      } else {
        if (!op.name) throw new ApiError(400, '변경할 객체 이름이 필요합니다.');
        code += `obj=bpy.data.objects.get(${safeName})\nif obj is None: raise ValueError('Object not found')\nobj.location=${xyz}\nobj.scale=${scale}\nprint(obj.name)`;
      }
      args = { code };
    }
    if (!this.toolNames.includes(name))
      throw new ApiError(400, '연결된 MCP에서 이 기능을 지원하지 않습니다.');
    return this.client.callTool({ name, arguments: args }, undefined, { timeout: 30000 });
  }
  async close() {
    await this.client?.close().catch(() => {});
    await this.transport?.close().catch(() => {});
    this.client = undefined;
    this.transport = undefined;
    this.toolNames = [];
  }
}
