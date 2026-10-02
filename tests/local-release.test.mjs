import { afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateConfiguration } from 'app-builder-lib/out/util/config/config';
import { DebugLogger } from 'builder-util';
import { localBuilderConfig } from '../scripts/local-builder.config.mjs';
import {
  releaseMode,
  localEnvironment,
  localRoot,
  projectDir,
  sha256,
  writeJson,
  assertProductionPreserved,
  runLocalTool,
} from '../scripts/local-common.mjs';
import { readSmartAppControl, localLaunchDecision } from '../scripts/local-policy.mjs';
import {
  acceptLocalSignature,
  createLocalInventory,
  verifyLocalIntegrity,
  readLocalPE,
  validateLocalRuntime,
} from '../scripts/local-inventory.mjs';
import { verifyLocalRelease } from '../scripts/verify-local-release.mjs';
import { buildLocalRelease, checkBaselineTests } from '../scripts/local-release.mjs';
import { verifyLocalRuntime, localFormats } from '../scripts/local-runtime-verification.mjs';
import JSZip from 'jszip';

const temporary = [];
afterEach(async () => {
  for (const dir of temporary.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
async function fixture(parent = os.tmpdir()) {
  await fs.mkdir(parent, { recursive: true });
  const dir = await fs.mkdtemp(path.join(parent, 'local-test-'));
  temporary.push(dir);
  return dir;
}
function peBytes() {
  const b = Buffer.alloc(1024);
  b.writeUInt16LE(0x5a4d);
  b.writeUInt32LE(64, 60);
  b.writeUInt32LE(0x4550, 64);
  b.writeUInt16LE(0x8664, 68);
  b.writeUInt16LE(1, 70);
  b.writeUInt16LE(240, 84);
  b.writeUInt16LE(0x20b, 88);
  b.writeUInt32LE(4096, 144);
  b.writeUInt32LE(512, 148);
  b.writeUInt32LE(512, 344);
  b.writeUInt32LE(512, 348);
  return b;
}
const rule = { path: 'Design Studio.exe', ownership: 'first-party', signUnsigned: true };
const base = { rule, pe: { valid: true }, hash: 'abc' };
const inspect = async () => ({ status: 'NotSigned' }),
  runtimeCheck = async () => ({ passed: true });
const preserve = async () => ({ passed: true });

describe('LOCAL separate release', () => {
  it('defaults to local; invalid modes fail', () => {
    expect(releaseMode()).toBe('local');
    expect(releaseMode('production')).toBe('production');
    expect(() => releaseMode('bypass')).toThrow();
  });
  it('strips credentials, secret/token/debug and injected NODE_OPTIONS', () => {
    const env = localEnvironment({
      SystemRoot: 'C:\\Windows',
      AZURE_CLIENT_SECRET: 'sentinel',
      WIN_CSC_KEY_PASSWORD: 'sentinel',
      TOKEN: 'sentinel',
      NODE_OPTIONS: 'sentinel',
      DEBUG: 'sentinel',
      CSC_LINK: 'sentinel',
      STUDIO_SIGNING_MODE: 'azure',
    });
    expect(env).toEqual({ SystemRoot: 'C:\\Windows', CSC_IDENTITY_AUTO_DISCOVERY: 'false' });
  });
  it('uses a separate no-signing, no-installer config accepted by builder', async () => {
    const config = localBuilderConfig(path.join(localRoot, 'builds', 'fixture'));
    expect(config).toMatchObject({
      forceCodeSigning: false,
      win: { target: 'dir', signExecutable: false, signAndEditExecutable: false },
    });
    expect(config.nsis).toBeUndefined();
    expect(config.win.azureSignOptions).toBeUndefined();
    expect(config.afterSign).toBeUndefined();
    expect(config.extraResources[0].filter).toContain('!debug.log');
    await validateConfiguration(config, new DebugLogger(false));
  });
  it('rejects production output paths', () => {
    expect(() => localBuilderConfig(path.join(projectDir, 'release'))).toThrow(
      'LOCAL_OUTPUT_OUTSIDE',
    );
  });
  it('allows first-party NotSigned without a credential', () => {
    expect(acceptLocalSignature({ ...base, signature: { status: 'NotSigned' } })).toBe(
      'allow-unsigned-first-party',
    );
  });
  it('preserves Valid third-party byte hash', () => {
    expect(
      acceptLocalSignature({
        ...base,
        signature: { status: 'Valid' },
        previous: { status: 'Valid', sha256: 'abc' },
      }),
    ).toBe('preserve-valid-signature');
    expect(() =>
      acceptLocalSignature({
        ...base,
        hash: 'changed',
        signature: { status: 'Valid' },
        previous: { status: 'Valid', sha256: 'abc' },
      }),
    ).toThrow('VENDOR_SIGNATURE_CHANGED');
  });
  it.each(['HashMismatch', 'NotTrusted', 'UnknownError', 'Invalid'])(
    'rejects %s signatures',
    (status) => {
      expect(() => acceptLocalSignature({ ...base, signature: { status } })).toThrow(
        'INVALID_SIGNATURE',
      );
    },
  );
  it('rejects lost vendor signatures', () => {
    expect(() =>
      acceptLocalSignature({
        ...base,
        signature: { status: 'NotSigned' },
        previous: { status: 'Valid', sha256: 'abc' },
      }),
    ).toThrow('VENDOR_SIGNATURE_CHANGED');
  });
  it('rejects corrupted PE and missing required runtime', async () => {
    const dir = await fixture();
    const file = path.join(dir, 'bad.exe');
    await fs.writeFile(file, Buffer.from('MZbroken'));
    expect(await readLocalPE(file)).toMatchObject({ valid: false });
    expect(() =>
      acceptLocalSignature({ ...base, pe: { valid: false }, signature: { status: 'NotSigned' } }),
    ).toThrow('CORRUPTED');
    await expect(validateLocalRuntime(dir, { rules: [] })).rejects.toThrow('RUNTIME_MISSING');
  });
  it('records full inventory then detects modified files and omitted executables', async () => {
    const dir = await fixture(),
      app = path.join(dir, 'app'),
      manifestPath = path.join(dir, 'inventory.json');
    await fs.mkdir(app);
    const exe = path.join(app, rule.path);
    await fs.writeFile(exe, peBytes());
    const policy = { rules: [rule] };
    const manifest = await createLocalInventory({
      appDirectory: app,
      outputPath: manifestPath,
      inspect,
      runtimeCheck,
      policy,
      vendorBaseline: {},
    });
    expect(manifest.executables[0].beforeSHA256).toBe(manifest.executables[0].afterSHA256);
    await verifyLocalIntegrity({ appDirectory: app, manifestPath, inspect, runtimeCheck, policy });
    await writeJson(manifestPath, { ...manifest, executables: [] });
    await expect(
      verifyLocalIntegrity({ appDirectory: app, manifestPath, inspect, runtimeCheck, policy }),
    ).rejects.toThrow('INCOMPLETE');
    await writeJson(manifestPath, manifest);
    await fs.appendFile(exe, 'damage');
    await expect(
      verifyLocalIntegrity({ appDirectory: app, manifestPath, inspect, runtimeCheck, policy }),
    ).rejects.toThrow('HASH_MISMATCH');
  });
  it.each([
    [0, 'OFF'],
    [1, 'ON'],
    [2, 'UNKNOWN'],
  ])('only reads SAC value %s', async (value, state) => {
    const runner = vi.fn(async () => ({ code: 0, stdout: JSON.stringify({ value }) }));
    expect((await readSmartAppControl({ runner })).state).toBe(state);
    const args = runner.mock.calls[0][1].join(' ');
    expect(args).toContain('Get-ItemProperty');
    expect(args).not.toMatch(
      /Set-|Remove-|Disable-|New-|reg\.exe|netsh|Defender|SmartScreen|Firewall/i,
    );
  });
  it('unknown SAC state does not become OFF', async () => {
    expect((await readSmartAppControl({ runner: async () => ({ code: 1 }) })).state).toBe(
      'UNKNOWN',
    );
    expect(localLaunchDecision({ state: 'UNKNOWN' }, true).launch).toBe(true);
  });
  it.each(['ON', 'OFF'])('routes %s verification without changing policy', async (state) => {
    const dir = await fixture(path.join(localRoot, 'builds'));
    await fs.mkdir(path.join(dir, 'win-unpacked'));
    await fs.writeFile(path.join(dir, 'win-unpacked', rule.path), peBytes());
    await writeJson(path.join(dir, 'build-report.json'), { build: 'PASS' });
    const runtime = vi.fn(async () => ({
      applicationLaunch: 'PASS',
      exportVerification: 'PASS',
      restartVerification: 'PASS',
    }));
    const result = await verifyLocalRelease({
      buildDirectory: dir,
      integrity: async () => ({
        executables: [{ path: rule.path, signature: { status: 'NotSigned' } }],
      }),
      readSAC: async () => ({ state, readOnly: true }),
      runtime,
      preserve,
    });
    expect(result.build).toBe('PASS');
    expect(result.policyChanged).toBe(false);
    expect(result.beforeSHA256).toBe(result.afterSHA256);
    expect(runtime).toHaveBeenCalledTimes(state === 'ON' ? 0 : 1);
    expect(result.applicationLaunch).toBe(state === 'ON' ? 'BLOCKED_BY_SAC' : 'PASS');
    if (state === 'ON') {
      expect(result.errorCode).toBe(4551);
      expect(result.exportVerification).toBe('NOT_RUN');
      expect(result.launchAttempted).toBe(false);
    }
  });
  it('production files/artifacts and signing:release retain their baseline', async () => {
    expect((await assertProductionPreserved()).passed).toBe(true);
  });
  it('existing production credential gate still stops without running build/signing', async () => {
    const result = await runLocalTool(process.execPath, ['scripts/signing-release.mjs'], {
      env: localEnvironment({ SystemRoot: process.env.SystemRoot }),
      timeoutMs: 15000,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Production release stopped');
  }, 20000);
  it('rejects a skipped original production test', async () => {
    const baseline = { productionTests: [{ path: 'tests/example.mjs', passed: 1 }] };
    expect(() =>
      checkBaselineTests(
        {
          success: true,
          testResults: [{ name: '/tests/example.mjs', assertionResults: [{ status: 'pending' }] }],
        },
        baseline,
      ),
    ).toThrow('PRODUCTION_TEST_REGRESSION');
  });
  it('build orchestration succeeds without credentials/provider and runs no installer', async () => {
    const latest = path.join(localRoot, 'latest.json'),
      previous = await fs.readFile(latest).catch(() => null);
    let dir;
    const baseline = JSON.parse(
      await fs.readFile(path.join(projectDir, 'scripts/production-baseline.local.json'), 'utf8'),
    );
    const calls = [];
    const runner = async (file, args, options) => {
      calls.push(args);
      expect(options.env.AZURE_CLIENT_SECRET).toBeUndefined();
      expect(options.env.CSC_IDENTITY_AUTO_DISCOVERY).toBe('false');
      dir = options.env.STUDIO_LOCAL_BUILD_DIR;
      const output = args.find((a) => a.startsWith('--outputFile='));
      if (output)
        await writeJson(output.slice(13), {
          success: true,
          numPassedTests: output.endsWith('ui-tests.json') ? 1 : 122,
          numFailedTests: 0,
          numPendingTests: 0,
          testResults: baseline.productionTests.map((t) => ({
            name: path.join(projectDir, t.path),
            assertionResults: Array.from({ length: t.passed }, () => ({ status: 'passed' })),
          })),
        });
      return { code: 0, stdout: 'mock tool', stderr: '' };
    };
    try {
      const report = await buildLocalRelease({
        runner,
        inventory: async () => ({ integrity: 'PASS' }),
        preserve,
        envSource: {},
      });
      expect(report.build).toBe('PASS');
      expect(report.signingProviderCalled).toBe(false);
      expect(report.tests.existingTests).toBe(122);
      expect(report.tests.totalPassed).toBe(123);
      const testStep = calls.findIndex((a) => a.includes('--exclude'));
      const uiBuild = calls.findIndex((a) => a.includes('node_modules/vite/bin/vite.js'));
      const uiAcceptance = calls.findIndex((a) => a.some((s) => s.endsWith('ui-tests.json')));
      expect(testStep).toBeLessThan(uiBuild);
      expect(uiBuild).toBeLessThan(uiAcceptance);
      expect(calls.at(-1)).toContain('--dir');
      expect(calls.flat().join(' ')).not.toMatch(
        /signing-release|signing-config|nsis|signing-providers/,
      );
    } finally {
      if (dir) temporary.push(dir);
      if (previous) await fs.writeFile(latest, previous);
      else await fs.rm(latest, { force: true });
    }
  });
  it('runtime integration exercises nine outputs and same-EXE restart/history using mocked app', async () => {
    const root = await fixture(),
      exe = path.join(root, 'app.exe');
    await fs.writeFile(exe, peBytes());
    let saved, format;
    const launch = vi.fn(async () => ({
      ready: { url: 'http://127.0.0.1:1' },
      close: async () => 0,
    }));
    const request = async (_origin, route, method, body) => {
      if (route === '/health') return { ok: true };
      if (route === '/projects' && method === 'POST')
        return { id: 'p', revision: 1, motion: { scenes: [{}] } };
      if (method === 'PUT') {
        saved = { ...body.project, revision: 2 };
        return saved;
      }
      if (route === '/projects/p') return saved;
      if (route.startsWith('/jobs?')) return localFormats.map(() => ({ status: 'completed' }));
      if (route === '/projects/p/export') {
        format = body.format;
        let name = format + '.json',
          bytes = Buffer.from('{}');
        if (format === 'pptx') {
          const zip = new JSZip();
          zip.file('ppt/presentation.xml', '<p:sldSz cx="12192000" cy="6858000"/>');
          bytes = await zip.generateAsync({ type: 'nodebuffer' });
          name = 'slides.pptx';
        }
        const file = path.join(root, name);
        await fs.writeFile(file, bytes);
        return { status: 'completed', files: [{ name, path: file }] };
      }
      throw Error('Unexpected request');
    };
    const report = await verifyLocalRuntime({ exe, root, launch, request });
    expect(report.exportVerification).toBe('PASS');
    expect(report.restartVerification).toBe('PASS');
    expect(launch).toHaveBeenCalledTimes(2);
    expect(report.results.filter((r) => r.check === 'export')).toHaveLength(9);
    expect(report.beforeSHA256).toBe(report.afterSHA256);
  });
});
