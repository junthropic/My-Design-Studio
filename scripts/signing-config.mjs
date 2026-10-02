import { execFile, spawn } from 'node:child_process';
import { access, lstat, readdir, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nativeExtensions = new Set(['.exe', '.dll', '.node']);
const required = (env, key) => {
  if (typeof env[key] !== 'string' || !env[key].trim())
    throw new Error(
      `서명 준비 실패: ${key} 환경변수가 필요합니다. 비밀값은 파일이나 명령 인수에 쓰지 마세요.`,
    );
  return env[key].trim();
};
const present = (env, key) => typeof env[key] === 'string' && !!env[key].trim();
const credentialKeys = ['WIN_CSC_LINK', 'CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'CSC_KEY_PASSWORD'];
const azureKeys = ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET'];
const fail = (message) => {
  throw new Error(`서명 준비 실패: ${message}`);
};

/** Do not alter the parent shell. Windows PowerShell rebuilds its own module path. */
export function signingChildEnvironment(env = process.env) {
  const childEnv = { ...env };
  for (const key of Object.keys(childEnv))
    if (key.toLowerCase() === 'psmodulepath') delete childEnv[key];
  return childEnv;
}

async function readableFile(file) {
  try {
    await access(file, constants.R_OK);
    return (await lstat(file)).isFile();
  } catch {
    return false;
  }
}

// Read-only certificate-store inspection. The selector is public certificate metadata,
// passed through the child environment; no password or private key is read or printed.
async function storeCertificateAvailable(thumbprint) {
  const source = `$ErrorActionPreference='Stop'; $wanted=$env:STUDIO_CHECK_THUMBPRINT; $now=Get-Date; $found=@(Get-ChildItem -Path Cert:/CurrentUser/My,Cert:/LocalMachine/My -CodeSigningCert | Where-Object { $_.Thumbprint -eq $wanted -and $_.HasPrivateKey -and $_.NotBefore -le $now -and $_.NotAfter -gt $now }); if ($found.Count -eq 1) { 'true' } else { 'false' }`;
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(source, 'utf16le').toString('base64'),
      ],
      {
        windowsHide: true,
        shell: false,
        timeout: 15000,
        maxBuffer: 4096,
        env: { ...signingChildEnvironment(), STUDIO_CHECK_THUMBPRINT: thumbprint },
      },
    );
    return stdout.trim() === 'true';
  } catch {
    fail('Windows 인증서 저장소를 읽지 못했습니다. 저장소/개인 키 접근 권한을 확인하세요.');
  }
}

