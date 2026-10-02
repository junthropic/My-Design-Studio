import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StudioStore } from './store';
import { SecretVault, publicUrl, inside } from './security';
import { applyCommands } from './ai';
import { importDataset, normalizeRows } from './datasets';
import { validateFont, fontFamily, fontsCss } from './fonts';
import { HiggsfieldConnector, BlenderConnector } from './integrations';
import { createServer } from './index';
import { createProject } from '../src/core/templates';

const tempDirs: string[] = [];
const cleanups: (() => Promise<unknown> | unknown)[] = [];
function temp() {
  const dir = mkdtempSync(path.join(tmpdir(), 'design-studio-test-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const close of cleanups.splice(0).reverse()) await close();
  for (const dir of tempDirs.splice(0)) {
    const rel = path.relative(tmpdir(), dir);
    if (rel.startsWith('design-studio-test-') && !rel.includes(path.sep))
      rmSync(dir, { recursive: true, force: true });
  }
});
describe('durable local projects', () => {
  it('rejects stale saves, restores as a new revision, and persists on restart', async () => {
    const dir = temp();
    let store = await StudioStore.open(dir);
    const first = store.create(createProject('테스트'));
    const second = store.save({ ...first, name: '두 번째' }, 1);
    expect(second.revision).toBe(2);
    expect(() => store.save({ ...first, name: '덮어쓰기' }, 1)).toThrow('다른 창');
    const restored = store.restore(first.id, 1, 2);
    expect(restored.name).toBe('테스트');
    expect(restored.revision).toBe(3);
    store.close();
    store = await StudioStore.open(dir);
    cleanups.push(() => store.close());
    expect(store.project(first.id).revision).toBe(3);
    expect(store.revisions(first.id).map((r) => r.revision)).toEqual([3, 2, 1]);
  });
  it('does not persist standalone provider secrets in SQLite', async () => {
    const dir = temp();
    const store = await StudioStore.open(dir);
    cleanups.push(() => store.close());
    const vault = new SecretVault(store);
    vault.set('openai', 'secret-never-write-me');
    expect(vault.persistence).toBe('session-only');
    expect(vault.get('openai')).toBe('secret-never-write-me');
    store.flush();
    expect(
      readFileSync(path.join(dir, 'studio.sqlite')).includes(Buffer.from('secret-never-write-me')),
    ).toBe(false);
    vault.remove('openai');
    expect(vault.get('openai')).toBeUndefined();
  });
  it('encrypts only through the provided OS cipher contract', async () => {
    const store = await StudioStore.open(temp());
    cleanups.push(() => store.close());
    const cipher = {
      encrypt: (v: string) => Buffer.from(v.split('').reverse().join('')),
      decrypt: (v: Buffer) => v.toString().split('').reverse().join(''),
    };
    const vault = new SecretVault(store, cipher);
    vault.set('openai', 'my-key-123');
    expect(vault.persistence).toBe('os-encrypted');
    expect(vault.get('openai')).toBe('my-key-123');
    expect(JSON.stringify(store.setting('secret:openai', {}))).not.toContain('my-key-123');
  });
});
describe('bounded inputs', () => {
  it('rejects private network fetches before connecting', async () => {
    await expect(publicUrl('https://127.0.0.1/data')).rejects.toThrow('내부 네트워크');
    await expect(publicUrl('http://example.com')).rejects.toThrow('HTTPS');
    await expect(publicUrl('https://[::1]/')).rejects.toThrow('내부 네트워크');
    expect(() => inside(temp(), '../escape')).toThrow('허용되지 않는');
  });
  it('normalizes real CSV rows, rejects prototype columns, and keeps data values', async () => {
    const dataset = await importDataset(Buffer.from('월,매출\n1월,1200\n2월,1400\n'), '매출.csv');
    expect(dataset.columns).toEqual(['월', '매출']);
    expect(dataset.rows[1]['매출']).toBe(1400);
    expect(() => normalizeRows(JSON.parse('[{"__proto__":"unsafe"}]'), 'bad')).toThrow('열 이름');
  });
  it('preserves zero-padded IDs, long numbers, and date strings in CSV imports', async () => {
    const dataset = await importDataset(
      Buffer.from('id,long,date,amount\n00123,12345678901234567890,2026-10-02,12.5'),
      'ids.csv',
    );
    expect(dataset.rows[0]).toEqual({
      id: '00123',
      long: '12345678901234567890',
      date: '2026-10-02',
      amount: 12.5,
    });
  });
  it('rejects font impostors and normalizes names before generating CSS', () => {
    expect(() => validateFont(Buffer.alloc(100), '.woff2')).toThrow('헤더');
    const impostor = Buffer.alloc(60);
    impostor.write('wOF2');
    impostor.writeUInt32BE(0x10000, 4);
    impostor.writeUInt32BE(60, 8);
    impostor.writeUInt16BE(5, 12);
    impostor.writeUInt32BE(1000, 16);
    impostor.writeUInt32BE(100, 20);
    expect(() => validateFont(impostor, '.woff2')).toThrow('압축 데이터');
    const asset = {
      id: 'safe-id',
      name: '";body{color:red}.woff2',
      mime: 'font/woff2',
      relativePath: 'abcdef.woff2',
      hash: 'abcdef',
      size: 60,
    };
    expect(fontFamily(asset)).toBe('body color red');
    const css = fontsCss([asset]);
    expect(css).toContain('font-family:"body color red"');
    expect(css).not.toContain('body{');
    expect(css).toContain('/api/assets/safe-id');
  });
  it('applies only explicit design commands without mutating the source', () => {
    const p = createProject();
    const after = applyCommands(p, [{ type: 'brand', path: 'color', value: '#123456' }]);
    expect(after.brand.color).toBe('#123456');
    expect(p.brand.color).not.toBe('#123456');
    expect(() => applyCommands(p, [{ type: 'token', path: 'dark.__proto__', value: 'x' }])).toThrow(
      '허용되지 않는',
    );
    expect(() =>
      applyCommands(p, [{ type: 'text', path: 'slide.missing.missing', value: 'x' }]),
    ).toThrow('텍스트');
    expect(() =>
      applyCommands(p, [
        { type: 'token', path: 'dark.color.brand', value: 'url(https://evil.invalid)' },
      ]),
    ).toThrow('허용되지 않는');
  });
  it('rejects arbitrary Blender commands before launching any process', async () => {
    const blender = new BlenderConnector();
    await expect(blender.connect({ command: 'powershell.exe', args: ['bad'] })).rejects.toThrow(
      '허용된 실행',
    );
    await expect(
      blender.connect({ command: 'uvx', args: ['mcp-for-blender', '--injected'] }),
    ).rejects.toThrow('허용된 실행');
  });
});
describe('Higgsfield charging boundary', () => {
  it('uses estimate response and immutable payload, submits only once per quote', async () => {
    const store = await StudioStore.open(temp());
    cleanups.push(() => store.close());
    const project = store.create(createProject());
    const vault = new SecretVault(store);
    vault.set('higgsfield', 'test-key:test-secret');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ credits: '1.5', usd: '0.094' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ request_id: 'provider-123' }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const connector = new HiggsfieldConnector(store, vault);
    const quote = await connector.quote({
      projectId: project.id,
      modelEndpoint: 'higgsfield-ai/soul/v2/standard',
      input: { prompt: 'A blue abstract background' },
    });
    expect(quote.estimatedCostUsd).toBe(0.094);
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      '/estimate/higgsfield-ai/soul/v2/standard',
    );
    await expect(
      connector.submit({
        quoteId: quote.id,
        idempotencyKey: 'repeat-key',
        confirmPaid: false,
        priceAcknowledged: true,
      }),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const job = await connector.submit({
      quoteId: quote.id,
      idempotencyKey: 'repeat-key',
      confirmPaid: true,
      priceAcknowledged: true,
    });
    const again = await connector.submit({
      quoteId: quote.id,
      idempotencyKey: 'other-key',
      confirmPaid: true,
      priceAcknowledged: true,
    });
    expect(again?.id).toBe(job?.id);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      prompt: 'A blue abstract background',
    });
  });
});
describe('HTTP routes', () => {
  it.skipIf(!existsSync('public/fonts/PretendardVariable.woff2'))(
    'uploads and serves a real WOFF2 through safe font CSS',
    async () => {
      const studio = await createServer({ port: 0, dataDir: temp() });
      cleanups.push(studio.close);
      const p = studio.store.create(createProject());
      const form = new FormData();
      form.append(
        'file',
        new Blob([readFileSync('public/fonts/PretendardVariable.woff2')]),
        'PretendardVariable.woff2',
      );
      const uploaded = await fetch(studio.url + `/api/projects/${p.id}/assets`, {
        method: 'POST',
        headers: { 'x-studio-request': '1' },
        body: form,
      });
      expect(uploaded.status).toBe(201);
      const result = await uploaded.json();
      expect(result.asset.mime).toBe('font/woff2');
      const fonts = await (await fetch(studio.url + `/api/fonts?projectId=${p.id}`)).json();
      expect(fonts[0].fontFamily).toBe('PretendardVariable');
      const css = await (await fetch(studio.url + `/api/fonts.css?projectId=${p.id}`)).text();
      expect(css).toContain('font-family:"PretendardVariable"');
      const font = await fetch(studio.url + '/api/assets/' + result.asset.id);
      expect(font.headers.get('content-type')).toContain('font/woff2');
      expect((await font.arrayBuffer()).byteLength).toBe(result.asset.size);
    },
  );
  it('exports an immutable revision, downloads its package, and imports a new project', async () => {
    const studio = await createServer({ port: 0, dataDir: temp() });
    cleanups.push(studio.close);
    const headers = { 'content-type': 'application/json', 'x-studio-request': '1' };
    const p = studio.store.create(createProject('왕복 확인'));
    const response = await fetch(studio.url + `/api/projects/${p.id}/export`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ format: 'project' }),
    });
    expect(response.status).toBe(202);
    const queued = await response.json();
    studio.store.save({ ...p, name: '나중 변경' }, 1);
    let job = queued;
    for (let n = 0; n < 100 && ['queued', 'running'].includes(job.status); n++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      job = await (await fetch(studio.url + '/api/jobs/' + queued.id)).json();
    }
    expect(job.status).toBe('completed');
    expect(job.revision).toBe(1);
    const download = await fetch(studio.url + `/api/jobs/${job.id}/files/0`);
    expect(download.status).toBe(200);
    const form = new FormData();
    form.append('file', new Blob([await download.arrayBuffer()]), 'test.designstudio');
    const imported = await fetch(studio.url + '/api/import', {
      method: 'POST',
      headers: { 'x-studio-request': '1' },
      body: form,
    });
    expect(imported.status).toBe(201);
    const copy = await imported.json();
    expect(copy.id).not.toBe(p.id);
    expect(copy.name).toBe('왕복 확인 · 가져옴');
    expect(copy.slides).toEqual(p.slides);
    expect(studio.store.project(p.id).name).toBe('나중 변경');
  });
  it('guards mutations, supports revisions and CSV upload, and keeps provider keys private', async () => {
    const studio = await createServer({ port: 0, dataDir: temp() });
    cleanups.push(studio.close);
    const headers = { 'content-type': 'application/json', 'x-studio-request': '1' };
    const blocked = await fetch(studio.url + '/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(blocked.status).toBe(403);
    const create = await fetch(studio.url + '/api/projects', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'API 확인' }),
    });
    expect(create.status).toBe(201);
    const project = await create.json();
    const save = await fetch(studio.url + '/api/projects/' + project.id, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ project: { ...project, name: '변경' }, baseRevision: 1 }),
    });
    expect(save.status).toBe(200);
    const stale = await fetch(studio.url + '/api/projects/' + project.id, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ project, baseRevision: 1 }),
    });
    expect(stale.status).toBe(409);
    const form = new FormData();
    form.append('file', new Blob(['label,value\nA,10\nB,20']), 'metrics.csv');
    const data = await fetch(studio.url + `/api/projects/${project.id}/datasets`, {
      method: 'POST',
      headers: { 'x-studio-request': '1' },
      body: form,
    });
    expect(data.status).toBe(201);
    expect((await data.json()).dataset.rows).toHaveLength(2);
    const key = await fetch(studio.url + '/api/settings/secrets/openai', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ key: 'secret-example' }),
    });
    const settings = await key.json();
    expect(settings.secrets.openai).toBe(true);
    expect(JSON.stringify(settings)).not.toContain('secret-example');
    const evil = await fetch(studio.url + '/api/projects', {
      headers: { Origin: 'https://evil.invalid' },
    });
    expect(evil.status).toBe(403);
  });
});
