import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { z, ZodError } from 'zod';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as httpServer, type Server } from 'node:http';
import { StudioStore, ApiError } from './store';
import { SecretVault, localGuard, inside, fetchLimited, type SecretCipher } from './security';
import { importDataset, inspectDataset, normalizeRows, selectResponse } from './datasets';
import { validateFont, fontAssets, fontsCss } from './fonts';
import { applyCommands, propose } from './ai';
import { HiggsfieldConnector, BlenderConnector } from './integrations';
import { ProjectSchema } from '../src/core/schema';
import { createProject } from '../src/core/templates';
import { importLegacyProject } from '../src/core/legacy';
import { assertSafeSvg } from '../src/core/svg';
import { validateImportedAsset } from '../src/exporters/import-validation';
import type { Asset, Project, Job, ExportContext } from '../src/core/types';
import { exportProject, importProjectPackage } from '../src/exporters/index';
import { exportMotion } from '../src/motion/export';

const MB = 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 250 * MB, files: 1, fields: 10 },
});
const datasetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * MB, files: 1, fields: 4 },
});
const modelsDefault = {
  openai: 'gpt-4.1-mini',
  anthropic: 'claude-sonnet-4-20250514',
  gemini: 'gemini-2.5-flash',
};
const publicHeaders = z
  .record(z.string().max(1000))
  .refine(
    (v) =>
      Object.keys(v).every((k) =>
        ['accept', 'accept-language', 'content-type'].includes(k.toLowerCase()),
      ),
    '비밀 헤더는 secretRef로 보관하세요. 공개 헤더는 Accept, Accept-Language, Content-Type만 지원합니다.',
  );
const fetchSchema = z
  .object({
    name: z.string().min(1).max(200).default('API 데이터'),
    url: z.string().url().max(2000),
    headers: publicHeaders.optional(),
    secretRef: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,64}$/)
      .optional(),
    responsePath: z.string().max(200).optional(),
  })
  .strict();
