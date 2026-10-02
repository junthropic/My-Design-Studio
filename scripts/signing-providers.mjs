import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Deliberately separate from the backwards-compatible configuration-shape helper.
// No provider installs tools, imports keys, changes trust/policy, or signs in preflight.
// Official interfaces:
// https://learn.microsoft.com/azure/artifact-signing/how-to-signing-integrations
// https://learn.microsoft.com/windows/win32/seccrypto/signtool
const RSA_OID = '1.2.840.113549.1.1.1';
const CODE_SIGNING_OID = '1.3.6.1.5.5.7.3.3';
const TIMESTAMPS = Object.freeze({
  store: 'http://timestamp.digicert.com',
  azure: 'http://timestamp.acs.microsoft.com',
});
const AZURE_REGIONS = new Set([
  'brs',
  'cus',
  'eus',
  'jpe',
  'krc',
  'ncus',
  'neu',
  'plc',
  'scus',
  'swn',
  'wcus',
  'weu',
  'wus',
  'wus2',
  'wus3',
]);
const EXCLUDED_CREDENTIALS = Object.freeze([
  'ManagedIdentityCredential',
  'WorkloadIdentityCredential',
  'SharedTokenCacheCredential',
  'VisualStudioCredential',
  'VisualStudioCodeCredential',
  'AzureCliCredential',
  'AzurePowerShellCredential',
  'AzureDeveloperCliCredential',
  'InteractiveBrowserCredential',
]);
const MESSAGES = Object.freeze({
  PLATFORM: '정식 서명 공급자는 Windows에서만 실행할 수 있습니다.',
  MODE: 'STUDIO_SIGNING_MODE은 store 또는 azure여야 합니다.',
  PFX_UNSAFE:
    '정식 PFX 직접 서명은 지원하지 않습니다. 비밀을 명령 인수에 넣지 않는 Windows 인증서 저장소·보안 토큰 또는 Azure를 사용하세요.',
  CONFIG: '필수 서명 설정이 없거나 형식이 올바르지 않습니다.',
  MIXED_CREDENTIALS: '서로 다른 공급자의 자격 증명 설정을 함께 사용할 수 없습니다.',
  DEBUG_DISABLED: '서명 중 DEBUG·진단 로그와 오프라인 빌드 설정은 허용되지 않습니다.',
  TOOL_PATH: 'STUDIO_SIGNTOOL_PATH에 로컬 SDK SignTool의 절대 경로가 필요합니다.',
  TOOL_TRUST:
    '서명 도구는 유효한 Microsoft Authenticode 서명과 지원되는 버전·아키텍처가 필요합니다.',
  TOOL_CHANGED: '사전 검증 후 서명 도구 파일이 변경되었습니다. 다시 사전 검증하세요.',
  AZURE_DLIB:
    'STUDIO_AZURE_DLIB_PATH에 Microsoft가 서명한 x64 Azure.CodeSigning.Dlib.dll의 절대 경로가 필요합니다.',
  AZURE_RUNTIME: 'Azure 서명에는 x64 .NET 8 런타임과 Visual C++ 2015–2022 x64 런타임이 필요합니다.',
  AZURE_CREDENTIALS:
    'Azure 환경 자격 증명 AZURE_TENANT_ID·AZURE_CLIENT_ID·AZURE_CLIENT_SECRET이 필요합니다.',
  AZURE_ENDPOINT: '지원되는 공식 Azure Artifact Signing 지역 주소가 필요합니다.',
  CERTIFICATE:
    '지정한 저장소에 유효한 RSA 3072비트 이상 코드 서명 인증서와 접근 가능한 개인 키가 필요합니다.',
  PUBLISHER: 'STUDIO_SIGNING_PUBLISHER와 서명 인증서의 게시자 이름이 일치해야 합니다.',
  TARGET: '서명 대상은 읽을 수 있는 로컬 절대 경로의 지원되는 파일이어야 합니다.',
  METADATA: 'Azure 공개 서명 메타데이터를 안전하게 준비하거나 정리하지 못했습니다.',
  SIGN_FAILED:
    '서명 도구가 실패했습니다. 자격 증명·키 접근·서비스 권한·타임스탬프 연결 상태를 확인하세요.',
  VERIFY_FAILED:
    '서명 결과가 RSA·SHA-256·유효한 RFC 3161 타임스탬프·Windows 신뢰 검증을 통과하지 못했습니다.',
  INTERNAL: '서명 공급자 사전 검증에 실패했습니다. 자격 증명을 출력하지 않고 설정을 확인하세요.',
});

