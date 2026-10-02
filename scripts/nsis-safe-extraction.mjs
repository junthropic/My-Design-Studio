// electron-builder 26.15.3 adaptation: replace only the Windows NSIS bootstrap
// execution with the upstream in-process UninstallerReader. No EXE is launched.
import { readFile, lstat, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const marker = Symbol.for('design-studio.safe-nsis-extraction.v1');
const expectedVersion = '26.15.3';
export const NSIS_SOURCE_GUARD = Object.freeze({
  version: expectedVersion,
  target: '43a6cb5c64b0f0f889bc9dd9d66fa351e5294cd6a7baedfa834c0067fd123372',
  extractor: 'fca86cb65c9a9e63744204379cad053ad14b774bff4f33eafec797227dd0dbf1',
  method: 'bb5480b7a25770ccbaf2d0481b3b294cb9e4564f19569d8f5d506543ac6890e5',
});
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (message) => {
  throw new Error(`NSIS 안전 추출 실패: ${message}`);
};

async function assertPortableExecutable(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 64)
    fail('추출 결과가 실제 PE 파일이 아닙니다.');
  const handle = await open(file, 'r');
  try {
    const header = Buffer.alloc(64);
    await handle.read(header, 0, header.length, 0);
    const peOffset = header.readUInt32LE(60);
    if (header.readUInt16LE(0) !== 0x5a4d || peOffset < 64 || peOffset + 4 > info.size)
      fail('추출 결과의 DOS/PE 헤더가 올바르지 않습니다.');
    const signature = Buffer.alloc(4);
    await handle.read(signature, 0, 4, peOffset);
    if (signature.readUInt32LE(0) !== 0x4550) fail('추출 결과의 PE 서명이 올바르지 않습니다.');
  } finally {
    await handle.close();
  }
}

/** Dependency-injected for tests; normal installation supplies only upstream IO/extractor. */
export function createSafeNsisMethod({
  templatesDir,
  extract,
  beforeInstallerBuild,
  readText = (file) => readFile(file, 'utf8'),
  assertExtracted = assertPortableExecutable,
}) {
  if (typeof extract !== 'function' || !templatesDir || typeof beforeInstallerBuild !== 'function')
    fail('공식 추출기·템플릿·내부 파일 검증 장벽이 필요합니다.');
  return async function computeScriptAndSignUninstaller(
    defines,
    commands,
    installerPath,
    sharedHeader,
    archs,
  ) {
    const packager = this.packager;
    // The default resource lookup also finds build/installer.nsi. Reject that implicit
    // customization as well: its output format and uninstaller semantics are unknown.
    const customScriptPath = await packager.getResource(this.options.script, 'installer.nsi');
    if (customScriptPath != null) fail('사용자 정의 installer.nsi는 지원하지 않습니다.');
    if (
      !Array.isArray(archs) ||
      archs.length !== 1 ||
      !(this.archs instanceof Map) ||
      this.archs.size !== 1 ||
      !this.archs.has(archs[0])
    )
      fail('검증된 단일 아키텍처 NSIS 빌드만 지원합니다.');
    const outputDir = path.resolve(this.outDir);
    const installer = path.resolve(installerPath);
    if (
      path.dirname(installer).toLowerCase() !== outputDir.toLowerCase() ||
      !/\.exe$/i.test(installer)
    )
      fail('설치 파일은 지정된 출력 폴더의 EXE여야 합니다.');
    // packArch has already copied/signed elevate.exe by this point. Seal/audit the
    // complete internal set before either uninstaller or final installer compilation.
    await beforeInstallerBuild({
      target: this,
      appOutDir: this.archs.get(archs[0]),
      archs: [...archs],
    });
    const script = await readText(path.join(templatesDir, 'installer.nsi'));
    // Keep the exact upstream filename, including its dot before __uninstaller.
    const uninstallerPath = path.join(
      outputDir,
      `${path.basename(installer, 'exe')}__uninstaller.exe`,
    );
    defines.BUILD_UNINSTALLER = null;
    defines.UNINSTALLER_OUT_FILE = uninstallerPath;
    await this.executeMakensis(
      defines,
      commands,
      sharedHeader + (await this.computeFinalScript(script, false, archs)),
    );
    try {
      await extract(installer, uninstallerPath);
      await assertExtracted(uninstallerPath);
    } catch {
      // Never fall back to executing the unsigned temporary installer.
      fail(
        '공식 바이트 추출기가 제거 프로그램을 추출하지 못했습니다. 임시 EXE는 실행하지 않았습니다.',
      );
    }
    if ((await packager.signIf(uninstallerPath)) !== true)
      fail('제거 프로그램 서명이 확인되지 않았습니다.');
    delete defines.BUILD_UNINSTALLER;
    defines.UNINSTALLER_OUT_FILE = uninstallerPath;
    return { script, isCustomScript: false };
  };
}

/** Installs one process-local prototype adapter; never edits node_modules on disk. */
export async function installSafeNsisExtraction({
  platform = process.platform,
  beforeInstallerBuild,
} = {}) {
  if (platform !== 'win32') fail('이 어댑터는 Windows NSIS 빌드만 지원합니다.');
  if (typeof beforeInstallerBuild !== 'function')
    fail('설치 프로그램 빌드 전 내부 파일 검증 장벽이 필요합니다.');
  const libraryDir = path.dirname(require.resolve('app-builder-lib/package.json'));
  const metadata = JSON.parse(await readFile(path.join(libraryDir, 'package.json'), 'utf8'));
  const targetPath = path.join(libraryDir, 'out/targets/nsis/NsisTarget.js');
  const extractorPath = path.join(libraryDir, 'out/targets/nsis/nsisUtil.js');
  if (metadata.version !== expectedVersion) fail('electron-builder 26.15.3만 검증되었습니다.');
  const [targetSource, extractorSource] = await Promise.all([
    readFile(targetPath),
    readFile(extractorPath),
  ]);
  if (
    hash(targetSource) !== NSIS_SOURCE_GUARD.target ||
    hash(extractorSource) !== NSIS_SOURCE_GUARD.extractor
  )
    fail('NSIS 구현 소스가 검증된 26.15.3 파일과 다릅니다.');
  // Initialize the library entry first to avoid its CommonJS circular import order.
  require('app-builder-lib');
  const { NsisTarget } = require(targetPath);
  const { UninstallerReader, nsisTemplatesDir } = require(extractorPath);
  const current = NsisTarget.prototype.computeScriptAndSignUninstaller;
  if (current?.[marker] && current[marker] !== beforeInstallerBuild)
    fail('다른 내부 파일 검증 장벽이 이미 설치되어 있습니다. 새 빌드 프로세스에서 시작하세요.');
  if (current?.[marker])
    return { installed: true, version: expectedVersion, strategy: 'in-process-extraction' };
  if (typeof current !== 'function' || hash(current.toString()) !== NSIS_SOURCE_GUARD.method)
    fail('NSIS 메서드가 이미 변경되어 안전하게 통합할 수 없습니다.');
  const replacement = createSafeNsisMethod({
    templatesDir: nsisTemplatesDir,
    extract: UninstallerReader.exec.bind(UninstallerReader),
    beforeInstallerBuild,
  });
  Object.defineProperty(replacement, marker, { value: beforeInstallerBuild });
  NsisTarget.prototype.computeScriptAndSignUninstaller = replacement;
  return { installed: true, version: expectedVersion, strategy: 'in-process-extraction' };
}
