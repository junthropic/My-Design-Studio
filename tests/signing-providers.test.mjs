import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const modulePath = pathToFileURL(path.resolve('scripts/signing-providers.mjs')).href;
const { createProductionProvider, SigningProviderError, productionChildEnvironment } = await import(
  modulePath
);
const SHA1 = 'AB'.repeat(20);
const HASH = '12'.repeat(32);
const PUBLISHER = 'Example Studio';
const TARGET = 'C:\\output\\Design Studio.exe';
const SECRET = 'CLIENT_SECRET_MUST_NEVER_APPEAR';
const system = {
  SystemRoot: 'C:\\Windows',
  WINDIR: 'C:\\Windows',
  ProgramFiles: 'C:\\Program Files',
  TEMP: 'C:\\user\\temp',
};
const common = {
  ...system,
  STUDIO_SIGNTOOL_PATH: 'C:\\SDK\\x64\\signtool.exe',
  STUDIO_SIGNING_PUBLISHER: PUBLISHER,
};
const storeEnv = {
  ...common,
  STUDIO_SIGNING_MODE: 'store',
  STUDIO_CERTIFICATE_SHA1: SHA1,
  STUDIO_CERTIFICATE_STORE: 'CurrentUser',
};
const azureEnv = {
  ...common,
  STUDIO_SIGNING_MODE: 'azure',
  STUDIO_AZURE_ENDPOINT: 'https://krc.codesigning.azure.net',
  STUDIO_AZURE_ACCOUNT: 'sample-account',
  STUDIO_AZURE_PROFILE: 'sample-profile',
  STUDIO_AZURE_DLIB_PATH: 'C:\\Azure\\x64\\Azure.CodeSigning.Dlib.dll',
  AZURE_TENANT_ID: '11111111-2222-3333-4444-555555555555',
  AZURE_CLIENT_ID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  AZURE_CLIENT_SECRET: SECRET,
};
const certificate = {
  thumbprint: SHA1,
  publisher: PUBLISHER,
  hasPrivateKey: true,
  publicKeyOID: '1.2.840.113549.1.1.1',
  keyBits: 3072,
  eku: ['1.3.6.1.5.5.7.3.3'],
  notBefore: '2026-01-01T00:00:00Z',
  notAfter: '2027-01-01T00:00:00Z',
};
function mocks(env = storeEnv) {
  const cleanup = vi.fn(async () => undefined);
  return {
    env,
    platform: 'win32',
    now: () => Date.parse('2026-10-02T12:00:00Z'),
    fileReadable: vi.fn(async () => true),
    fingerprint: vi.fn(async () => HASH),
    inspectTool: vi.fn(async () => ({
      trusted: true,
      architecture: 'x64',
      version: '10.0.26100.0',
      sha256: HASH,
    })),
    inspectStoreCertificate: vi.fn(async () => ({ ...certificate })),
    inspectAzureRuntime: vi.fn(async () => true),
    runner: vi.fn(async (..._args) => ({ code: 0, stdout: '', stderr: '' })),
    verifySignedFile: vi.fn(async (..._args) => ({
      productionReady: true,
      signerThumbprint: SHA1,
      signerPublisher: PUBLISHER,
    })),
    metadataStore: vi.fn(async (..._args) => ({
      file: 'C:\\user\\temp\\public-metadata.json',
      cleanup,
    })),
    cleanup,
  };
}
describe('production signing providers — mocked processes, never actual signing', () => {
  it('accepts the SDK product version when its legacy FileVersion is 4.00', async () => {
    const options = mocks();
    options.inspectTool.mockResolvedValue({
      trusted: true,
      architecture: 'x64',
      version: '10.0.26100.7175',
      fileVersion: '4.00 (WinBuild.160101.0800)',
      sha256: HASH,
    });
    expect(await (await createProductionProvider(options)).preflight()).toMatchObject({
      signToolVersion: '10.0.26100.7175',
    });
    expect(options.runner).not.toHaveBeenCalled();
  });

  it('does not send a known credential accidentally embedded in a target filename', async () => {
    const options = mocks(azureEnv);
    const provider = await createProductionProvider(options);
    await expect(provider.sign(`C:\\output\\${SECRET}.exe`)).rejects.toMatchObject({
      code: 'CONFIG',
    });
    expect(options.runner).not.toHaveBeenCalled();
    expect(options.cleanup).toHaveBeenCalledOnce();
  });
  it('rejects absent credentials before filesystem or process calls', async () => {
    const options = mocks();
    await expect(createProductionProvider({ ...options, env: {} })).rejects.toMatchObject({
      code: 'MODE',
    });
    expect(options.fileReadable).not.toHaveBeenCalled();
    expect(options.runner).not.toHaveBeenCalled();
    await expect(
      createProductionProvider({ ...options, env: { ...azureEnv, AZURE_CLIENT_SECRET: '' } }),
    ).rejects.toMatchObject({ code: 'AZURE_CREDENTIALS' });
    expect(options.inspectTool).not.toHaveBeenCalled();
  });
  it('rejects production PFX without reading its path or leaking password', async () => {
    const options = mocks();
    const error = await createProductionProvider({
      ...options,
      env: {
        ...storeEnv,
        STUDIO_SIGNING_MODE: 'pfx',
        WIN_CSC_LINK: 'C:\\keys\\private.pfx',
        WIN_CSC_KEY_PASSWORD: SECRET,
      },
    }).catch((e) => e);
    expect(error).toMatchObject({ code: 'PFX_UNSAFE' });
    expect(String(error)).not.toContain(SECRET);
    expect(String(error)).not.toContain('private.pfx');
    expect(options.fileReadable).not.toHaveBeenCalled();
  });
  it.each(['linux', 'darwin'])('rejects unsupported platform %s', async (platform) => {
    await expect(createProductionProvider({ ...mocks(), platform })).rejects.toMatchObject({
      code: 'PLATFORM',
    });
  });
  it.each(['DEBUG', 'DEBUG_DMG', 'AZURE_IDENTITY_LOG_LEVEL', 'AZURE_LOG_LEVEL'])(
    'blocks debug environment %s',
    async (key) => {
      await expect(
        createProductionProvider({ ...mocks(), env: { ...storeEnv, [key]: SECRET } }),
      ).rejects.toMatchObject({ code: 'DEBUG_DISABLED' });
    },
  );
  it.each([
    'signtool.exe',
    '\\\\server\\sdk\\signtool.exe',
    'C:\\tools\\other.exe',
    'C:\\tools\\..\\signtool.exe',
    'C:\\tools\\signtool.exe:stream',
  ])('requires safe absolute SDK tool path %s', async (tool) => {
    await expect(
      createProductionProvider({ ...mocks(), env: { ...storeEnv, STUDIO_SIGNTOOL_PATH: tool } }),
    ).rejects.toMatchObject({ code: 'TOOL_PATH' });
  });
  it.each([
    { trusted: false },
    { architecture: 'x86' },
    { version: '10.0.20348.0' },
    { version: 'garbage' },
    { sha256: 'bad' },
  ])('rejects untrusted, old or mismatched tools %o', async (bad) => {
    const options = mocks();
    options.inspectTool.mockResolvedValue({
      trusted: true,
      architecture: 'x64',
      version: '10.0.26100.0',
      sha256: HASH,
      ...bad,
    });
    const provider = await createProductionProvider(options);
    await expect(provider.preflight()).rejects.toMatchObject({ code: 'TOOL_TRUST' });
    expect(options.runner).not.toHaveBeenCalled();
  });
  it('preflight is local/read-only and returns public metadata only', async () => {
    const options = mocks(azureEnv);
    const provider = await createProductionProvider(options);
    expect(Object.keys(provider).sort()).toEqual(['id', 'mode', 'preflight', 'sign']);
    const readiness = await provider.preflight();
    expect(readiness).toMatchObject({
      id: 'azure-artifact-signing',
      mode: 'production',
      fileDigest: 'SHA256',
      timestampDigest: 'SHA256',
      timestampProtocol: 'RFC3161',
      remoteProfileVerified: false,
    });
    expect(JSON.stringify(readiness)).not.toContain(SECRET);
    expect(JSON.stringify(readiness)).not.toContain(azureEnv.AZURE_TENANT_ID);
    expect(options.runner).not.toHaveBeenCalled();
    expect(options.metadataStore).not.toHaveBeenCalled();
    expect(options.verifySignedFile).not.toHaveBeenCalled();
  });
  it.each([
    { publicKeyOID: '1.2.840.10045.2.1' },
    { keyBits: 2048 },
    { keyBits: undefined },
    { hasPrivateKey: false },
    { hasPrivateKey: 'true' },
    { eku: [] },
    { notBefore: '2027-01-01' },
    { notAfter: '2026-01-01' },
    { notAfter: 'invalid' },
    { thumbprint: 'CD'.repeat(20) },
  ])('requires current exact RSA Code Signing certificate %o', async (bad) => {
    const options = mocks();
    options.inspectStoreCertificate.mockResolvedValue({ ...certificate, ...bad });
    const provider = await createProductionProvider(options);
    await expect(provider.preflight()).rejects.toMatchObject({ code: 'CERTIFICATE' });
    expect(options.runner).not.toHaveBeenCalled();
  });
  it('selects only the configured certificate store and exact publisher', async () => {
    const options = mocks({ ...storeEnv, STUDIO_CERTIFICATE_STORE: 'LocalMachine' });
    options.inspectStoreCertificate.mockResolvedValue({
      ...certificate,
      publisher: 'Another Publisher',
    });
    const provider = await createProductionProvider(options);
    await expect(provider.preflight()).rejects.toMatchObject({ code: 'PUBLISHER' });
    expect(options.inspectStoreCertificate.mock.calls[0]?.[0]).toEqual({
      thumbprint: SHA1,
      store: 'LocalMachine',
    });
  });
  it.each(['CurrentUser', 'LocalMachine'])(
    'signs %s with RSA certificate selector, SHA256 and RFC3161 then verifies',
    async (store) => {
      const options = mocks({ ...storeEnv, STUDIO_CERTIFICATE_STORE: store });
      const provider = await createProductionProvider(options);
      await provider.sign(TARGET);
      const [executable, args, child] = options.runner.mock.calls[0];
      expect(executable).toBe(storeEnv.STUDIO_SIGNTOOL_PATH);
      expect(args).toEqual([
        'sign',
        '/q',
        '/fd',
        'SHA256',
        '/tr',
        'http://timestamp.digicert.com',
        '/td',
        'SHA256',
        '/s',
        'My',
        '/sha1',
        SHA1,
        '/u',
        '1.3.6.1.5.5.7.3.3',
        ...(store === 'LocalMachine' ? ['/sm'] : []),
        TARGET,
      ]);
      expect(child).toMatchObject({ windowsHide: true, shell: false, captureStdout: false });
      expect(args).not.toContain('/p');
      expect(args).not.toContain('/f');
      expect(args).not.toContain('/t');
      expect(options.verifySignedFile.mock.calls[0][0]).toBe(TARGET);
      expect(options.verifySignedFile.mock.calls[0][1]).toMatchObject({
        production: true,
        signtoolPath: storeEnv.STUDIO_SIGNTOOL_PATH,
      });
    },
  );
  it('snapshots credentials and passes Azure secrets only to the signing child environment', async () => {
    const env = {
      ...azureEnv,
      OPENAI_API_KEY: 'OTHER_SECRET',
      NODE_OPTIONS: '--require injected.js',
      PSModulePath: 'untrusted',
      PATH: 'untrusted',
      HTTP_PROXY: 'http://user:password@host',
    };
    const options = mocks(env);
    const provider = await createProductionProvider(options);
    env.AZURE_CLIENT_SECRET = 'CHANGED_SECRET';
    await provider.sign(TARGET);
    const [tool, args, child] = options.runner.mock.calls[0];
    expect(tool).toBe(common.STUDIO_SIGNTOOL_PATH);
    expect(args).toEqual([
      'sign',
      '/q',
      '/fd',
      'SHA256',
      '/tr',
      'http://timestamp.acs.microsoft.com',
      '/td',
      'SHA256',
      '/dlib',
      azureEnv.STUDIO_AZURE_DLIB_PATH,
      '/dmdf',
      'C:\\user\\temp\\public-metadata.json',
      TARGET,
    ]);
    expect(child.env.AZURE_CLIENT_SECRET).toBe(SECRET);
    for (const key of [
      'OPENAI_API_KEY',
      'NODE_OPTIONS',
      'PSModulePath',
      'HTTP_PROXY',
      'STUDIO_AZURE_PROFILE',
    ])
      expect(child.env[key]).toBeUndefined();
    expect(child.env.PATH).toBe('C:\\Windows\\System32;C:\\Windows');
    expect(JSON.stringify(args)).not.toContain(SECRET);
    const metadata = options.metadataStore.mock.calls[0][0];
    expect(Object.keys(metadata).sort()).toEqual([
      'CertificateProfileName',
      'CodeSigningAccountName',
      'Endpoint',
      'ExcludeCredentials',
    ]);
    expect(metadata.ExcludeCredentials).toContain('InteractiveBrowserCredential');
    expect(metadata.ExcludeCredentials).toContain('AzureCliCredential');
    expect(metadata.ExcludeCredentials).not.toContain('EnvironmentCredential');
    expect(JSON.stringify(metadata)).not.toContain(SECRET);
    expect(JSON.stringify(metadata)).not.toContain(azureEnv.AZURE_CLIENT_ID);
    expect(options.cleanup).toHaveBeenCalledOnce();
    expect(env.PSModulePath).toBe('untrusted');
  });
  it('verification subprocesses receive no Azure secret even if an inspector passes ambient env', async () => {
    const options = mocks(azureEnv);
    options.verifySignedFile.mockImplementation(async (_file, verifyOptions) => {
      await verifyOptions.runner('C:\\Windows\\System32\\tool.exe', ['verify'], {
        env: { AZURE_CLIENT_SECRET: SECRET, NODE_OPTIONS: SECRET },
      });
      return { productionReady: true, signerThumbprint: SHA1, signerPublisher: PUBLISHER };
    });
    await (await createProductionProvider(options)).sign(TARGET);
    const verifyChild = options.runner.mock.calls[1][2];
    expect(verifyChild.env.AZURE_CLIENT_SECRET).toBeUndefined();
    expect(verifyChild.env.NODE_OPTIONS).toBeUndefined();
  });
  it.each([
    'https://krc.codesigning.azure.net.evil.invalid',
    'http://krc.codesigning.azure.net',
    'https://krc.codesigning.azure.net/path',
    'https://user:password@krc.codesigning.azure.net',
    'https://unknown.codesigning.azure.net',
    'https://krc.codesigning.azure.net?token=secret',
  ])('rejects endpoint %s before tool execution', async (endpoint) => {
    const options = mocks(azureEnv);
    await expect(
      createProductionProvider({
        ...options,
        env: { ...azureEnv, STUDIO_AZURE_ENDPOINT: endpoint },
      }),
    ).rejects.toMatchObject({ code: 'AZURE_ENDPOINT' });
    expect(options.inspectTool).not.toHaveBeenCalled();
  });
  it('rejects mixed provider credentials and unapproved timestamp endpoints', async () => {
    await expect(
      createProductionProvider({ ...mocks(), env: { ...storeEnv, AZURE_CLIENT_SECRET: SECRET } }),
    ).rejects.toMatchObject({ code: 'MIXED_CREDENTIALS' });
    await expect(
      createProductionProvider({ ...mocks(), env: { ...azureEnv, STUDIO_CERTIFICATE_SHA1: SHA1 } }),
    ).rejects.toMatchObject({ code: 'MIXED_CREDENTIALS' });
    await expect(
      createProductionProvider({
        ...mocks(),
        env: { ...storeEnv, STUDIO_TIMESTAMP_URL: 'http://unapproved.invalid' },
      }),
    ).rejects.toMatchObject({ code: 'CONFIG' });
  });
  it('rejects Azure missing runtime or untrusted plugin', async () => {
    const options = mocks(azureEnv);
    options.inspectAzureRuntime.mockResolvedValue(false);
    await expect((await createProductionProvider(options)).preflight()).rejects.toMatchObject({
      code: 'AZURE_RUNTIME',
    });
    options.inspectTool
      .mockResolvedValueOnce({
        trusted: true,
        architecture: 'x64',
        version: '10.0.26100.0',
        sha256: HASH,
      })
      .mockResolvedValueOnce({
        trusted: false,
        architecture: 'x64',
        version: '1.0.0.0',
        sha256: HASH,
      });
    await expect((await createProductionProvider(options)).preflight()).rejects.toMatchObject({
      code: 'AZURE_DLIB',
    });
    expect(options.runner).not.toHaveBeenCalled();
  });
  it.each([
    'relative.exe',
    'C:\\output\\target.txt',
    '\\\\server\\target.exe',
    'C:\\output\\target.exe:stream',
    'C:\\output\\target.exe\n',
  ])('rejects unsafe signing target %s', async (file) => {
    const options = mocks();
    await expect((await createProductionProvider(options)).sign(file)).rejects.toMatchObject({
      code: 'TARGET',
    });
    expect(options.runner).not.toHaveBeenCalled();
  });
  it('checks tool fingerprints again immediately before signing', async () => {
    const options = mocks();
    options.fingerprint.mockResolvedValue('34'.repeat(32));
    await expect((await createProductionProvider(options)).sign(TARGET)).rejects.toMatchObject({
      code: 'TOOL_CHANGED',
    });
    expect(options.runner).not.toHaveBeenCalled();
  });
  it.each([1, 2, -1])(
    'treats exit code %s, including warnings, as signing failure with metadata cleanup',
    async (code) => {
      const options = mocks(azureEnv);
      options.runner.mockResolvedValue({ code, stdout: SECRET, stderr: SECRET });
      const error = await (await createProductionProvider(options)).sign(TARGET).catch((e) => e);
      expect(error).toMatchObject({ code: 'SIGN_FAILED' });
      expect(String(error)).not.toContain(SECRET);
      expect(options.verifySignedFile).not.toHaveBeenCalled();
      expect(options.cleanup).toHaveBeenCalledOnce();
    },
  );
  it('sanitizes external thrown errors, causes and mutated provider errors', async () => {
    for (const error of [
      new Error(SECRET, { cause: SECRET }),
      Object.assign(new SigningProviderError('SIGN_FAILED'), { message: SECRET, cause: SECRET }),
    ]) {
      const options = mocks(azureEnv);
      options.runner.mockRejectedValue(error);
      const failure = await (await createProductionProvider(options)).sign(TARGET).catch((e) => e);
      expect(failure).toBeInstanceOf(SigningProviderError);
      expect(String(failure)).not.toContain(SECRET);
      expect(JSON.stringify(failure)).not.toContain(SECRET);
      expect(failure.cause).toBeUndefined();
      expect(options.cleanup).toHaveBeenCalledOnce();
    }
  });
  it.each([
    { productionReady: false },
    { signerThumbprint: 'CD'.repeat(20) },
    { signerPublisher: 'Another Studio' },
  ])('never accepts failed verification or a different signer %o', async (bad) => {
    const options = mocks();
    options.verifySignedFile.mockResolvedValue({
      productionReady: true,
      signerThumbprint: SHA1,
      signerPublisher: PUBLISHER,
      ...bad,
    });
    await expect((await createProductionProvider(options)).sign(TARGET)).rejects.toBeInstanceOf(
      SigningProviderError,
    );
  });
  it('sanitizes verifier and metadata errors and always cleans prepared metadata', async () => {
    const options = mocks(azureEnv);
    options.verifySignedFile.mockRejectedValue(new Error(SECRET));
    const error = await (await createProductionProvider(options)).sign(TARGET).catch((e) => e);
    expect(error).toMatchObject({ code: 'VERIFY_FAILED' });
    expect(String(error)).not.toContain(SECRET);
    expect(options.cleanup).toHaveBeenCalledOnce();
    options.metadataStore.mockRejectedValue(new Error(SECRET));
    const next = await (await createProductionProvider(options)).sign(TARGET).catch((e) => e);
    expect(next).toMatchObject({ code: 'METADATA' });
    expect(String(next)).not.toContain(SECRET);
  });
  it('serializes sign requests without carrying a prior failure into the next file', async () => {
    const options = mocks();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    options.runner.mockImplementationOnce(async () => {
      await gate;
      return { code: 1, stdout: '', stderr: '' };
    });
    const provider = await createProductionProvider(options);
    const first = provider.sign(TARGET).catch((e) => e);
    const second = provider.sign('C:\\output\\library.dll');
    await vi.waitFor(() => expect(options.runner).toHaveBeenCalledOnce());
    release();
    expect(await first).toMatchObject({ code: 'SIGN_FAILED' });
    await expect(second).resolves.toBeUndefined();
    expect(options.runner).toHaveBeenCalledTimes(2);
  });
  it('environment allowlist is case-insensitive and leaves caller environment unchanged', () => {
    const source = {
      SYSTEMROOT: 'C:\\Windows',
      Path: 'untrusted',
      PSMODULEPATH: SECRET,
      OPENAI_API_KEY: SECRET,
      NODE_OPTIONS: SECRET,
      AZURE_CLIENT_SECRET: SECRET,
    };
    const result = productionChildEnvironment(source);
    expect(result.SystemRoot).toBe('C:\\Windows');
    expect(result.PATH).toBe('C:\\Windows\\System32;C:\\Windows');
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(source.PSMODULEPATH).toBe(SECRET);
  });
});