/** Never accepts an arbitrary external message, output, evidence, or cause. */
export class SigningProviderError extends Error {
  constructor(code = 'INTERNAL') {
    const safeCode = Object.hasOwn(MESSAGES, code) ? code : 'INTERNAL';
    super(`서명 준비 실패 [${safeCode}]: ${MESSAGES[safeCode]}`);
    this.name = 'SigningProviderError';
    this.code = safeCode;
  }
}
const fail = (code) => {
  throw new SigningProviderError(code);
};
const has = (env, key) => typeof env[key] === 'string' && env[key].trim().length > 0;
const get = (env, key, code = 'CONFIG') => {
  if (!has(env, key) || /[\0\r\n]/.test(env[key])) fail(code);
  return env[key].trim();
};
const safe = async (code, action) => {
  try {
    return await action();
  } catch (error) {
    if (error instanceof SigningProviderError) throw new SigningProviderError(error.code);
    fail(code);
  }
};

function localPath(file, basename) {
  return (
    typeof file === 'string' &&
    /^[A-Za-z]:[\\/]/.test(file) &&
    !/[\0-\x1f<>|"?*]/.test(file) &&
    !file.slice(2).includes(':') &&
    !file.split(/[\\/]/).some((part) => part === '..' || /[. ]$/.test(part)) &&
    (!basename || path.win32.basename(file).toLowerCase() === basename.toLowerCase())
  );
}

async function readableFile(file) {
  const stat = await lstat(file).catch(() => null);
  return !!stat?.isFile() && !stat.isSymbolicLink();
}

/** This explicit allowlist intentionally excludes ambient cloud keys, PSModulePath,
 * NODE_OPTIONS, proxy credentials, and builder debug/CSC settings. */
export function productionChildEnvironment(env = process.env, extra = {}) {
  const result = {};
  for (const key of [
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'ProgramFiles',
    'ProgramFiles(x86)',
    'CommonProgramFiles',
    'CommonProgramFiles(x86)',
  ]) {
    const source = Object.keys(env).find(
      (candidate) => candidate.toLowerCase() === key.toLowerCase(),
    );
    if (source && typeof env[source] === 'string' && !/[\0\r\n]/.test(env[source]))
      result[key] = env[source];
  }
  const windows = result.SystemRoot || result.WINDIR || 'C:\\Windows';
  result.SystemRoot = windows;
  result.WINDIR = windows;
  result.PATH = `${path.win32.join(windows, 'System32')};${windows}`;
  // Callers only pass fixed public selectors or three explicitly selected Azure values.
  return { ...result, ...extra };
}

/** Bounded, hidden, noninteractive runner. SignTool output is discarded entirely. */
export async function runSigningToolHidden(executable, args, options = {}) {
  return new Promise((resolve) => {
    let completed = false;
    let stdout = '';
    let child;
    let timer;
    const finish = (code) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr: '' });
    };
    try {
      child = spawn(executable, args, {
        windowsHide: true,
        shell: false,
        detached: false,
        stdio: ['ignore', options.captureStdout === false ? 'ignore' : 'pipe', 'ignore'],
        env: options.env || {},
      });
      child.stdout?.on('data', (chunk) => {
        if (Buffer.byteLength(stdout) + chunk.length > 262144) {
          child.kill();
          finish(-1);
          return;
        }
        stdout += chunk.toString('utf8');
      });
      child.once('error', () => finish(-1));
      child.once('close', (code) => finish(Number.isInteger(code) ? code : -1));
      timer = setTimeout(() => {
        child.kill();
        finish(-1);
      }, options.timeoutMs || 120000);
    } catch {
      finish(-1);
    }
  });
}