/** Presence/shape checks only: never signs, installs modules, packages, or launches the app. */
export async function preflightSigning({
  env = process.env,
  platform = process.platform,
  fileReadable = readableFile,
  hasStoreCertificate = storeCertificateAvailable,
} = {}) {
  const mode = required(env, 'STUDIO_SIGNING_MODE');
  if (!['pfx', 'store', 'azure'].includes(mode))
    fail('STUDIO_SIGNING_MODE은 pfx, store, azure 중 하나여야 합니다.');
  if (platform !== 'win32') fail('이 정식 서명 준비 구성은 Windows 빌드만 지원합니다.');
  // Builder debug traces can include tool arguments. Require normal logging for signing.
  if (present(env, 'DEBUG') || present(env, 'DEBUG_DMG') || env.ELECTRON_BUILDER_OFFLINE === 'true')
    fail('서명할 때 DEBUG 설정과 ELECTRON_BUILDER_OFFLINE=true를 해제해야 합니다.');
  if (mode === 'azure') {
    if (credentialKeys.some((key) => present(env, key)) || present(env, 'STUDIO_CERTIFICATE_SHA1'))
      fail('Azure와 파일/인증서 저장소 자격 설정을 동시에 사용할 수 없습니다.');
    const publisherName = required(env, 'STUDIO_SIGNING_PUBLISHER');
    const endpoint = required(env, 'STUDIO_AZURE_ENDPOINT');
    let address;
    try {
      address = new URL(endpoint);
    } catch {
      fail('STUDIO_AZURE_ENDPOINT가 올바른 Azure 서명 주소가 아닙니다.');
    }
    if (
      address.protocol !== 'https:' ||
      !/^[a-z0-9-]+\.codesigning\.azure\.net$/i.test(address.hostname) ||
      address.username ||
      address.password ||
      address.search ||
      address.hash ||
      address.port ||
      !['', '/'].includes(address.pathname)
    )
      fail('STUDIO_AZURE_ENDPOINT는 https://<region>.codesigning.azure.net 주소여야 합니다.');
    const codeSigningAccountName = required(env, 'STUDIO_AZURE_ACCOUNT');
    const certificateProfileName = required(env, 'STUDIO_AZURE_PROFILE');
    for (const key of ['STUDIO_AZURE_ACCOUNT', 'STUDIO_AZURE_PROFILE'])
      if (!/^[A-Za-z][A-Za-z0-9-]{2,99}$/.test(env[key]))
        fail(`${key} 이름 형식이 올바르지 않습니다.`);
    for (const key of ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID'])
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(required(env, key)))
        fail(`${key}는 UUID 형식이어야 합니다.`);
    required(env, 'AZURE_CLIENT_SECRET');
    return {
      mode,
      azureSignOptions: {
        publisherName,
        endpoint: address.origin,
        codeSigningAccountName,
        certificateProfileName,
        fileDigest: 'SHA256',
        timestampDigest: 'SHA256',
        timestampRfc3161: 'http://timestamp.acs.microsoft.com',
      },
    };
  }
  if (azureKeys.some((key) => present(env, key)))
    fail('파일/인증서 저장소 모드에는 Azure 자격 설정을 함께 넣지 마세요.');
  const signtoolOptions = {
    signingHashAlgorithms: ['sha256'],
    rfc3161TimeStampServer: 'http://timestamp.digicert.com',
  };
  if (mode === 'pfx') {
    if (present(env, 'STUDIO_CERTIFICATE_SHA1'))
      fail('PFX와 인증서 저장소 선택을 동시에 사용할 수 없습니다.');
    const certificatePath = required(env, 'WIN_CSC_LINK');
    required(env, 'WIN_CSC_KEY_PASSWORD');
    if (
      !path.win32.isAbsolute(certificatePath) ||
      !/\.(pfx|p12)$/i.test(certificatePath) ||
      /[\r\n]/.test(certificatePath)
    )
      fail(
        'WIN_CSC_LINK는 읽을 수 있는 로컬 PFX/P12의 절대 경로여야 합니다. URL·base64 입력은 지원하지 않습니다.',
      );
    if (!(await fileReadable(certificatePath)))
      fail('WIN_CSC_LINK 인증서 파일을 읽을 수 없습니다.');
    // Builder reads the PFX location/password from WIN_CSC_*; never put either in config.
  } else {
    if (credentialKeys.some((key) => present(env, key)))
      fail('저장소 모드에는 PFX 자격 설정을 함께 넣지 마세요.');
    const thumbprint = required(env, 'STUDIO_CERTIFICATE_SHA1').replace(/\s/g, '').toUpperCase();
    if (!/^[0-9A-F]{40}$/.test(thumbprint))
      fail('STUDIO_CERTIFICATE_SHA1은 인증서의 40자리 SHA1 지문이어야 합니다.');
    if (!(await hasStoreCertificate(thumbprint)))
      fail(
        '지문과 일치하는 유효한 Code Signing 인증서 및 개인 키를 Windows My 저장소에서 찾지 못했습니다.',
      );
    signtoolOptions.certificateSha1 = thumbprint;
  }
  return { mode, signtoolOptions };
}

