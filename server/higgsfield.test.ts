import { afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StudioStore } from './store';
import { SecretVault } from './security';
import { HiggsfieldConnector } from './integrations';
import { createProject } from '../src/core/templates';
let store: StudioStore | undefined;
let dir = '';
afterEach(() => {
  vi.unstubAllGlobals();
  store?.close();
  store = undefined;
  const rel = path.relative(tmpdir(), dir);
  if (rel.startsWith('studio-higgs-test-') && !rel.includes(path.sep))
    rmSync(dir, { recursive: true, force: true });
});
async function setup() {
  dir = mkdtempSync(path.join(tmpdir(), 'studio-higgs-test-'));
  store = await StudioStore.open(dir);
  const project = store.create(createProject());
  const vault = new SecretVault(store);
  vault.set('higgsfield', 'fake-id:fake-secret');
  return { project, connector: new HiggsfieldConnector(store, vault) };
}
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
describe('provider idempotency and budgets', () => {
  it('replays an ambiguous submission with its original provider key and identical body', async () => {
    const { project, connector } = await setup();
    const calls = vi
      .fn()
      .mockResolvedValueOnce(json({ credits: '2', usd: '0.5' }))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(
        json({
          request_id: 'request-1',
          status_url: 'https://api.higgsfield.ai/requests/request-1/status',
          cancel_url: 'https://api.higgsfield.ai/requests/request-1/cancel',
        }),
      )
      .mockResolvedValueOnce(
        json({ status: 'completed', images: [{ url: 'https://cdn.example.com/image.png' }] }),
      );
    vi.stubGlobal('fetch', calls);
    const quote = await connector.quote({
      projectId: project.id,
      modelEndpoint: 'higgsfield-ai/soul/v2/standard',
      input: { prompt: 'test', width: 1024 },
    });
    const first = await connector.submit({
      quoteId: quote.id,
      idempotencyKey: 'stable-test-key',
      confirmPaid: true,
      priceAcknowledged: true,
    });
    expect(first?.status).toBe('submission-unknown');
    const retried = await connector.retry(first!.id, { confirmRetry: true });
    expect(retried.status).toBe('queued');
    expect(calls.mock.calls[1][1].headers['Idempotency-Key']).toBe('stable-test-key');
    expect(calls.mock.calls[2][1].headers['Idempotency-Key']).toBe('stable-test-key');
    expect(calls.mock.calls[2][1].body).toBe(calls.mock.calls[1][1].body);
    expect(connector.budget().reservedUsd).toBe(0.5);
    expect(connector.list(project.id)).toHaveLength(1);
    const completed = await connector.status(first!.id);
    expect(completed.status).toBe('completed');
    expect(calls.mock.calls[3][0]).toBe('https://api.higgsfield.ai/requests/request-1/status');
    expect(calls).toHaveBeenCalledTimes(4);
  });
  it('rejects a quote above the configured daily budget without sending a generation', async () => {
    const { project, connector } = await setup();
    store!.setSetting('higgsfield', { dailyBudgetUsd: 0.1 });
    const calls = vi.fn().mockResolvedValueOnce(json({ credits: '2', usd: '0.5' }));
    vi.stubGlobal('fetch', calls);
    const quote = await connector.quote({
      projectId: project.id,
      modelEndpoint: 'higgsfield-ai/soul/v2/standard',
      input: { prompt: 'test' },
    });
    await expect(
      connector.submit({
        quoteId: quote.id,
        idempotencyKey: 'budget-test-key',
        confirmPaid: true,
        priceAcknowledged: true,
      }),
    ).rejects.toThrow('한도');
    expect(calls).toHaveBeenCalledTimes(1);
    expect(connector.list()).toHaveLength(0);
  });
  it('never forwards credentials to a provider-supplied off-domain status URL', async () => {
    const { project, connector } = await setup();
    const calls = vi
      .fn()
      .mockResolvedValueOnce(json({ credits: '2', usd: '0.5' }))
      .mockResolvedValueOnce(
        json({
          request_id: 'request-1',
          status_url: 'https://evil.invalid/requests/request-1/status',
          cancel_url: 'https://api.higgsfield.ai/requests/request-1/cancel',
        }),
      );
    vi.stubGlobal('fetch', calls);
    const quote = await connector.quote({
      projectId: project.id,
      modelEndpoint: 'higgsfield-ai/soul/v2/standard',
      input: { prompt: 'test' },
    });
    const job = await connector.submit({
      quoteId: quote.id,
      idempotencyKey: 'origin-test-key',
      confirmPaid: true,
      priceAcknowledged: true,
    });
    expect(job?.status).toBe('submission-unknown');
    await expect(connector.status(job!.id)).rejects.toThrow('상태 URL');
    expect(calls).toHaveBeenCalledTimes(2);
  });
});
