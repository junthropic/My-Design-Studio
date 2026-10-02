import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  createSafeNsisMethod,
  installSafeNsisExtraction,
} from '../scripts/nsis-safe-extraction.mjs';

function fixture({ custom = null, extractError = false, signError = false } = {}) {
  const calls = [];
  const outDir = path.resolve('work/nsis-mock-output');
  const method = createSafeNsisMethod({
    templatesDir: path.resolve('templates'),
    beforeInstallerBuild: async (context) => {
      calls.push(['barrier', context.appOutDir]);
    },
    readText: async () => 'official template',
    extract: async (from, to) => {
      calls.push(['extract', from, to]);
      if (extractError) throw new Error('parse failure');
    },
    assertExtracted: async (file) => {
      calls.push(['assert', file]);
    },
  });
  const target = {
    outDir,
    options: {},
    archs: new Map([[1, path.join(outDir, 'win-unpacked')]]),
    packager: {
      getResource: async () => custom,
      signIf: async (file) => {
        calls.push(['sign', file]);
        if (signError) throw new Error('sign failure');
        return true;
      },
    },
    computeFinalScript: async (script, installer, archs) => {
      calls.push(['script', script, installer, archs]);
      return 'compiled script';
    },
    executeMakensis: async (defines, commands, script) => {
      calls.push(['compile', structuredClone(defines), commands, script]);
    },
  };
  return { calls, target, method, installer: path.join(outDir, 'Design Studio Setup 0.1.0.exe') };
}

test('NSIS bootstrap is compiled, extracted as bytes, validated, and signed in order', async () => {
  const f = fixture();
  const defines = { VERSION: '0.1.0' };
  const result = await f.method.call(
    f.target,
    defines,
    { OutFile: f.installer },
    f.installer,
    'HEADER\n',
    [1],
  );
  assert.deepEqual(
    f.calls.map(([type]) => type),
    ['barrier', 'script', 'compile', 'extract', 'assert', 'sign'],
  );
  assert.equal(f.calls[2][1].BUILD_UNINSTALLER, null);
  assert.equal(f.calls[2][3], 'HEADER\ncompiled script');
  assert.equal(path.basename(f.calls[3][2]), 'Design Studio Setup 0.1.0.__uninstaller.exe');
  assert.equal(Object.hasOwn(defines, 'BUILD_UNINSTALLER'), false);
  assert.equal(defines.UNINSTALLER_OUT_FILE, f.calls[3][2]);
  assert.deepEqual(result, { script: 'official template', isCustomScript: false });
});
test('custom scripts and paths outside output fail before compilation', async () => {
  for (const custom of ['installer.nsi', path.resolve('build/installer.nsi')]) {
    const f = fixture({ custom });
    await assert.rejects(f.method.call(f.target, {}, {}, f.installer, '', [1]), /사용자 정의/);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  await assert.rejects(
    f.method.call(f.target, {}, {}, path.resolve('outside.exe'), '', [1]),
    /출력 폴더/,
  );
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.method.call(f.target, {}, {}, f.installer, '', [1, 3]), /단일 아키텍처/);
});
test('extraction has no process fallback and signing failures propagate', async () => {
  const extraction = fixture({ extractError: true });
  await assert.rejects(
    extraction.method.call(extraction.target, {}, {}, extraction.installer, '', [1]),
    /임시 EXE는 실행하지 않았습니다/,
  );
  assert.deepEqual(
    extraction.calls.map(([type]) => type),
    ['barrier', 'script', 'compile', 'extract'],
  );
  const signing = fixture({ signError: true });
  await assert.rejects(
    signing.method.call(signing.target, {}, {}, signing.installer, '', [1]),
    /sign failure/,
  );
});
test(
  'pinned source adapter installs in memory only, remains idempotent, and has no process runner',
  { timeout: 20000 },
  async () => {
    await assert.rejects(installSafeNsisExtraction({ platform: 'linux' }), /Windows/);
    const beforeInstallerBuild = async () => undefined;
    const first = await installSafeNsisExtraction({ platform: 'win32', beforeInstallerBuild });
    const second = await installSafeNsisExtraction({ platform: 'win32', beforeInstallerBuild });
    assert.deepEqual(first, second);
    assert.equal(first.version, '26.15.3');
    await assert.rejects(
      installSafeNsisExtraction({ platform: 'win32', beforeInstallerBuild: async () => undefined }),
      /다른 내부 파일 검증/,
    );
    const source = await readFile(
      new URL('../scripts/nsis-safe-extraction.mjs', import.meta.url),
      'utf8',
    );
    assert.equal(source.includes('child_process'), false);
    assert.equal(source.includes('WineVmManager'), false);
  },
);
test(
  'real cached NSIS compiler fixture can be extracted without launching generated binaries',
  {
    skip: !process.env.STUDIO_NSIS_FIXTURE_COMPILER,
    timeout: 20000,
  },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'studio-nsis-extract-'));
    try {
      const installer = path.join(directory, 'bootstrap.exe');
      const uninstaller = path.join(directory, 'uninstaller.exe');
      const source = path.join(directory, 'fixture.nsi');
      await writeFile(
        source,
        `\uFEFFUnicode true\nName "Extraction fixture"\nOutFile "${installer}"\nSetCompressor zlib\nSilentInstall silent\nSection\nWriteUninstaller "${uninstaller}"\nSectionEnd\nSection "Uninstall"\nDelete "$INSTDIR\\unused.fixture"\nSectionEnd\n`,
      );
      await promisify(execFile)(
        process.env.STUDIO_NSIS_FIXTURE_COMPILER,
        ['/V2', '/NOCD', source],
        {
          windowsHide: true,
          shell: false,
          timeout: 60000,
        },
      );
      const require = createRequire(import.meta.url);
      require('app-builder-lib');
      const { UninstallerReader } = require('app-builder-lib/out/targets/nsis/nsisUtil.js');
      await UninstallerReader.exec(installer, uninstaller);
      const bytes = await readFile(uninstaller);
      assert.equal(bytes.readUInt16LE(0), 0x5a4d);
      assert.equal(bytes.readUInt32LE(bytes.readUInt32LE(60)), 0x4550);
      assert.ok(bytes.length > 1024);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