/** Enumerates everything shipped, including nested extraResources and native modules. */
export async function collectNativeFiles(root) {
  const absolute = path.resolve(root),
    files = [];
  const visit = async (directory) => {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isSymbolicLink())
        fail('서명 검증 폴더에 심볼릭 링크가 있습니다. 실제 파일을 패키징하세요.');
      if (item.isDirectory()) await visit(file);
      else if (item.isFile() && nativeExtensions.has(path.extname(item.name).toLowerCase()))
        files.push(file);
    }
  };
  const stat = await lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    fail('서명 검증 루트는 실제 디렉터리여야 합니다.');
  await visit(absolute);
  return files.sort();
}

async function verifySignatures(paths) {
  const { verifyWindowsSignatures } = await import('./windows-verification.mjs');
  return verifyWindowsSignatures(paths);
}

/** Creates a v26 configuration; loading it performs preflight before packaging starts. */
export async function createSigningConfig({
  baseConfig,
  env = process.env,
  platform = process.platform,
  fileReadable,
  hasStoreCertificate,
  verify = verifySignatures,
  collect = collectNativeFiles,
} = {}) {
  const selected = await preflightSigning({ env, platform, fileReadable, hasStoreCertificate });
  if (!baseConfig || typeof baseConfig !== 'object') fail('package.json의 build 구성이 없습니다.');
  if (
    baseConfig.beforePack ||
    baseConfig.afterSign ||
    baseConfig.artifactBuildCompleted ||
    baseConfig.afterAllArtifactBuild
  )
    fail('기존 빌드 훅이 있습니다. 서명 검증 훅과 명시적으로 통합해야 합니다.');
  if (baseConfig.win?.signtoolOptions || baseConfig.win?.azureSignOptions || baseConfig.win?.sign)
    fail('일반 build 구성에 별도 서명 설정을 넣지 마세요. 전용 환경 설정을 사용하세요.');
  const config = structuredClone(baseConfig);
  config.forceCodeSigning = true;
  config.directories = { ...config.directories, output: 'release-signed' };
  config.win = {
    ...config.win,
    target: [{ target: 'nsis', arch: ['x64'] }],
    signAndEditExecutable: true,
    signExecutable: true,
    verifyUpdateCodeSignature: true,
    signExts: ['.exe', '.dll', '.node'],
    // Every production provider uses our per-file preservation/verification broker.
    // Built-in Azure signing would bypass this hook and may install modules implicitly.
    signtoolOptions: {
      signingHashAlgorithms: ['sha256'],
      publisherName: env.STUDIO_SIGNING_PUBLISHER || 'Design Studio',
      sign: async () => fail('Production signing session is not initialized.'),
    },
  };
  config.beforePack = async (context) => {
    const effective = context.packager.config;
    if (
      context.electronPlatformName !== 'win32' ||
      effective.forceCodeSigning !== true ||
      effective.win?.signExecutable !== true ||
      effective.win?.signAndEditExecutable !== true ||
      !['.exe', '.dll', '.node'].every((ext) => effective.win?.signExts?.includes(ext))
    )
      fail('서명 필수 설정이 변경되었습니다. 서명 비활성화 또는 누락 상태로 빌드할 수 없습니다.');
    await preflightSigning({ env, platform, fileReadable, hasStoreCertificate });
  };
  config.afterSign = async (context) => {
    const files = await collect(context.appOutDir);
    if (!files.length) fail('최종 앱 폴더에 검증할 실행 파일이 없습니다.');
    await verify(files);
  };
  config.artifactBuildCompleted = async (event) => {
    if (typeof event.file === 'string' && /\.(exe|msi|msix|appx)$/i.test(event.file))
      await verify([path.resolve(event.file)]);
  };
  return config;
}

