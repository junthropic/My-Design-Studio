import { afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  createSigningSession,
  createTargetManifest,
  collectSigningFiles,
  verifyReleaseManifest,
} from '../scripts/signing-pipeline.mjs';

const temporary = [];
afterEach(async () => {
  for (const dir of temporary.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
const hash = async (file) =>
  createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex');
const valid = () => ({
  authenticodeStatus: 'Valid',
  signTool: { status: 'Valid', exitCode: 0 },
  rsa: true,
  sha256: true,
  rfc3161: true,
  timestampSha256: true,
  timestampValid: true,
  chainValid: true,
  signerThumbprint: 'AB'.repeat(20),
});
const unsigned = () => ({
  ...valid(),
  authenticodeStatus: 'NotSigned',
  signTool: { status: 'Invalid', exitCode: 1 },
  rsa: false,
  sha256: false,
  rfc3161: false,
  timestampSha256: false,
  timestampValid: false,
  chainValid: false,
  signerThumbprint: null,
});
async function pe(file) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const bytes = Buffer.alloc(256);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(128, 60);
  bytes.writeUInt32LE(0x4550, 128);
  await fs.writeFile(file, bytes);
  return file;
}
async function fixture(providerId = 'rsa-ov') {
  const work = path.resolve('work');
  await fs.mkdir(work, { recursive: true });
  const root = await fs.mkdtemp(path.join(work, 'signing-integration-'));
  temporary.push(root);
  const app = path.join(root, 'win-unpacked');
  await fs.mkdir(app);
  const main = await pe(path.join(app, 'Design Studio.exe')),
    vendor = await pe(path.join(app, 'vendor.dll')),
    native = await pe(path.join(app, 'resources', 'native.node'));
  const installer = path.join(root, 'Design Studio Setup 0.1.0.exe'),
    uninstaller = path.join(root, 'Design Studio Setup 0.1.0.__uninstaller.exe');
  const states = new Map([[vendor, valid()]]),
    calls = [];
  const inspect = vi.fn(async (file) => structuredClone(states.get(file) || unsigned()));
  const provider = {
    id: providerId,
    mode: 'mock',
    preflight: vi.fn(async () => {
      calls.push('preflight');
    }),
    sign: vi.fn(async (file) => {
      calls.push('sign:' + path.basename(file));
      await fs.appendFile(file, 'MOCK ONLY - NOT AN AUTHENTICODE SIGNATURE');
      states.set(file, valid());
    }),
  };
  const rule = (p, owner) => ({
    path: p,
    ownership: owner,
    origin: 'fixture',
    licenseEvidence: ['test fixture only'],
    purpose: 'test',
    signUnsigned: true,
  });
  const policy = {
    schemaVersion: 1,
    rules: [
      rule('Design Studio.exe', 'first-party'),
      rule('vendor.dll', 'bundled-third-party'),
      rule('resources/native.node', 'bundled-third-party'),
      rule('resources/elevate.exe', 'bundled-third-party'),
    ],
    installer: rule('', 'generated-installer'),
  };
  const manifestPath = path.join(root, 'manifest.json');
  const options = {
    appDirectory: app,
    outputDirectory: root,
    manifestPath,
    provider,
    inspect,
    policy,
    installerName: path.basename(installer),
    mode: 'mock',
  };
  const session = createSigningSession(options);
  return {
    root,
    app,
    main,
    vendor,
    native,
    installer,
    uninstaller,
    states,
    calls,
    inspect,
    provider,
    policy,
    manifestPath,
    options,
    session,
  };
}
async function complete(f) {
  await f.session.auditInternals(await collectSigningFiles(f.app));
  const elevate = await pe(path.join(f.app, 'resources/elevate.exe'));
  await f.session.processFile(elevate);
  await f.session.completeInternals(await collectSigningFiles(f.app));
  f.calls.push('compile-uninstaller-container');
  await pe(f.uninstaller);
  await f.session.processFile(f.uninstaller, { kind: 'uninstaller' });
  f.calls.push('compile-final-installer');
  await pe(f.installer);
  await f.session.processFile(f.installer, { kind: 'installer' });
  return f.session.finish(f.installer);
}

describe('signing providers → manifest → nested components → installer integration (mock only)', () => {
  it.each(['rsa-ov', 'azure-artifact-signing'])(
    'uses %s through the same pipeline; preserves vendor bytes and separates hashes',
    async (id) => {
      const f = await fixture(id),
        before = await hash(f.vendor);
      const report = await complete(f);
      expect(report.status).toBe('mock-complete');
      expect(report.productionVerified).toBe(false);
      expect(report.actualSigningPerformed).toBe(false);
      expect(await hash(f.vendor)).toBe(before);
      expect(f.provider.sign.mock.calls.some(([file]) => file === f.vendor)).toBe(false);
      const preserved = report.entries.find((e) => e.path === 'vendor.dll');
      expect(preserved.beforeSHA256).toBe(preserved.afterSHA256);
      expect(preserved.status).toBe('preserved');
      for (const entry of report.entries.filter((e) => e.status === 'signed')) {
        expect(entry.beforeSHA256).not.toBe(entry.afterSHA256);
        expect(entry.after.signTool.status).toBe('Valid');
        expect(entry.after.timestampSha256).toBe(true);
      }
      expect(f.provider.preflight).toHaveBeenCalledTimes(1);
      expect(f.calls.indexOf('sign:elevate.exe')).toBeLessThan(
        f.calls.indexOf('compile-uninstaller-container'),
      );
      expect(f.calls.indexOf('sign:Design Studio Setup 0.1.0.__uninstaller.exe')).toBeLessThan(
        f.calls.indexOf('compile-final-installer'),
      );
      expect(f.calls.at(-1)).toBe('sign:Design Studio Setup 0.1.0.exe');
    },
  );
  it('does not relabel an old valid vendor SHA1 signature as new production signing or replace it', async () => {
    const f = await fixture();
    f.states.set(f.vendor, { ...valid(), sha256: false, rfc3161: false, timestampSha256: false });
    const before = await hash(f.vendor);
    const report = await complete(f);
    expect(await hash(f.vendor)).toBe(before);
    expect(report.entries.find((e) => e.path === 'vendor.dll').after.sha256).toBe(false);
  });
  it.each([
    ['non-RSA', { rsa: false }],
    ['SHA1 file digest', { sha256: false }],
    ['legacy timestamp', { rfc3161: false }],
    ['SHA1 timestamp', { timestampSha256: false }],
    ['timestamp failure', { timestampValid: false }],
    ['chain error', { chainValid: false }],
    ['Authenticode error', { authenticodeStatus: 'NotTrusted' }],
    ['SignTool warning', { signTool: { status: 'Invalid', exitCode: 2 } }],
  ])('rejects %s before compiling any installer', async (_label, change) => {
    const f = await fixture();
    f.provider.sign.mockImplementation(async (file) => {
      await fs.appendFile(file, 'mock');
      f.states.set(file, { ...valid(), ...change });
    });
    await expect(f.session.completeInternals([f.main])).rejects.toThrow(
      'RSA_SHA256_RFC3161_OR_CHAIN_INVALID',
    );
    expect(f.calls).not.toContain('compile-final-installer');
    expect(f.session.snapshot().status).toBe('failed');
  });
  it('redacts signing failures and records post-attempt hash; a failed session cannot continue', async () => {
    const f = await fixture();
    f.provider.sign.mockImplementation(async (file) => {
      await fs.appendFile(file, 'partially-written');
      throw Error('PRIVATE_KEY PASSWORD CLIENT_SECRET TOKEN');
    });
    await expect(f.session.processFile(f.main)).rejects.toThrow('SIGN_OR_TIMESTAMP_FAILED');
    const report = JSON.parse(await fs.readFile(f.manifestPath, 'utf8'));
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE_KEY|PASSWORD|CLIENT_SECRET|TOKEN/);
    expect(report.entries[0].afterSHA256).not.toBe(report.entries[0].beforeSHA256);
    await expect(f.session.processFile(f.native)).rejects.toThrow('RELEASE_ALREADY_FAILED');
  });
  it('fails closed on unknown PE paths, invalid pre-existing signatures and either-tool failure', async () => {
    for (const variant of ['unknown', 'tampered', 'tool']) {
      const f = await fixture();
      let file = f.vendor;
      if (variant === 'unknown') file = await pe(path.join(f.app, 'unknown.payload'));
      if (variant === 'tampered')
        f.states.set(file, { ...valid(), authenticodeStatus: 'HashMismatch' });
      if (variant === 'tool')
        f.states.set(file, { ...valid(), signTool: { status: 'Unavailable', exitCode: null } });
      await expect(f.session.processFile(file)).rejects.toThrow();
      expect(f.provider.sign).not.toHaveBeenCalled();
    }
  });
  it('refuses installer signing before internal and uninstaller validation', async () => {
    const f = await fixture();
    await pe(f.installer);
    await expect(f.session.processFile(f.installer, { kind: 'installer' })).rejects.toThrow(
      'SIGNING_ORDER_VIOLATION',
    );
    expect(f.provider.sign).not.toHaveBeenCalled();
  });
  it('detects a vendor change after preservation and any unexpected late PE', async () => {
    const f = await fixture();
    await f.session.processFile(f.vendor);
    await fs.appendFile(f.vendor, 'modified');
    await expect(f.session.processFile(f.vendor)).rejects.toThrow('SIGNED_FILE_CHANGED');
    const other = await fixture();
    await complete(other);
    await pe(path.join(other.app, 'late.bin'));
    await expect(other.session.finish(other.installer)).rejects.toThrow(
      'INTERNAL_INVENTORY_CHANGED',
    );
  });
  it('collects PE without native suffix and creates read-only pre-sign manifest with null post hashes', async () => {
    const f = await fixture();
    await pe(path.join(f.app, 'unexpected.payload'));
    const report = await createTargetManifest({
      appDirectory: f.app,
      inspect: f.inspect,
      policy: f.policy,
      outputPath: path.join(f.root, 'plan.json'),
    });
    expect(report.entries).toHaveLength(4);
    expect(report.entries.find((e) => e.path === 'unexpected.payload').action).toBe(
      'blocked-unknown',
    );
    expect(
      report.entries.every((e) => e.beforeSHA256.length === 64 && e.afterSHA256 === null),
    ).toBe(true);
    expect(f.provider.sign).not.toHaveBeenCalled();
  });
  it('never accepts a mock provider as production and stops on missing production credentials', async () => {
    const f = await fixture();
    await complete(f);
    expect(() => createSigningSession({ ...f.options, mode: 'production' })).toThrow(
      'PROVIDER_MODE_MISMATCH',
    );
    const production = {
      ...f.provider,
      mode: 'production',
      preflight: vi.fn(async () => {
        throw Error('missing credential');
      }),
      sign: vi.fn(),
    };
    const session = createSigningSession({
      ...f.options,
      mode: 'production',
      provider: production,
    });
    await expect(session.processFile(f.main)).rejects.toThrow(
      'PRODUCTION_CREDENTIAL_OR_TOOL_UNAVAILABLE',
    );
    expect(production.sign).not.toHaveBeenCalled();
  });
  it('final verification rejects a successful mock manifest before inspecting or launching anything', async () => {
    const f = await fixture();
    await complete(f);
    const inspect = vi.fn();
    await expect(
      verifyReleaseManifest({
        appDirectory: f.app,
        installer: f.installer,
        manifestPath: f.manifestPath,
        inspect,
      }),
    ).rejects.toThrow('PRODUCTION_MANIFEST_REQUIRED');
    expect(inspect).not.toHaveBeenCalled();
  });
});