const powershellFor = (env) =>
  path.win32.join(
    env.SystemRoot || env.WINDIR || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
async function publicPowerShell(source, selectors, context) {
  const result = await context.runner(
    powershellFor(context.publicEnv),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(
        `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ${source}`,
        'utf16le',
      ).toString('base64'),
    ],
    {
      env: { ...context.publicEnv, ...selectors },
      timeoutMs: 30000,
      windowsHide: true,
      shell: false,
      captureStdout: true,
    },
  );
  if (result.code !== 0) fail('INTERNAL');
  return JSON.parse(result.stdout.trim());
}

async function defaultInspectTool(file, kind, context) {
  const { discoverSignTool, inspectAuthenticode, isTrustedMicrosoftTool } = await import(
    './signature-evidence.mjs'
  );
  const verificationOptions = {
    powershellPath: powershellFor(context.publicEnv),
    runner: context.publicRunner,
  };
  if (
    kind === 'signtool' &&
    !(await discoverSignTool({ explicitPath: file, ...verificationOptions }))
  )
    return { trusted: false };
  const auth = await inspectAuthenticode(file, {
    powershellPath: powershellFor(context.publicEnv),
    runner: context.publicRunner,
  });
  if (!isTrustedMicrosoftTool(auth)) return { trusted: false };
  const data = await readFile(file);
  if (data.length < 256 || data.toString('ascii', 0, 2) !== 'MZ') return { trusted: false };
  const offset = data.readUInt32LE(0x3c);
  if (offset + 6 > data.length || data.toString('ascii', offset, offset + 4) !== 'PE\0\0')
    return { trusted: false };
  const machine = data.readUInt16LE(offset + 4);
  const info = await publicPowerShell(
    '$v=[Diagnostics.FileVersionInfo]::GetVersionInfo($env:STUDIO_CHECK_FILE); @{ version=@($v.ProductMajorPart,$v.ProductMinorPart,$v.ProductBuildPart,$v.ProductPrivatePart) -join "."; fileVersion=$v.FileVersion } | ConvertTo-Json -Compress',
    { STUDIO_CHECK_FILE: file },
    context,
  );
  const siblingHashes = [];
  const resourceHashes = [];
  if (kind === 'signtool' || kind === 'azure-dlib') {
    const entries = await readdir(path.dirname(file), { withFileTypes: true });
    const libraries = entries.filter((entry) => /\.dll$/i.test(entry.name));
    if (libraries.length > 128) return { trusted: false };
    for (const entry of libraries) {
      const sibling = path.join(path.dirname(file), entry.name);
      if (!entry.isFile() || entry.isSymbolicLink()) return { trusted: false };
      // SignTool discovery already authenticates its complete adjacent DLL set.
      if (
        kind !== 'signtool' &&
        !isTrustedMicrosoftTool(await inspectAuthenticode(sibling, verificationOptions))
      )
        return { trusted: false };
      siblingHashes.push([
        sibling,
        createHash('sha256')
          .update(await readFile(sibling))
          .digest('hex'),
      ]);
    }
  }
  if (kind === 'azure-dlib') {
    const runtimeFile = path.join(path.dirname(file), 'Azure.CodeSigning.Dlib.runtimeconfig.json');
    if (!(await readableFile(runtimeFile))) return { trusted: false };
    const data = await readFile(runtimeFile);
    const config = JSON.parse(data.toString('utf8'));
    const runtime = config.runtimeOptions;
    if (
      Object.keys(config).some((key) => key !== 'runtimeOptions') ||
      !runtime ||
      Object.keys(runtime).some(
        (key) => !['tfm', 'framework', 'rollForward', 'configProperties'].includes(key),
      ) ||
      runtime.tfm !== 'net8.0' ||
      runtime.framework?.name !== 'Microsoft.NETCore.App' ||
      !/^8\.\d+\.\d+$/.test(runtime.framework?.version || '') ||
      Object.keys(runtime.configProperties || {}).some(
        (key) =>
          ![
            'System.Globalization.Invariant',
            'System.Reflection.Metadata.MetadataUpdater.IsSupported',
            'System.Runtime.Serialization.EnableUnsafeBinaryFormatterSerialization',
          ].includes(key),
      ) ||
      runtime.configProperties?.[
        'System.Runtime.Serialization.EnableUnsafeBinaryFormatterSerialization'
      ] === true
    )
      return { trusted: false };
    resourceHashes.push([runtimeFile, createHash('sha256').update(data).digest('hex')]);
  }
  return {
    trusted: true,
    architecture: machine === 0x8664 ? 'x64' : machine === 0x14c ? 'x86' : 'other',
    version: info.version,
    fileVersion: info.fileVersion,
    sha256: createHash('sha256').update(data).digest('hex'),
    kind,
    siblingHashes,
    resourceHashes,
  };
}

