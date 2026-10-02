import { afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { configureProductionBuild } from '../scripts/signing-build.mjs';
import { createSigningConfig, packageSigned } from '../scripts/signing-config.mjs';
import { createSigningSession, readOwnershipPolicy } from '../scripts/signing-pipeline.mjs';

const temporary = [];
afterEach(async () => {
  for (const directory of temporary.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});
const hash = async (file) =>
  createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex');
const evidence = (signed = true) => ({
  authenticodeStatus: signed ? 'Valid' : 'NotSigned',
  signTool: { status: signed ? 'Valid' : 'Invalid', exitCode: signed ? 0 : 1 },
  rsa: signed,
  sha256: signed,
  rfc3161: signed,
  timestampSha256: signed,
  timestampValid: signed,
  chainValid: signed,
  signerThumbprint: signed ? 'AB'.repeat(20) : null,
});
async function writePe(file) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const bytes = Buffer.alloc(256);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(128, 60);
  bytes.writeUInt32LE(0x4550, 128);
  await fs.writeFile(file, bytes);
  return file;
}
async function fixture(id = 'rsa-ov') {
  const work = path.resolve('work');
  await fs.mkdir(work, { recursive: true });
  const projectDir = await fs.mkdtemp(path.join(work, 'signing-build-mock-'));
  temporary.push(projectDir);
  const output = path.join(projectDir, 'release-signed');
  const app = path.join(output, 'win-unpacked');
  const policy = await readOwnershipPolicy();
  const files = [],
    preserved = new Map(),
    states = new Map(),
    events = [];
  for (const rule of policy.rules) {
    if (rule.path === 'resources/elevate.exe') continue;
    const file = await writePe(path.join(app, rule.path));
    files.push(file);
    if (!rule.signUnsigned) {
      states.set(file, evidence());
      preserved.set(file, await hash(file));
    }
  }
  const env =
    id === 'rsa-ov'
      ? {
          STUDIO_SIGNING_MODE: 'store',
          STUDIO_CERTIFICATE_SHA1: 'AB'.repeat(20),
          STUDIO_SIGNING_PUBLISHER: 'Design Studio',
        }
      : {
          STUDIO_SIGNING_MODE: 'azure',
          STUDIO_SIGNING_PUBLISHER: 'Design Studio',
          STUDIO_AZURE_ENDPOINT: 'https://krc.codesigning.azure.net',
          STUDIO_AZURE_ACCOUNT: 'account',
          STUDIO_AZURE_PROFILE: 'profile',
          AZURE_TENANT_ID: '11111111-2222-3333-4444-555555555555',
          AZURE_CLIENT_ID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          AZURE_CLIENT_SECRET: 'MOCK_SECRET',
        };
  const metadata = {
    version: '0.1.0',
    build: {
      productName: 'Design Studio',
      directories: { output: 'release' },
      win: { target: 'nsis' },
    },
  };
  const config = await createSigningConfig({
    baseConfig: metadata.build,
    env,
    platform: 'win32',
    fileReadable: async () => true,
    hasStoreCertificate: async () => true,
  });
  const provider = {
    id,
    mode: 'mock',
    preflight: vi.fn(async () => {
      events.push('preflight');
    }),
    sign: vi.fn(async (file) => {
      events.push('sign:' + path.basename(file));
      await fs.appendFile(file, 'MOCK ONLY; NOT A SIGNATURE');
      states.set(file, evidence());
    }),
  };
  const providerFactory = vi.fn(async () => provider);
  const inspect = vi.fn(async (file) => structuredClone(states.get(file) || evidence(false)));
  let barrier;
  const installNsis = vi.fn(async (options) => {
    events.push('install-adapter');
    barrier = options.beforeInstallerBuild;
  });
  const discover = vi.fn(async () => 'mock-signtool-path');
  const options = {
    config,
    metadata,
    projectDir,
    env,
    providerFactory,
    inspect,
    installNsis,
    discover,
    policyLoader: async () => policy,
    sessionFactory: (options) => createSigningSession({ ...options, mode: 'mock' }),
  };
  const context = { arch: 1, electronPlatformName: 'win32', appOutDir: app, packager: { config } };
  const installer = path.join(output, 'Design Studio Setup 0.1.0.exe');
  const uninstaller = path.join(output, 'Design Studio Setup 0.1.0.__uninstaller.exe');
  const sign = (file, changes = {}) =>
    config.win.signtoolOptions.sign({ path: file, hash: 'sha256', isNest: false, ...changes });
  return {
    projectDir,
    output,
    app,
    policy,
    preserved,
    files,
    states,
    events,
    env,
    config,
    provider,
    providerFactory,
    inspect,
    installNsis,
    discover,
    options,
    context,
    installer,
    uninstaller,
    sign,
    barrier: () => barrier({ target: { archs: new Map([[1, app]]) } }),
  };
}

describe('electron-builder signing configuration integration — injected mocks only', () => {
  it.each(['rsa-ov', 'azure-artifact-signing'])(
    'routes %s through the custom broker and preserves all four existing vendor files',
    async (id) => {
      const f = await fixture(id);
      await configureProductionBuild(f.options);
      expect(f.config.win.azureSignOptions).toBeUndefined();
      expect(f.config.win.signtoolOptions.signingHashAlgorithms).toEqual(['sha256']);
      expect(typeof f.config.win.signtoolOptions.sign).toBe('function');
      expect(f.config.forceCodeSigning).toBe(true);
      expect(f.installNsis).not.toHaveBeenCalled();
      await expect(f.sign(f.files[0])).rejects.toThrow('SESSION_NOT_READY');
      await f.config.beforePack(f.context);
      expect(f.events.slice(0, 2)).toEqual(['preflight', 'install-adapter']);
      for (const file of f.files) await f.sign(file);
      await f.config.afterSign({ appOutDir: f.app });
      const elevate = await writePe(path.join(f.app, 'resources/elevate.exe'));
      await f.sign(elevate); // Helper arrives after afterSign, as the actual NSIS lifecycle does.
      await f.barrier();
      f.events.push('compile-uninstaller');
      await writePe(f.uninstaller);
      await f.sign(f.uninstaller);
      f.events.push('compile-final-installer');
      await writePe(f.installer);
      await f.sign(f.installer);
      await f.config.artifactBuildCompleted({ file: f.installer });
      const report = JSON.parse(
        await fs.readFile(path.join(f.output, 'signing-manifest.json'), 'utf8'),
      );
      expect(report.mode).toBe('mock');
      expect(report.productionVerified).toBe(false);
      expect(report.actualSigningPerformed).toBe(false);
      expect(report.status).toBe('mock-complete');
      expect(report.entries.filter((entry) => entry.kind === 'internal')).toHaveLength(43);
      expect(f.preserved.size).toBe(4);
      for (const [file, before] of f.preserved) {
        expect(await hash(file)).toBe(before);
        expect(f.provider.sign.mock.calls.some(([signed]) => signed === file)).toBe(false);
      }
      expect(f.events.indexOf('sign:elevate.exe')).toBeLessThan(
        f.events.indexOf('compile-uninstaller'),
      );
      expect(f.events.indexOf('sign:' + path.basename(f.uninstaller))).toBeLessThan(
        f.events.indexOf('compile-final-installer'),
      );
      expect(f.events.at(-1)).toBe('sign:' + path.basename(f.installer));
      expect(f.provider.sign).toHaveBeenCalledTimes(41);
      expect(JSON.stringify(report)).not.toContain('MOCK_SECRET');
      expect(
        f.inspect.mock.calls.every(([, options]) => options.signtoolPath === 'mock-signtool-path'),
      ).toBe(true);
    },
  );
  it('missing credential stops before adapter installation, tool discovery, policy loading, or build', async () => {
    const f = await fixture();
    f.provider.preflight.mockRejectedValueOnce(new Error('Credential unavailable'));
    const policyLoader = vi.fn(),
      run = vi.fn();
    await expect(
      packageSigned({
        check: () => configureProductionBuild({ ...f.options, policyLoader }),
        run,
      }),
    ).rejects.toThrow('Credential unavailable');
    expect(f.discover).not.toHaveBeenCalled();
    expect(policyLoader).not.toHaveBeenCalled();
    expect(f.installNsis).not.toHaveBeenCalled();
    expect(f.provider.sign).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
  it('tool absence and an unexpected build context fail before installing hooks or signing', async () => {
    const noTool = await fixture();
    await expect(
      configureProductionBuild({ ...noTool.options, discover: async () => null }),
    ).rejects.toThrow('SIGNTOOL_UNAVAILABLE');
    expect(noTool.installNsis).not.toHaveBeenCalled();
    const f = await fixture();
    await configureProductionBuild(f.options);
    await expect(f.config.beforePack({ ...f.context, arch: 3 })).rejects.toThrow('ONLY_X64');
    expect(f.installNsis).not.toHaveBeenCalled();
    expect(f.provider.sign).not.toHaveBeenCalled();
    await f.config.beforePack(f.context);
    await expect(f.config.beforePack(f.context)).rejects.toThrow('MULTIPLE_PACK_CONTEXTS');
  });
  it('rejects forbidden hash/nesting and premature installer completion', async () => {
    const f = await fixture();
    await configureProductionBuild(f.options);
    await f.config.beforePack(f.context);
    for (const change of [{ hash: 'sha1' }, { isNest: true }])
      await expect(f.sign(f.files[0], change)).rejects.toThrow('ONLY_SINGLE_SHA256');
    expect(f.provider.sign).not.toHaveBeenCalled();
    await f.config.artifactBuildCompleted({ file: 'ignored.exe.blockmap' });
    await expect(f.config.artifactBuildCompleted({ file: f.installer })).rejects.toThrow(
      'INSTALLER_NOT_SIGNED',
    );
  });
  it('barrier rejects wrong archive identity and unknown late PE before any installer signature', async () => {
    const wrong = await fixture();
    await configureProductionBuild(wrong.options);
    await wrong.config.beforePack(wrong.context);
    const barrier = wrong.installNsis.mock.calls[0][0].beforeInstallerBuild;
    await expect(
      barrier({ target: { archs: new Map([[1, path.join(wrong.projectDir, 'other')]]) } }),
    ).rejects.toThrow('UNEXPECTED_NSIS_ARCHIVE');
    expect(wrong.provider.sign).not.toHaveBeenCalled();
    const late = await fixture();
    await configureProductionBuild(late.options);
    await late.config.beforePack(late.context);
    await late.config.afterSign({ appOutDir: late.app });
    await writePe(path.join(late.app, 'unknown-late.bin'));
    await expect(late.barrier()).rejects.toThrow('OWNERSHIP_OR_SIGNATURE_REJECTED');
    expect(
      late.provider.sign.mock.calls.every(([file]) => path.dirname(file) !== late.output),
    ).toBe(true);
  });
});
