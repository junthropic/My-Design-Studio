import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateConfiguration } from 'app-builder-lib/out/util/config/config';
import { DebugLogger } from 'builder-util';

const modulePath = pathToFileURL(path.resolve('scripts/signing-config.mjs')).href;
const {
  preflightSigning,
  createSigningConfig,
  collectNativeFiles,
  signingChildEnvironment,
  packageSigned,
} = await import(modulePath);
const temporary: string[] = [];
afterEach(async () => {
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});
const baseConfig = {
  appId: 'local.designstudio.app',
  productName: 'Design Studio',
  directories: { output: 'release' },
  files: ['dist/**'],
  win: { target: 'nsis', icon: 'build/icon.ico' },
  extraResources: [{ from: 'vendor/remotion-browser', to: 'remotion-browser' }],
};
const pfxEnv = {
  STUDIO_SIGNING_MODE: 'pfx',
  WIN_CSC_LINK: 'C:\\private\\signing.pfx',
  WIN_CSC_KEY_PASSWORD: 'DO_NOT_LOG_PFX_SECRET',
};
const azureEnv = {
  STUDIO_SIGNING_MODE: 'azure',
  STUDIO_SIGNING_PUBLISHER: 'Example Studio',
  STUDIO_AZURE_ENDPOINT: 'https://krc.codesigning.azure.net',
  STUDIO_AZURE_ACCOUNT: 'sample-account',
  STUDIO_AZURE_PROFILE: 'sample-profile',
  AZURE_TENANT_ID: '11111111-2222-3333-4444-555555555555',
  AZURE_CLIENT_ID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  AZURE_CLIENT_SECRET: 'DO_NOT_LOG_AZURE_SECRET',
};
const mockPlatform = {
  platform: 'win32',
  fileReadable: async () => true,
  hasStoreCertificate: async () => true,
};