async function defaultInspectStoreCertificate({ thumbprint, store }, context) {
  return publicPowerShell(
    `
    $cert=Get-Item -LiteralPath ('Cert:/' + $env:STUDIO_CHECK_STORE + '/My/' + $env:STUDIO_CHECK_THUMBPRINT);
    $rsa=[Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPublicKey($cert);
    try { $bits=if($null -ne $rsa){$rsa.KeySize}else{0};
      @{thumbprint=$cert.Thumbprint; publisher=$cert.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false);
        hasPrivateKey=$cert.HasPrivateKey; publicKeyOID=$cert.PublicKey.Oid.Value; keyBits=$bits;
        notBefore=$cert.NotBefore.ToUniversalTime().ToString('o'); notAfter=$cert.NotAfter.ToUniversalTime().ToString('o');
        eku=@($cert.Extensions | Where-Object {$_.Oid.Value -eq '2.5.29.37'} | ForEach-Object {$_.EnhancedKeyUsages} | ForEach-Object {$_.Value})
      } | ConvertTo-Json -Compress
    } finally {if($null -ne $rsa){$rsa.Dispose()}}`,
    { STUDIO_CHECK_STORE: store, STUDIO_CHECK_THUMBPRINT: thumbprint },
    context,
  );
}

async function defaultInspectAzureRuntime(config, context) {
  const dotnetPath = config.dotnetPath;
  if (!localPath(dotnetPath, 'dotnet.exe') || !(await readableFile(dotnetPath))) return false;
  const info = await defaultInspectTool(dotnetPath, 'dotnet', context);
  if (!info.trusted || info.architecture !== 'x64') return false;
  const runtimes = await context.runner(dotnetPath, ['--list-runtimes'], {
    env: context.publicEnv,
    timeoutMs: 15000,
    windowsHide: true,
    shell: false,
    captureStdout: true,
  });
  if (runtimes.code !== 0 || !/^Microsoft\.NETCore\.App 8\.\d+\.\d+\s/m.test(runtimes.stdout))
    return false;
  const vc = await publicPowerShell(
    "$vc=Get-ItemProperty -LiteralPath 'HKLM:/SOFTWARE/Microsoft/VisualStudio/14.0/VC/Runtimes/x64'; @{ installed=($vc.Installed -eq 1); major=$vc.Major } | ConvertTo-Json -Compress",
    {},
    context,
  );
  return vc.installed === true && vc.major >= 14;
}

async function defaultMetadataStore(metadata) {
  const directory = await mkdtemp(path.join(tmpdir(), 'design-studio-signing-'));
  const file = path.join(directory, 'public-metadata.json');
  const cleanup = async () => {
    await unlink(file).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    await rmdir(directory);
  };
  try {
    await writeFile(file, JSON.stringify(metadata), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch {
    await cleanup();
    fail('METADATA');
  }
  return { file, cleanup };
}

function versionAtLeast(version, minimum) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(version || '')) return false;
  const parts = version.split('.').map(Number);
  for (let i = 0; i < 4; i++) {
    if (parts[i] !== minimum[i]) return parts[i] > minimum[i];
  }
  return true;
}