export default async function signedBuildConfig() {
  // Do not import electron-builder here: --check must never initialize signers/modules.
  const metadata = JSON.parse(await readFile(path.join(projectDir, 'package.json'), 'utf8'));
  const builder = JSON.parse(
    await readFile(path.join(projectDir, 'node_modules/electron-builder/package.json'), 'utf8'),
  );
  if (builder.version !== '26.15.3')
    fail(
      '검증된 electron-builder 26.15.3 버전이 필요합니다. 다른 버전의 서명 스키마를 먼저 검토하세요.',
    );
  const config = await createSigningConfig({ baseConfig: metadata.build });
  const { configureProductionBuild } = await import('./signing-build.mjs');
  return configureProductionBuild({ config, metadata, projectDir });
}

async function locateNpmCli(env, executable, fileReadable) {
  const candidates = [
    env.npm_execpath,
    path.join(path.dirname(executable), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of candidates)
    if (
      typeof candidate === 'string' &&
      path.basename(candidate).toLowerCase() === 'npm-cli.js' &&
      (await fileReadable(candidate))
    )
      return candidate;
  fail('npm-cli.js를 찾지 못했습니다. npm run package:win:signed로 실행하세요.');
}

async function runHidden(executable, args, options) {
  await new Promise((resolve, reject) => {
    // Child output is deliberately not copied into logs: third-party tools may echo
    // credentials in their error text. Only the stage and exit code are reported.
    const child = spawn(executable, args, { ...options, stdio: 'ignore' });
    child.once('error', () => reject(new Error('서명 빌드 자식 프로세스를 시작하지 못했습니다.')));
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`자식 프로세스가 실패했습니다 (종료 코드 ${code ?? signal ?? 'unknown'}).`),
        );
    });
  });
}

/** Explicit, side-effecting entry point. Tests inject all runners; --check never calls it. */
export async function packageSigned({
  env = process.env,
  executable = process.execPath,
  cwd = projectDir,
  check = signedBuildConfig,
  fileReadable = readableFile,
  run = runHidden,
  progress = (message) => console.log(message),
} = {}) {
  await check(); // Missing credentials must fail before running npm or creating output.
  const npmCli = await locateNpmCli(env, executable, fileReadable);
  const builderCli = path.join(cwd, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
  const tsxCli = path.join(cwd, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (!(await fileReadable(builderCli)) || !(await fileReadable(tsxCli)))
    fail('로컬 electron-builder 또는 tsx 실행 파일이 없습니다.');
  const options = {
    cwd,
    env: signingChildEnvironment(env),
    windowsHide: true,
    shell: false,
  };
  options.env.NODE_OPTIONS = `--require=${JSON.stringify(path.join(cwd, 'scripts', 'hidden-build.cjs'))}`;
  const stages = [
    ['앱 빌드', [npmCli, 'run', 'build']],
    ['모션 렌더러 준비', [tsxCli, 'src/motion/build.ts', '--browser']],
    [
      '정식 Windows 서명 및 패키징',
      [builderCli, '--win', 'nsis', '--config', 'scripts/signing-config.mjs', '--publish', 'never'],
    ],
  ];
  for (const [label, args] of stages) {
    progress(`${label} 시작 (자식 도구 출력은 비밀정보 보호를 위해 저장하지 않습니다).`);
    try {
      await run(executable, args, options);
    } catch {
      fail(
        `${label}에 실패했습니다. 다음 단계는 실행하지 않았습니다. 자격·도구 준비·서명 검증 상태를 확인하세요.`,
      );
    }
    progress(`${label} 완료.`);
  }
  progress(
    '서명 필수 검증을 포함한 release-signed 패키징 완료. 앱 실행 및 SAC 허용은 별도 검증이 필요합니다.',
  );
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 3 || !['--check', '--package'].includes(process.argv[2])) {
    console.error('사용법: node scripts/signing-config.mjs --check | --package');
    process.exitCode = 2;
  } else {
    try {
      if (process.argv[2] === '--package') await packageSigned();
      else {
        await signedBuildConfig();
        console.log(
          '서명 설정 사전검사 통과. 실제 서명·공개 신뢰·권한·과금 또는 앱 실행은 검증하지 않았습니다.',
        );
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : '서명 설정 사전검사 실패');
      process.exitCode = 1;
    }
  }
}