function validateProject(value: unknown) {
  const p = ProjectSchema.parse(value);
  for (const d of p.datasets) if (d.connection?.headers) publicHeaders.parse(d.connection.headers);
  return p;
}
function requireFile(file: Express.Multer.File | undefined) {
  if (!file) throw new ApiError(400, '파일을 선택하세요.');
  return file;
}
function cleanName(name: string) {
  if ([...name].every((c) => c.charCodeAt(0) <= 255)) {
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    if (!decoded.includes('\uFFFD')) name = decoded;
  }
  return (
    path
      .basename(name)
      .replace(/[\x00-\x1f<>:"|?*]/g, '_')
      .slice(0, 180) || 'asset'
  );
}

export interface ServerOptions {
  dataDir?: string;
  port?: number;
  staticDir?: string;
  secretCipher?: SecretCipher;
}
export async function createServer(options: ServerOptions = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(localGuard);
  app.use(express.json({ limit: '25mb' }));
  const dataDir = path.resolve(
    options.dataDir ?? process.env.STUDIO_DATA_DIR ?? path.join(process.cwd(), 'data'),
  );
  const assetsDir = path.join(dataDir, 'assets'),
    outputsDir = path.join(dataDir, 'exports');
  mkdirSync(assetsDir, { recursive: true });
  mkdirSync(outputsDir, { recursive: true });
  const store = await StudioStore.open(dataDir);
  const vault = new SecretVault(store, options.secretCipher);
  const higgs = new HiggsfieldConnector(store, vault);
  const blender = new BlenderConnector();
  const pending: { job: Job; project: Project }[] = [];
  const aborts = new Map<string, AbortController>();
  let pumping: Promise<void> | undefined;
  let stopping = false;
  let queueError: string | undefined;
  function context(job: Job): ExportContext {
    const outputDir = inside(outputsDir, job.id);
    mkdirSync(outputDir, { recursive: true });
    return {
      outputDir,
      assetsDir,
      assetPath: (a) => inside(assetsDir, a.relativePath),
      signal: aborts.get(job.id)?.signal,
      onProgress: (n, message) => {
        const value = Math.max(0, Math.min(99, Math.round(n)));
        if (job.progress === value && job.message === message) return;
        job.progress = value;
        job.message = message;
        store.putJob(job);
      },
    };
  }
  async function pump() {
    while (pending.length && !stopping) {
      const { job, project } = pending.shift()!;
      if (store.job(job.id).status === 'canceled') continue;
      const controller = new AbortController();
      aborts.set(job.id, controller);
      job.status = 'running';
      job.message = '내보내는 중';
      store.putJob(job);
      try {
        const ctx = context(job);
        for (const asset of project.assets) {
          if (controller.signal.aborted) throw new Error('내보내기를 취소했습니다.');
          const bytes = readFileSync(inside(assetsDir, asset.relativePath));
          if (createHash('sha256').update(bytes).digest('hex') !== asset.hash)
            throw new ApiError(400, '자산 무결성 검사가 실패했습니다: ' + asset.name);
          await validateImportedAsset(asset, bytes);
        }
        const result = ['mp4', 'webm', 'png-sequence'].includes(job.format)
          ? await exportMotion(project, job.format as 'mp4' | 'webm' | 'png-sequence', ctx)
          : await exportProject(project, job.format, ctx);
        if (controller.signal.aborted) {
          job.status = 'canceled';
          job.message = '취소되었습니다.';
        } else {
          for (const file of result.files)
            inside(ctx.outputDir, path.relative(ctx.outputDir, file.path));
          job.files = result.files;
          job.manifest = result.manifest;
          job.status = 'completed';
          job.progress = 100;
          job.message = '내보내기를 마쳤습니다.';
        }
      } catch (error) {
        job.status = controller.signal.aborted ? 'canceled' : 'failed';
        job.error = error instanceof Error ? error.message : String(error);
        job.message = controller.signal.aborted ? '취소되었습니다.' : '내보내지 못했습니다.';
      } finally {
        aborts.delete(job.id);
        store.putJob(job);
      }
    }
  }
  function startPump() {
    if (!pumping && !queueError)
      pumping = pump()
        .catch((error) => {
          queueError = error instanceof Error ? error.message : String(error);
          console.error('내보내기 큐 저장 실패:', queueError);
          for (const job of store
            .jobs()
            .filter((j) => j.status === 'queued' || j.status === 'running')) {
            job.status = 'failed';
            job.error = queueError;
            job.message =
              '작업 기록을 저장하지 못했습니다. 디스크 상태를 확인한 후 앱을 다시 시작하세요.';
            try {
              store.putJob(job);
            } catch {}
          }
        })
        .finally(() => {
          pumping = undefined;
          if (pending.length && !stopping && !queueError) startPump();
        });
  }
  async function saveAsset(
    projectId: string,
    buffer: Buffer,
    name: string,
    mimeHint: string,
    source = 'upload',
  ) {
    const current = store.project(projectId);
    const hash = createHash('sha256').update(buffer).digest('hex');
    let ext = path.extname(name).toLowerCase();
    let mime: string;
    let width: number | undefined, height: number | undefined;
    const images = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
    if (images.has(ext)) {
      const meta = await sharp(buffer, { limitInputPixels: 100000000 }).metadata();
      const formats: Record<string, string> = {
        png: 'image/png',
        jpeg: 'image/jpeg',
        webp: 'image/webp',
        gif: 'image/gif',
      };
      mime = formats[meta.format ?? ''];
      if (!mime) throw new ApiError(400, '지원하지 않는 이미지 파일입니다.');
      ext = meta.format === 'jpeg' ? '.jpg' : '.' + meta.format;
      width = meta.width;
      height = meta.height;
    } else if (ext === '.svg') {
      try {
        assertSafeSvg(buffer.toString('utf8'));
      } catch (error) {
        throw new ApiError(
          400,
          error instanceof Error ? error.message : '사용할 수 없는 SVG입니다.',
        );
      }
      mime = 'image/svg+xml';
    } else if (['.woff', '.woff2', '.ttf', '.otf'].includes(ext))
      mime = validateFont(buffer, ext).mime;
    else {
      const media: Record<string, string> = {
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
        '.ogg': 'audio/ogg',
        '.m4a': 'audio/mp4',
      };
      mime = media[ext];
      if (!mime)
        throw new ApiError(400, '이미지·영상·오디오 또는 WOFF, WOFF2, TTF, OTF 글꼴을 선택하세요.');
      if (buffer.length < 12) throw new ApiError(400, '빈 미디어 파일입니다.');
      if (ext === '.mp4' || ext === '.m4a') {
        if (buffer.toString('ascii', 4, 8) !== 'ftyp')
          throw new ApiError(400, 'MP4 형식이 아닙니다.');
      }
      if (ext === '.webm' && buffer.readUInt32BE(0) !== 0x1a45dfa3)
        throw new ApiError(400, 'WebM 형식이 아닙니다.');
    }
    const relativePath = hash + ext,
      file = inside(assetsDir, relativePath);
    if (!existsSync(file)) writeFileSync(file, buffer, { flag: 'wx' });
    const duplicate = current.assets.find((a) => a.hash === hash);
    if (duplicate) return { asset: duplicate, project: current };
    const asset: Asset = {
      id: randomUUID(),
      name: cleanName(name),
      hash,
      mime,
      size: buffer.length,
      relativePath,
      source,
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
    };
    const project = store.save(
      validateProject({ ...current, assets: [...current.assets, asset] }),
      current.revision,
    );
    return { asset, project };
  }
  function settings() {
    return {
      aiModels: store.setting('aiModels', modelsDefault),
      higgsfield: {
        modelEndpoint: '',
        input: {},
        dailyBudgetUsd: 10,
        ...store.setting<Record<string, unknown>>('higgsfield', {}),
      },
      higgsfieldBudget: higgs.budget(),
      blender: {
        ...store.setting('blender', { command: 'uvx', args: ['mcp-for-blender'] }),
        ...blender.status,
      },
      secrets: vault.status(),
      secretPersistence: vault.persistence,
    };
  }
  app.get('/api/health', (_req, res) =>
    res.json({
      ok: !queueError,
      version: '0.1.0',
      secretPersistence: vault.persistence,
      ...(queueError ? { queueError } : {}),
    }),
  );
  app.get('/api/fonts.css', (req, res) => {
    const assets = req.query.projectId
      ? store.project(String(req.query.projectId)).assets
      : store.projects().flatMap((p) => p.assets);
    res.setHeader('Cache-Control', 'no-store');
    res.type('text/css').send(fontsCss(assets));
  });
  app.get('/api/fonts', (req, res) => {
    const assets = req.query.projectId
      ? store.project(String(req.query.projectId)).assets
      : store.projects().flatMap((p) => p.assets);
    res.json(fontAssets(assets));
  });
  app.get('/api/projects', (_req, res) => res.json(store.projects()));
  app.post('/api/projects', (req, res) => {
    const body = z
      .object({ name: z.string().min(1).max(200).optional(), project: z.unknown().optional() })
      .strict()
      .parse(req.body);
    res.status(201).json(store.create(validateProject(body.project ?? createProject(body.name))));
  });
  app.get('/api/projects/:id', (req, res) => res.json(store.project(String(req.params.id))));
  app.put('/api/projects/:id', (req, res) => {
    const body = z
      .object({ project: z.unknown(), baseRevision: z.number().int().nonnegative() })
      .strict()
      .parse(req.body);
    const project = validateProject(body.project);
    if (project.id !== req.params.id) throw new ApiError(400, '프로젝트 ID가 일치하지 않습니다.');
    res.json(store.save(project, body.baseRevision));
  });
  app.delete('/api/projects/:id', (req, res) => {
    store.delete(String(req.params.id));
    res.json({ ok: true });
  });
  app.get('/api/projects/:id/revisions', (req, res) =>
    res.json(store.revisions(String(req.params.id))),
  );
  app.post('/api/projects/:id/restore', (req, res) => {
    const body = z
      .object({ revision: z.number().int().positive(), baseRevision: z.number().int().positive() })
      .strict()
      .parse(req.body);
    res.json(store.restore(String(req.params.id), body.revision, body.baseRevision));
  });
  app.post('/api/projects/:id/assets', upload.single('file'), async (req, res) => {
    const file = requireFile(req.file);
    res
      .status(201)
      .json(await saveAsset(String(req.params.id), file.buffer, file.originalname, file.mimetype));
  });
  app.get('/api/assets/:id', (req, res) => {
    const asset = store
      .projects()
      .flatMap((p) => p.assets)
      .find((a) => a.id === req.params.id);
    if (!asset) throw new ApiError(404, '자산이 없습니다.');
    const file = inside(assetsDir, asset.relativePath);
    if (!existsSync(file)) throw new ApiError(404, '자산 파일이 없습니다.');
    if (asset.mime === 'image/svg+xml' || path.extname(file).toLowerCase() === '.svg') {
      try {
        assertSafeSvg(readFileSync(file, 'utf8'));
      } catch (error) {
        throw new ApiError(
          400,
          error instanceof Error ? error.message : '사용할 수 없는 SVG입니다.',
        );
      }
    }
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.type(asset.mime).sendFile(file);
  });
  app.post('/api/datasets/inspect', datasetUpload.single('file'), async (req, res) => {
    const file = requireFile(req.file);
    res.json(await inspectDataset(file.buffer, cleanName(file.originalname)));
  });
  app.post('/api/projects/:id/datasets', datasetUpload.single('file'), async (req, res) => {
    const file = requireFile(req.file);
    const options = z
      .object({
        sheet: z.string().min(1).max(100).optional(),
        range: z.string().min(1).max(50).optional(),
      })
      .strict()
      .parse(req.body ?? {});
    const current = store.project(String(req.params.id));
    const dataset = await importDataset(file.buffer, cleanName(file.originalname), options);
    const latest = store.project(current.id);
    res.status(201).json({
      dataset,
      project: store.save(
        validateProject({ ...latest, datasets: [...latest.datasets, dataset] }),
        latest.revision,
      ),
    });
  });
  app.post('/api/projects/:id/datasets/fetch', async (req, res) => {
    const body = fetchSchema.parse(req.body);
    store.project(String(req.params.id));
    const headers: Record<string, string> = { Accept: 'application/json', ...body.headers };
    if (body.secretRef) {
      const secret = vault.get(body.secretRef);
      if (!secret) throw new ApiError(400, '참조할 비밀 키가 없습니다.');
      headers.Authorization = secret.startsWith('Bearer ') ? secret : `Bearer ${secret}`;
    }
    const data = await fetchLimited(body.url, { headers });
    let json: unknown;
    try {
      json = JSON.parse(data.buffer.toString('utf8'));
    } catch {
      throw new ApiError(400, 'API 응답은 JSON이어야 합니다.');
    }
    const dataset = normalizeRows(selectResponse(json, body.responsePath), body.name, 'api');
    dataset.connection = {
      url: body.url,
      headers: body.headers,
      secretRef: body.secretRef,
      responsePath: body.responsePath,
    };
    const latest = store.project(String(req.params.id));
    res.json({
      dataset,
      project: store.save(
        validateProject({ ...latest, datasets: [...latest.datasets, dataset] }),
        latest.revision,
      ),
    });
  });
  app.post('/api/import', upload.single('file'), async (req, res) => {
    const file = requireFile(req.file);
    let project: Project;
    let warnings: string[] = [];
    if (file.originalname.toLowerCase().endsWith('.json')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(file.buffer.toString('utf8'));
      } catch {
        throw new ApiError(400, '프로젝트 JSON을 읽을 수 없습니다.');
      }
      if (
        parsed &&
        typeof parsed === 'object' &&
        'schemaVersion' in parsed &&
        parsed.schemaVersion === 1
      )
        project = validateProject(parsed);
      else {
        try {
          const converted = importLegacyProject(parsed);
          project = validateProject(converted.project);
          warnings = converted.warnings;
        } catch (e) {
          if (e instanceof ZodError) throw e;
          throw new ApiError(
            400,
            e instanceof Error ? e.message : '기존 디자인 킷을 변환하지 못했습니다.',
          );
        }
      }
    } else if (/\.(zip|designstudio)$/i.test(file.originalname))
      project = validateProject(
        await importProjectPackage(file.buffer, { outputDir: outputsDir, assetsDir }),
      );
    else throw new ApiError(400, '프로젝트 JSON, ZIP 또는 .designstudio만 지원합니다.');
    project.id = randomUUID();
    project.name = (project.name + ' · 가져옴').slice(0, 200);
    const saved = store.create(project);
    if (warnings.length) {
      store.setSetting('import-report:' + saved.id, {
        warnings,
        createdAt: new Date().toISOString(),
      });
      res.setHeader('X-Studio-Import-Warning-Count', String(warnings.length));
      res.setHeader('X-Studio-Import-Report', `/api/projects/${saved.id}/import-report`);
    }
    res.status(201).json(saved);
  });
  app.get('/api/projects/:id/import-report', (req, res) => {
    store.project(String(req.params.id));
    res.json(store.setting('import-report:' + req.params.id, { warnings: [] }));
  });
  app.post('/api/projects/:id/export', (req, res) => {
    if (queueError)
      throw new ApiError(
        503,
        '작업 저장 오류로 내보내기가 중지되었습니다. 디스크 상태를 확인한 후 앱을 다시 시작하세요.',
      );
    const body = z
      .object({
        format: z.enum([
          'pptx',
          'tokens',
          'project',
          'web',
          'after-effects',
          'blender',
          'json',
          'zip',
          'html',
          'jsx',
          'ae',
          'mp4',
          'webm',
          'png-sequence',
        ]),
      })
      .strict()
      .parse(req.body);
    const aliases: Record<string, string> = {
      json: 'project',
      zip: 'project',
      html: 'web',
      jsx: 'after-effects',
      ae: 'after-effects',
    };
    const project = store.project(String(req.params.id));
    const job: Job = {
      id: randomUUID(),
      projectId: project.id,
      revision: project.revision,
      format: aliases[body.format] ?? body.format,
      status: 'queued',
      progress: 0,
      message: '대기 중',
      createdAt: new Date().toISOString(),
    };
    store.putJob(job);
    pending.push({ job, project });
    res.status(202).json(job);
    setImmediate(startPump);
  });
  app.get('/api/jobs', (req, res) =>
    res.json(
      store.jobs().filter((j) => !req.query.projectId || j.projectId === req.query.projectId),
    ),
  );
  app.get('/api/jobs/:id', (req, res) => res.json(store.job(String(req.params.id))));
  app.post('/api/jobs/:id/cancel', (req, res) => {
    const job = store.job(String(req.params.id));
    if (job.status === 'queued') {
      job.status = 'canceled';
      job.message = '취소되었습니다.';
      store.putJob(job);
    } else if (job.status === 'running') {
      aborts.get(job.id)?.abort();
      job.message = '취소 요청 중';
      store.putJob(job);
    }
    res.json(job);
  });
  app.get('/api/jobs/:id/files/:index', (req, res) => {
    const job = store.job(String(req.params.id));
    const index = Number(req.params.index);
    if (job.status !== 'completed' || !Number.isInteger(index) || index < 0)
      throw new ApiError(400, '완료한 작업의 파일만 받을 수 있습니다.');
    const file = job.files?.[index];
    if (!file) throw new ApiError(404, '파일이 없습니다.');
    const root = inside(outputsDir, job.id);
    const safe = inside(root, path.relative(root, file.path));
    res.type(file.mime).download(safe, file.name);
  });
  app.get('/api/settings', (_req, res) => res.json(settings()));
  app.put('/api/settings', (req, res) => {
    const body = z
      .object({
        aiModels: z
          .object({
            openai: z.string().min(1).max(100),
            anthropic: z.string().min(1).max(100),
            gemini: z.string().min(1).max(100),
          })
          .partial()
          .optional(),
        higgsfield: z
          .object({
            modelEndpoint: z.string().max(250).optional(),
            input: z.record(z.unknown()).optional(),
            dailyBudgetUsd: z.number().min(0).max(10000).optional(),
          })
          .strict()
          .optional(),
        blender: z
          .object({ command: z.string().max(1000), args: z.array(z.string().max(100)).max(2) })
          .optional(),
      })
      .strict()
      .parse(req.body);
    if (body.aiModels)
      store.setSetting('aiModels', {
        ...store.setting('aiModels', modelsDefault),
        ...body.aiModels,
      });
    if (body.higgsfield)
      store.setSetting('higgsfield', {
        ...store.setting<Record<string, unknown>>('higgsfield', {}),
        ...body.higgsfield,
      });
    if (body.blender) store.setSetting('blender', body.blender);
    res.json(settings());
  });
  app.put('/api/settings/secrets/:provider', (req, res) => {
    const body = z
      .object({ key: z.string().min(1).max(8192) })
      .strict()
      .parse(req.body);
    vault.set(String(req.params.provider), body.key.trim().replace(/^Key\s+/i, ''));
    res.json(settings());
  });
  app.delete('/api/settings/secrets/:provider', (req, res) => {
    vault.remove(String(req.params.provider));
    res.json(settings());
  });
  app.post('/api/ai/propose', async (req, res) => {
    const body = z
      .object({
        provider: z.enum(['openai', 'anthropic', 'gemini']),
        projectId: z.string(),
        instruction: z.string().min(1).max(10000),
      })
      .strict()
      .parse(req.body);
    const models = store.setting('aiModels', modelsDefault);
    res.json(
      await propose(
        body.provider,
        models[body.provider],
        body.instruction,
        store.project(body.projectId),
        vault,
      ),
    );
  });
  app.post('/api/ai/apply', (req, res) => {
    const body = z
      .object({
        projectId: z.string(),
        baseRevision: z.number().int().positive(),
        commands: z.unknown(),
      })
      .strict()
      .parse(req.body);
    res.json(
      store.save(
        validateProject(applyCommands(store.project(body.projectId), body.commands)),
        body.baseRevision,
      ),
    );
  });
  app.post('/api/higgsfield/quote', async (req, res) => res.json(await higgs.quote(req.body)));
  app.post('/api/higgsfield/submit', async (req, res) =>
    res.status(202).json(await higgs.submit(req.body)),
  );
  app.get('/api/higgsfield/jobs', (req, res) =>
    res.json(higgs.list(req.query.projectId ? String(req.query.projectId) : undefined)),
  );
  app.get('/api/higgsfield/budget', (_req, res) => res.json(higgs.budget()));
  app.get('/api/higgsfield/jobs/:id', async (req, res) =>
    res.json(await higgs.status(String(req.params.id))),
  );
  app.post('/api/higgsfield/jobs/:id/retry', async (req, res) =>
    res.json(await higgs.retry(String(req.params.id), req.body)),
  );
  app.post('/api/higgsfield/jobs/:id/cancel', async (req, res) =>
    res.json(await higgs.cancel(String(req.params.id))),
  );
  app.post('/api/higgsfield/jobs/:id/download', async (req, res) => {
    const body = z
      .object({ index: z.number().int().min(0).default(0) })
      .strict()
      .parse(req.body ?? {});
    const result = await higgs.download(String(req.params.id), body.index);
    const ext: Record<string, string> = {
      'video/mp4': '.mp4',
      'video/webm': '.webm',
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/webp': '.webp',
      'image/gif': '.gif',
      'audio/mpeg': '.mp3',
      'audio/mp3': '.mp3',
      'audio/wav': '.wav',
      'audio/x-wav': '.wav',
      'audio/ogg': '.ogg',
      'audio/mp4': '.m4a',
    };
    const suffix = ext[result.mime.split(';')[0].trim()];
    if (!suffix)
      throw new ApiError(400, '지원하지 않는 생성 결과 형식입니다. 제공자에서 직접 내려받으세요.');
    res.json(
      await saveAsset(
        result.job.projectId,
        result.buffer,
        'Higgsfield-' + result.job.id + suffix,
        result.mime,
        'higgsfield',
      ),
    );
  });
  app.get('/api/blender/tools', (_req, res) => res.json(blender.status));
  app.post('/api/blender/connect', async (req, res) =>
    res.json(
      await blender.connect(
        Object.keys(req.body ?? {}).length
          ? req.body
          : store.setting('blender', { command: 'uvx', args: ['mcp-for-blender'] }),
      ),
    ),
  );
  app.post('/api/blender/disconnect', async (_req, res) => {
    await blender.close();
    res.json(blender.status);
  });
  app.post('/api/blender/call', async (req, res) => res.json(await blender.call(req.body)));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'API 경로가 없습니다.' }));
  const staticDir = path.resolve(
    options.staticDir ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '../dist'),
  );
  app.use(express.static(staticDir, { index: 'index.html', dotfiles: 'deny' }));
  app.get('/{*path}', (_req, res) => {
    const index = path.join(staticDir, 'index.html');
    if (existsSync(index)) res.sendFile(index);
    else
      res
        .status(503)
        .type('text/plain')
        .send(
          '화면 빌드가 없습니다. npm run build 후 실행하세요. 개발 화면은 http://127.0.0.1:5173 입니다.',
        );
  });
  app.use(
    (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (res.headersSent) return;
      const status =
        error instanceof ApiError
          ? error.status
          : error instanceof ZodError || error instanceof SyntaxError
            ? 400
            : error instanceof multer.MulterError
              ? 413
              : 500;
      res.status(status).json({
        error:
          error instanceof ZodError
            ? '입력 형식이 올바르지 않습니다.'
            : error instanceof Error
              ? error.message
              : '요청을 처리하지 못했습니다.',
        ...(error instanceof ZodError
          ? { details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) }
          : error instanceof ApiError && error.details
            ? { details: error.details }
            : {}),
      });
    },
  );
  const server: Server = httpServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? Number(process.env.PORT ?? 4318), '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  }).catch((error) => {
    store.close();
    throw error;
  });
  const port = (server.address() as { port: number }).port;
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    stopping = true;
    for (const c of aborts.values()) c.abort();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pumping;
    await blender.close();
    store.close();
  }
  return { app, server, store, vault, url: `http://127.0.0.1:${port}`, port, dataDir, close };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createServer()
    .then((studio) => {
      console.log(`Design Studio: ${studio.url}`);
      const stop = () => studio.close().then(() => process.exit(0));
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