/** Public tooling inspection without credentials, Azure authentication, or signing.
 * SDK SignTool's FileVersion can be 4.00; ProductVersion carries the SDK version.
 */
export async function inspectProductionTooling({
  signToolPath,
  dlibPath,
  dotnetPath,
  env = process.env,
  platform = process.platform,
  runner = runSigningToolHidden,
} = {}) {
  return safe('INTERNAL', async () => {
    if (platform !== 'win32') fail('PLATFORM');
    if (!localPath(signToolPath, 'signtool.exe') || !(await readableFile(signToolPath)))
      fail('TOOL_PATH');
    const publicEnv = productionChildEnvironment(env);
    const publicRunner = (exe, args, options = {}) =>
      runner(exe, args, { ...options, env: publicEnv, windowsHide: true, shell: false });
    const context = { runner, publicRunner, publicEnv };
    const tool = await safe('TOOL_TRUST', () =>
      defaultInspectTool(signToolPath, 'signtool', context),
    );
    if (
      tool.trusted !== true ||
      tool.architecture !== 'x64' ||
      !versionAtLeast(tool.version, [10, 0, 22621, 755])
    )
      fail('TOOL_TRUST');
    let azure = null;
    if (dlibPath) {
      if (!localPath(dlibPath, 'Azure.CodeSigning.Dlib.dll') || !(await readableFile(dlibPath)))
        fail('AZURE_DLIB');
      const dlib = await safe('AZURE_DLIB', () =>
        defaultInspectTool(dlibPath, 'azure-dlib', context),
      );
      if (dlib.trusted !== true || dlib.architecture !== 'x64') fail('AZURE_DLIB');
      const runtimeReady = await safe('AZURE_RUNTIME', () =>
        defaultInspectAzureRuntime(
          {
            dotnetPath:
              dotnetPath ||
              path.win32.join(
                publicEnv.ProgramFiles || 'C:\\Program Files',
                'dotnet',
                'dotnet.exe',
              ),
          },
          context,
        ),
      );
      if (!runtimeReady) fail('AZURE_RUNTIME');
      azure = { dlibPath, dlib, runtimeReady: true };
    }
    return {
      toolingReady: true,
      signToolPath,
      signTool: tool,
      azure,
      credentialsInspected: false,
      signingPerformed: false,
    };
  });
}