describe('정식 Windows 서명 준비 — 실제 서명이나 패키징을 실행하지 않음', () => {
  it('인증 설정이 없으면 파일·인증서 조회 전에 명확히 실패한다', async () => {
    const fileReadable = vi.fn(),
      hasStoreCertificate = vi.fn();
    await expect(
      preflightSigning({ env: {}, platform: 'win32', fileReadable, hasStoreCertificate }),
    ).rejects.toThrow('STUDIO_SIGNING_MODE');
    expect(fileReadable).not.toHaveBeenCalled();
    expect(hasStoreCertificate).not.toHaveBeenCalled();
  });
  it('PFX 모드는 환경변수로만 자격 정보를 전달하고 읽기 가능한 파일을 요구한다', async () => {
    const result = await preflightSigning({ env: pfxEnv, ...mockPlatform });
    expect(result.signtoolOptions.signingHashAlgorithms).toEqual(['sha256']);
    expect(JSON.stringify(result)).not.toContain(pfxEnv.WIN_CSC_KEY_PASSWORD);
    expect(JSON.stringify(result)).not.toContain(pfxEnv.WIN_CSC_LINK);
    await expect(
      preflightSigning({ env: pfxEnv, ...mockPlatform, fileReadable: async () => false }),
    ).rejects.toThrow('인증서 파일');
    await expect(
      preflightSigning({ env: { ...pfxEnv, WIN_CSC_KEY_PASSWORD: '' }, ...mockPlatform }),
    ).rejects.toThrow('WIN_CSC_KEY_PASSWORD');
    for (const value of ['https://example.com/key.pfx', 'c2VjcmV0', 'relative.pfx'])
      await expect(
        preflightSigning({ env: { ...pfxEnv, WIN_CSC_LINK: value }, ...mockPlatform }),
      ).rejects.toThrow('절대 경로');
  });
  it('저장소 모드는 지문·유효 Code Signing 인증서·개인 키 존재를 검사한다', async () => {
    const thumbprint = 'AB'.repeat(20),
      hasStoreCertificate = vi.fn(async () => true);
    const result = await preflightSigning({
      env: { STUDIO_SIGNING_MODE: 'store', STUDIO_CERTIFICATE_SHA1: thumbprint },
      ...mockPlatform,
      hasStoreCertificate,
    });
    expect(result.signtoolOptions.certificateSha1).toBe(thumbprint);
    expect(hasStoreCertificate).toHaveBeenCalledWith(thumbprint);
    await expect(
      preflightSigning({
        env: { STUDIO_SIGNING_MODE: 'store', STUDIO_CERTIFICATE_SHA1: thumbprint },
        ...mockPlatform,
        hasStoreCertificate: async () => false,
      }),
    ).rejects.toThrow('개인 키');
    await expect(
      preflightSigning({
        env: {
          STUDIO_SIGNING_MODE: 'store',
          STUDIO_CERTIFICATE_SHA1: 'invalid-secret-looking-value',
        },
        ...mockPlatform,
      }),
    ).rejects.toThrow('40자리');
  });
  it('Azure v26 메타데이터를 생성하지만 Azure 비밀은 구성·오류에 포함하지 않는다', async () => {
    const result = await preflightSigning({ env: azureEnv, ...mockPlatform });
    expect(result.azureSignOptions).toMatchObject({
      publisherName: 'Example Studio',
      fileDigest: 'SHA256',
      timestampDigest: 'SHA256',
      endpoint: azureEnv.STUDIO_AZURE_ENDPOINT,
    });
    expect(JSON.stringify(result)).not.toContain(azureEnv.AZURE_CLIENT_SECRET);
    expect(JSON.stringify(result)).not.toContain(azureEnv.AZURE_TENANT_ID);
    await expect(
      preflightSigning({ env: { ...azureEnv, AZURE_CLIENT_SECRET: '' }, ...mockPlatform }),
    ).rejects.toThrow('AZURE_CLIENT_SECRET');
    await expect(
      preflightSigning({ env: { ...azureEnv, STUDIO_AZURE_PROFILE: '' }, ...mockPlatform }),
    ).rejects.toThrow('STUDIO_AZURE_PROFILE');
    await expect(
      preflightSigning({
        env: {
          ...azureEnv,
          STUDIO_AZURE_ENDPOINT: 'https://krc.codesigning.azure.net.evil.invalid?secret=PRIVATE',
        },
        ...mockPlatform,
      }),
    ).rejects.toThrow(/^서명 준비 실패: STUDIO_AZURE_ENDPOINT는/);
  });
  it('혼합 자격 설정·지원하지 않는 플랫폼·민감 로그 모드는 거부한다', async () => {
    await expect(
      preflightSigning({ env: { ...azureEnv, WIN_CSC_LINK: 'SECRET' }, ...mockPlatform }),
    ).rejects.toThrow('동시에');
    await expect(
      preflightSigning({ env: { ...pfxEnv, AZURE_CLIENT_SECRET: 'SECRET' }, ...mockPlatform }),
    ).rejects.toThrow('함께');
    await expect(
      preflightSigning({ env: pfxEnv, ...mockPlatform, platform: 'linux' }),
    ).rejects.toThrow('Windows');
    await expect(
      preflightSigning({ env: { ...pfxEnv, DEBUG: '*' }, ...mockPlatform }),
    ).rejects.toThrow('DEBUG');
    await expect(
      preflightSigning({ env: { ...pfxEnv, ELECTRON_BUILDER_OFFLINE: 'true' }, ...mockPlatform }),
    ).rejects.toThrow('OFFLINE');
  });
  it.each([pfxEnv, azureEnv])(
    'v26.15.3 스키마에 맞으며 signed 폴더·필수 서명·모든 네이티브 확장자를 설정한다',
    async (env) => {
      const config = await createSigningConfig({ env, baseConfig, ...mockPlatform });
      await expect(validateConfiguration(config, new DebugLogger(false))).resolves.toBeUndefined();
      expect(config.forceCodeSigning).toBe(true);
      expect(config.directories.output).toBe('release-signed');
      expect(baseConfig.directories.output).toBe('release');
      expect(config.win.signExecutable).toBe(true);
      expect(config.win.signAndEditExecutable).toBe(true);
      expect(config.win.signExts).toEqual(['.exe', '.dll', '.node']);
      expect(config.extraResources).toEqual(baseConfig.extraResources);
      const json = JSON.stringify(config);
      expect(json).not.toContain('DO_NOT_LOG');
      expect(json).not.toContain('certificatePassword');
    },
  );
  it('extraResources·렌더러·대소문자 DLL·node의 전체 경로를 재귀 수집한다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'studio-signing-'));
    temporary.push(dir);
    for (const name of [
      'Design Studio.exe',
      'resources/renderer/chrome.EXE',
      'resources/renderer/GPU.DLL',
      'resources/app.asar.unpacked/native/sharp.node',
      'resources/app.asar',
      'readme.txt',
    ]) {
      const file = path.join(dir, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, 'not executable: fixture only');
    }
    const files = await collectNativeFiles(dir);
    expect(files).toHaveLength(4);
    expect(files.some((file: string) => file.endsWith('GPU.DLL'))).toBe(true);
    expect(files.some((file: string) => file.endsWith('sharp.node'))).toBe(true);
  });
  it('서명 누락은 afterSign에서 배포 생성 전에 실패하고 설치 파일도 검사한다', async () => {
    const nativeFiles = ['C:\\app\\Design Studio.exe', 'C:\\app\\resources\\render.dll'],
      verify = vi.fn(async () => undefined);
    const config = await createSigningConfig({
      env: pfxEnv,
      baseConfig,
      ...mockPlatform,
      collect: async () => nativeFiles,
      verify,
    });
    await config.afterSign({ appOutDir: 'C:\\app' });
    expect(verify).toHaveBeenCalledWith(nativeFiles);
    await config.artifactBuildCompleted({
      file: path.resolve('release-signed/Design Studio Setup.exe'),
    });
    expect(verify).toHaveBeenCalledTimes(2);
    await config.artifactBuildCompleted({ file: 'sample.exe.blockmap' });
    expect(verify).toHaveBeenCalledTimes(2);
    verify.mockRejectedValueOnce(new Error('NotSigned'));
    await expect(config.afterSign({ appOutDir: 'C:\\app' })).rejects.toThrow('NotSigned');
    await expect(
      config.beforePack({
        electronPlatformName: 'win32',
        packager: { config: { ...config, forceCodeSigning: false } },
      }),
    ).rejects.toThrow('서명 필수');
    await expect(
      config.beforePack({ electronPlatformName: 'win32', packager: { config } }),
    ).resolves.toBeUndefined();
  });
  it('체크 CLI는 자격 정보가 없을 때 종료 코드 1이며 비밀·빌드 산출물을 만들지 않는다', async () => {
    const env = {
      SystemRoot: process.env.SystemRoot,
      PATH: process.env.PATH,
      WINDIR: process.env.WINDIR,
    };
    try {
      await promisify(execFile)(process.execPath, ['scripts/signing-config.mjs', '--check'], {
        env,
        windowsHide: true,
        timeout: 15000,
      });
      throw new Error('Expected failure');
    } catch (error: any) {
      expect(error.code).toBe(1);
      expect(error.stderr).toContain('STUDIO_SIGNING_MODE');
      expect(error.stdout).toBe('');
    }
    const source = await readFile(path.resolve('scripts/signing-config.mjs'), 'utf8');
    expect(source).not.toContain('writeFile');
    expect(source).not.toContain('Install-Module');
  });
  it('부모 환경은 보존하며 대소문자가 다른 PSModulePath도 자식 환경에서만 제거한다', () => {
    const env = {
      ...pfxEnv,
      PSModulePath: 'pwsh7-modules',
      PSMODULEPATH: 'duplicate',
      PATH: 'path',
    };
    const result = signingChildEnvironment(env);
    expect(result).toEqual({ ...pfxEnv, PATH: 'path' });
    expect(env.PSModulePath).toBe('pwsh7-modules');
    expect(env.PSMODULEPATH).toBe('duplicate');
  });
  it('패키지 진입점은 사전검사 후 숨김 Node 자식으로 앱·렌더러·서명 순서를 지킨다', async () => {
    const calls: unknown[] = [];
    const check = vi.fn(async () => {
      calls.push('check');
    });
    const run = vi.fn(async (executable, args, options) => {
      calls.push({ executable, args, options });
    });
    const env = {
      ...pfxEnv,
      PSMODULEPATH: 'pwsh7-modules',
      npm_execpath: path.resolve('npm-cli.js'),
    };
    const progress = vi.fn();
    await packageSigned({
      env,
      executable: 'node.exe',
      cwd: path.resolve('.'),
      check,
      fileReadable: async () => true,
      run,
      progress,
    });
    expect(calls[0]).toBe('check');
    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls[0][1]).toEqual([env.npm_execpath, 'run', 'build']);
    expect(run.mock.calls[1][1].slice(1)).toEqual(['src/motion/build.ts', '--browser']);
    expect(run.mock.calls[2][1].slice(1)).toEqual([
      '--win',
      'nsis',
      '--config',
      'scripts/signing-config.mjs',
      '--publish',
      'never',
    ]);
    for (const [executable, , options] of run.mock.calls) {
      expect(executable).toBe('node.exe');
      expect(options.windowsHide).toBe(true);
      expect(options.shell).toBe(false);
      expect(options.env.PSMODULEPATH).toBeUndefined();
      expect(options.env.WIN_CSC_KEY_PASSWORD).toBe(pfxEnv.WIN_CSC_KEY_PASSWORD);
    }
    expect(JSON.stringify(progress.mock.calls)).not.toContain(pfxEnv.WIN_CSC_KEY_PASSWORD);
  });
  it('사전검사 또는 중간 빌드 실패 시 후속 단계가 없고 자식 오류 비밀을 출력하지 않는다', async () => {
    const run = vi.fn();
    await expect(
      packageSigned({
        check: async () => {
          throw new Error('자격 정보 없음');
        },
        run,
      }),
    ).rejects.toThrow('자격 정보 없음');
    expect(run).not.toHaveBeenCalled();
    const progress = vi.fn();
    run.mockRejectedValueOnce(new Error('DO_NOT_LOG_CHILD_SECRET'));
    await expect(
      packageSigned({
        env: { ...pfxEnv, npm_execpath: path.resolve('npm-cli.js') },
        check: async () => undefined,
        fileReadable: async () => true,
        run,
        progress,
      }),
    ).rejects.toThrow(/^서명 준비 실패: 앱 빌드에 실패했습니다/);
    expect(run).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(progress.mock.calls)).not.toContain('DO_NOT_LOG_CHILD_SECRET');
  });
});