function configuration(env, platform) {
  if (platform !== 'win32') fail('PLATFORM');
  const mode = get(env, 'STUDIO_SIGNING_MODE', 'MODE');
  if (mode === 'pfx') fail('PFX_UNSAFE');
  if (!['store', 'azure'].includes(mode)) fail('MODE');
  if (
    ['DEBUG', 'DEBUG_DMG', 'AZURE_IDENTITY_LOG_LEVEL', 'AZURE_LOG_LEVEL'].some((key) =>
      has(env, key),
    ) ||
    env.ELECTRON_BUILDER_OFFLINE === 'true'
  )
    fail('DEBUG_DISABLED');
  if (
    ['WIN_CSC_LINK', 'CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'CSC_KEY_PASSWORD'].some((key) =>
      has(env, key),
    )
  )
    fail('MIXED_CREDENTIALS');
  const signToolPath = get(env, 'STUDIO_SIGNTOOL_PATH', 'TOOL_PATH');
  if (!localPath(signToolPath, 'signtool.exe')) fail('TOOL_PATH');
  const publisher = get(env, 'STUDIO_SIGNING_PUBLISHER', 'PUBLISHER');
  if (publisher.length > 256) fail('PUBLISHER');
  if (has(env, 'STUDIO_TIMESTAMP_URL') && env.STUDIO_TIMESTAMP_URL !== TIMESTAMPS[mode])
    fail('CONFIG');
  const config = { mode, signToolPath, publisher, timestamp: TIMESTAMPS[mode] };
  if (mode === 'store') {
    if (
      [
        'AZURE_TENANT_ID',
        'AZURE_CLIENT_ID',
        'AZURE_CLIENT_SECRET',
        'STUDIO_AZURE_ENDPOINT',
        'STUDIO_AZURE_DLIB_PATH',
      ].some((key) => has(env, key))
    )
      fail('MIXED_CREDENTIALS');
    config.thumbprint = get(env, 'STUDIO_CERTIFICATE_SHA1').replace(/\s/g, '').toUpperCase();
    if (!/^[0-9A-F]{40}$/.test(config.thumbprint)) fail('CERTIFICATE');
    config.store = env.STUDIO_CERTIFICATE_STORE || 'CurrentUser';
    if (!['CurrentUser', 'LocalMachine'].includes(config.store)) fail('CERTIFICATE');
    return config;
  }
  if (has(env, 'STUDIO_CERTIFICATE_SHA1') || has(env, 'STUDIO_CERTIFICATE_STORE'))
    fail('MIXED_CREDENTIALS');
  for (const key of ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID']) {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(get(env, key, 'AZURE_CREDENTIALS')))
      fail('AZURE_CREDENTIALS');
  }
  get(env, 'AZURE_CLIENT_SECRET', 'AZURE_CREDENTIALS');
  let endpoint;
  try {
    endpoint = new URL(get(env, 'STUDIO_AZURE_ENDPOINT', 'AZURE_ENDPOINT'));
  } catch {
    fail('AZURE_ENDPOINT');
  }
  const region = endpoint.hostname.split('.')[0];
  if (
    endpoint.protocol !== 'https:' ||
    !AZURE_REGIONS.has(region) ||
    endpoint.hostname !== `${region}.codesigning.azure.net` ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.port ||
    !['', '/'].includes(endpoint.pathname)
  )
    fail('AZURE_ENDPOINT');
  config.endpoint = endpoint.origin;
  config.account = get(env, 'STUDIO_AZURE_ACCOUNT');
  config.profile = get(env, 'STUDIO_AZURE_PROFILE');
  if (
    ![config.account, config.profile].every((value) => /^[A-Za-z][A-Za-z0-9-]{2,99}$/.test(value))
  )
    fail('CONFIG');
  config.dlibPath = get(env, 'STUDIO_AZURE_DLIB_PATH', 'AZURE_DLIB');
  if (!localPath(config.dlibPath, 'Azure.CodeSigning.Dlib.dll')) fail('AZURE_DLIB');
  config.dotnetPath =
    env.STUDIO_DOTNET_PATH ||
    path.win32.join(env.ProgramFiles || 'C:\\Program Files', 'dotnet', 'dotnet.exe');
  // A credential accidentally pasted into a public field must never reach a command or JSON file.
  if (Object.values(config).some((value) => String(value).includes(env.AZURE_CLIENT_SECRET)))
    fail('CONFIG');
  return config;
}

/**
 * Production-only interface. Optional collaborators are for deterministic tests and
 * approved build-host integration, never loaded from environment or project content.
 * runner(exe,args,{env,timeoutMs,windowsHide:true,shell:false,captureStdout}) -> {code,stdout,stderr}
 * inspectTool(file,kind,context) -> {trusted,architecture,version,sha256}
 * inspectStoreCertificate({thumbprint,store},context) -> public certificate metadata
 * verifySignedFile(file,options) -> signature-evidence productionReady evidence
 * metadataStore(publicMetadata) -> {file,cleanup}; it never receives credentials.
 */
export async function createProductionProvider({
  env = process.env,
  platform = process.platform,
  runner = runSigningToolHidden,
  inspectTool = defaultInspectTool,
  inspectStoreCertificate = defaultInspectStoreCertificate,
  inspectAzureRuntime = defaultInspectAzureRuntime,
  verifySignedFile,
  metadataStore = defaultMetadataStore,
  fileReadable = readableFile,
  fingerprint = async (file) =>
    createHash('sha256')
      .update(await readFile(file))
      .digest('hex'),
  now = () => Date.now(),
} = {}) {
  // Snapshot: changing the caller's env after successful checks cannot change the signer.
  const source = { ...env };
  const config = configuration(source, platform);
  const publicEnv = productionChildEnvironment(source);
  const publicRunner = (exe, args, options = {}) =>
    runner(exe, args, {
      ...options,
      env: publicEnv,
      windowsHide: true,
      shell: false,
    });
  const context = { runner, publicRunner, publicEnv };
  const id = config.mode === 'azure' ? 'azure-artifact-signing' : 'rsa-ov';
  const secretEnv =
    config.mode === 'azure'
      ? {
          AZURE_TENANT_ID: source.AZURE_TENANT_ID,
          AZURE_CLIENT_ID: source.AZURE_CLIENT_ID,
          AZURE_CLIENT_SECRET: source.AZURE_CLIENT_SECRET,
        }
      : {};
  let ready;
  let toolHashes;
  let siblingSets;
  let queue = Promise.resolve();
  const preflight = async () => {
    if (ready) return ready;
    ready = safe('INTERNAL', async () => {
      if (!(await fileReadable(config.signToolPath))) fail('TOOL_PATH');
      const tool = await safe('TOOL_TRUST', () =>
        inspectTool(config.signToolPath, 'signtool', context),
      );
      if (
        tool?.trusted !== true ||
        tool.architecture !== 'x64' ||
        !versionAtLeast(tool.version, [10, 0, 22621, 755]) ||
        !/^[a-f0-9]{64}$/i.test(tool.sha256 || '')
      )
        fail('TOOL_TRUST');
      toolHashes = [[config.signToolPath, tool.sha256]];
      siblingSets = [];
      const rememberSiblings = (file, inspected) => {
        for (const [resource, digest] of inspected.resourceHashes || []) {
          if (!localPath(resource) || !/^[a-f0-9]{64}$/i.test(digest)) fail('TOOL_TRUST');
          toolHashes.push([resource, digest]);
        }
        if (!Array.isArray(inspected.siblingHashes)) return;
        for (const [sibling, digest] of inspected.siblingHashes) {
          if (!localPath(sibling) || !/^[a-f0-9]{64}$/i.test(digest)) fail('TOOL_TRUST');
          toolHashes.push([sibling, digest]);
        }
        siblingSets.push([
          path.dirname(file),
          inspected.siblingHashes.map(([sibling]) => path.basename(sibling).toLowerCase()).sort(),
        ]);
      };
      rememberSiblings(config.signToolPath, tool);
      if (config.mode === 'store') {
        const cert = await safe('CERTIFICATE', () =>
          inspectStoreCertificate({ thumbprint: config.thumbprint, store: config.store }, context),
        );
        if (
          !cert ||
          cert.thumbprint?.toUpperCase() !== config.thumbprint ||
          cert.hasPrivateKey !== true ||
          cert.publicKeyOID !== RSA_OID ||
          !Number.isInteger(cert.keyBits) ||
          cert.keyBits < 3072 ||
          !Array.isArray(cert.eku) ||
          !cert.eku.includes(CODE_SIGNING_OID) ||
          !(Date.parse(cert.notBefore) <= now()) ||
          !(Date.parse(cert.notAfter) > now())
        )
          fail('CERTIFICATE');
        if (cert.publisher !== config.publisher) fail('PUBLISHER');
      } else {
        if (!(await fileReadable(config.dlibPath))) fail('AZURE_DLIB');
        const dlib = await safe('AZURE_DLIB', () =>
          inspectTool(config.dlibPath, 'azure-dlib', context),
        );
        if (
          dlib?.trusted !== true ||
          dlib.architecture !== 'x64' ||
          !/^[a-f0-9]{64}$/i.test(dlib.sha256 || '')
        )
          fail('AZURE_DLIB');
        toolHashes.push([config.dlibPath, dlib.sha256]);
        rememberSiblings(config.dlibPath, dlib);
        if (!(await safe('AZURE_RUNTIME', () => inspectAzureRuntime(config, context))))
          fail('AZURE_RUNTIME');
      }
      return Object.freeze({
        id,
        mode: 'production',
        toolingReady: true,
        credentialsConfigured: true,
        publisher: config.publisher,
        signToolPath: config.signToolPath,
        signToolVersion: tool.version,
        fileDigest: 'SHA256',
        timestampDigest: 'SHA256',
        timestampProtocol: 'RFC3161',
        timestampUrl: config.timestamp,
        // Service identity validation, profile trust and role assignment require an actual signed result.
        remoteProfileVerified: false,
      });
    }).catch((error) => {
      ready = undefined;
      throw error;
    });
    return ready;
  };

  const doSign = async (file) =>
    safe('SIGN_FAILED', async () => {
      await preflight();
      if (
        !localPath(file) ||
        !['.exe', '.dll', '.node'].includes(path.win32.extname(file).toLowerCase()) ||
        !(await fileReadable(file))
      )
        fail('TARGET');
      for (const [toolFile, digest] of toolHashes) {
        if ((await safe('TOOL_CHANGED', () => fingerprint(toolFile))) !== digest)
          fail('TOOL_CHANGED');
      }
      for (const [directory, expected] of siblingSets) {
        const entries = await safe('TOOL_CHANGED', () =>
          readdir(directory, { withFileTypes: true }),
        );
        const actual = entries.filter((entry) => /\.dll$/i.test(entry.name));
        if (
          actual.some((entry) => !entry.isFile() || entry.isSymbolicLink()) ||
          JSON.stringify(actual.map((entry) => entry.name.toLowerCase()).sort()) !==
            JSON.stringify(expected)
        )
          fail('TOOL_CHANGED');
      }
      const args = ['sign', '/q', '/fd', 'SHA256', '/tr', config.timestamp, '/td', 'SHA256'];
      let metadata;
      try {
        if (config.mode === 'store') {
          args.push('/s', 'My', '/sha1', config.thumbprint, '/u', CODE_SIGNING_OID);
          if (config.store === 'LocalMachine') args.push('/sm');
        } else {
          metadata = await safe('METADATA', () =>
            metadataStore({
              Endpoint: config.endpoint,
              CodeSigningAccountName: config.account,
              CertificateProfileName: config.profile,
              ExcludeCredentials: [...EXCLUDED_CREDENTIALS],
            }),
          );
          if (!metadata || !localPath(metadata.file) || typeof metadata.cleanup !== 'function')
            fail('METADATA');
          args.push('/dlib', config.dlibPath, '/dmdf', metadata.file);
        }
        args.push(file);
        if (
          secretEnv.AZURE_CLIENT_SECRET &&
          args.some((arg) => arg.includes(secretEnv.AZURE_CLIENT_SECRET))
        )
          fail('CONFIG');
        const signed = await safe('SIGN_FAILED', () =>
          runner(config.signToolPath, args, {
            env: { ...publicEnv, ...secretEnv },
            timeoutMs: 120000,
            windowsHide: true,
            shell: false,
            captureStdout: false,
          }),
        );
        if (signed?.code !== 0) fail('SIGN_FAILED');
        const verifier =
          verifySignedFile || (await import('./signature-evidence.mjs')).inspectSignature;
        const evidence = await safe('VERIFY_FAILED', () =>
          verifier(file, {
            signtoolPath: config.signToolPath,
            production: true,
            runner: publicRunner,
            powershellPath: powershellFor(publicEnv),
            timeoutMs: 30000,
          }),
        );
        if (evidence?.productionReady !== true) fail('VERIFY_FAILED');
        if (
          config.mode === 'store' &&
          evidence.signerThumbprint?.toUpperCase() !== config.thumbprint
        )
          fail('VERIFY_FAILED');
        // The strong inspector exposes the public certificate simple name; never infer CN by splitting a DN.
        if (evidence.signerPublisher !== config.publisher) fail('PUBLISHER');
      } finally {
        if (typeof metadata?.cleanup === 'function')
          await safe('METADATA', () => metadata.cleanup());
      }
    });
  return Object.freeze({
    id,
    mode: 'production',
    preflight,
    sign(file) {
      // Hardware-token middleware and single credential contexts are serialized.
      const current = queue.then(() => doSign(file));
      queue = current.catch(() => undefined);
      return current;
    },
  });
}
