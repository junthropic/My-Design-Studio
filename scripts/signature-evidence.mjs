import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const SHA256 = '2.16.840.1.101.3.4.2.1';
const RSA = '1.2.840.113549.1.1.1';
const helper = path.join(directory, 'read-pe-signature.ps1');
const statusValues = new Set([
  'Valid',
  'UnknownError',
  'NotSigned',
  'HashMismatch',
  'NotTrusted',
  'NotSupportedFileFormat',
  'Incompatible',
  'Unavailable',
]);

// Neither the inspected binary nor a shell command string is executed. Verification
// processes receive only OS paths, never signing credentials or provider secrets.
export function verificationEnvironment(source = process.env) {
  const allowed = new Set([
    'systemroot',
    'windir',
    'path',
    'temp',
    'tmp',
    'userprofile',
    'localappdata',
    'appdata',
    'programfiles',
    'programfiles(x86)',
    'programw6432',
    'systemdrive',
    'allusersprofile',
    'commonprogramfiles',
    'commonprogramfiles(x86)',
  ]);
  return Object.fromEntries(
    Object.entries(source).filter(
      ([key, value]) => allowed.has(key.toLowerCase()) && typeof value === 'string',
    ),
  );
}

export function runVerificationProcess(executable, args, { env, timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    let child,
      stdout = '',
      bytes = 0,
      finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ stdout, stderr: '', ...result });
    };
    const timer = setTimeout(
      () => {
        child?.kill();
        finish({ code: null, failure: 'TIMEOUT' });
      },
      Math.max(1000, Math.min(timeoutMs, 120000)),
    );
    try {
      child = spawn(executable, args, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: verificationEnvironment(env),
      });
      child.stdout.on('data', (data) => {
        bytes += data.length;
        if (bytes > 4 * 1024 * 1024) {
          child.kill();
          finish({ code: null, failure: 'OUTPUT_LIMIT' });
        } else stdout += data.toString('utf8');
      });
      // Drain stderr, but never copy arbitrary tool diagnostics into evidence/errors.
      child.stderr.on('data', () => {});
      child.once('error', () => finish({ code: null, failure: 'PROCESS_UNAVAILABLE' }));
      child.once('close', (code) =>
        finish({ code, failure: code === null ? 'PROCESS_INTERRUPTED' : undefined }),
      );
    } catch {
      finish({ code: null, failure: 'PROCESS_UNAVAILABLE' });
    }
  });
}

function powershell(options) {
  return (
    options.powershellPath ||
    path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    )
  );
}
function invoke(options, executable, args) {
  return (options.runner || runVerificationProcess)(executable, args, {
    env: verificationEnvironment(options.env),
    timeoutMs: options.timeoutMs || 30000,
  });
}
function cleanString(value, max = 1024) {
  return typeof value === 'string' ? value.slice(0, max) : null;
}
function oid(value) {
  return typeof value === 'string' && /^\d+(?:\.\d+){1,30}$/.test(value) && value.length < 160
    ? value
    : null;
}
function thumbprint(value) {
  return typeof value === 'string' && /^[a-f\d]{40,128}$/i.test(value) ? value.toUpperCase() : null;
}
function codes(values) {
  return Array.isArray(values)
    ? values.filter((v) => typeof v === 'string' && /^[A-Z][A-Z_]{2,80}$/.test(v)).slice(0, 64)
    : [];
}
function parseJSON(text) {
  try {
    return JSON.parse(
      String(text)
        .replace(/^\uFEFF/, '')
        .trim(),
    );
  } catch {
    return null;
  }
}

export async function inspectAuthenticode(file, options = {}) {
  const resolved = path.resolve(file);
  // Fixed built-in query, with the path passed as a quoted PowerShell literal.
  // This doesn't load/run the target, create a script, or change ExecutionPolicy.
  const literal = "'" + resolved.replaceAll("'", "''") + "'";
  const command = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $s=Get-AuthenticodeSignature -LiteralPath ${literal}; [pscustomobject]@{status=[string]$s.Status;signerSubject=$(if($s.SignerCertificate){$s.SignerCertificate.Subject});signerPublisher=$(if($s.SignerCertificate){$s.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false)});signerThumbprint=$(if($s.SignerCertificate){$s.SignerCertificate.Thumbprint});publicKeyOID=$(if($s.SignerCertificate){$s.SignerCertificate.PublicKey.Oid.Value});certificateSignatureOID=$(if($s.SignerCertificate){$s.SignerCertificate.SignatureAlgorithm.Value});timestampPresent=($null -ne $s.TimeStamperCertificate)} | ConvertTo-Json -Compress`;
  let result;
  try {
    result = await invoke(options, powershell(options), [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      command,
    ]);
  } catch {
    result = { code: null };
  }
  const raw = result.code === 0 ? parseJSON(result.stdout) : null;
  return {
    status: statusValues.has(raw?.status) ? raw.status : 'Unavailable',
    signerSubject: cleanString(raw?.signerSubject),
    signerPublisher: cleanString(raw?.signerPublisher),
    signerThumbprint: thumbprint(raw?.signerThumbprint),
    publicKeyOID: oid(raw?.publicKeyOID),
    certificateSignatureOID: oid(raw?.certificateSignatureOID),
    timestampPresent: raw?.timestampPresent === true,
  };
}

export function isTrustedMicrosoftTool(auth) {
  return (
    auth?.status === 'Valid' &&
    auth.publicKeyOID === RSA &&
    !!thumbprint(auth.signerThumbprint) &&
    typeof auth.signerSubject === 'string' &&
    /(?:^|,\s*)O=Microsoft Corporation(?:,|$)/i.test(auth.signerSubject)
  );
}

const toolTrustCache = new Map();
async function trustedToolDirectory(file, options) {
  // SDK SignTool can load sibling native libraries. Authenticate these too before
  // running a tool taken from a user-writable download/build cache.
  let entries;
  try {
    entries = await fs.readdir(path.dirname(file), { withFileTypes: true });
  } catch {
    return false;
  }
  const libraries = entries.filter((entry) => /\.dll$/i.test(entry.name));
  if (libraries.length > 128) return false;
  if (libraries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) return false;
  const bundleFiles = [
    file,
    ...libraries.map((entry) => path.join(path.dirname(file), entry.name)),
  ].sort();
  // Short lived trust cache is bound to every native file's actual SHA256 bytes,
  // not to paths or modification dates. This avoids hundreds of repeated Windows
  // certificate queries when inspecting one release while detecting replacements.
  const fingerprint = (await Promise.all(bundleFiles.map(fileFingerprint))).join(':');
  const cache = options.runner ? null : toolTrustCache.get(file);
  if (cache && cache.fingerprint === fingerprint && cache.expiresAt > Date.now()) return true;
  if (!isTrustedMicrosoftTool(await inspectAuthenticode(file, options))) return false;
  for (const entry of libraries) {
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      !isTrustedMicrosoftTool(
        await inspectAuthenticode(path.join(path.dirname(file), entry.name), options),
      )
    )
      return false;
  }
  if (!options.runner) toolTrustCache.set(file, { fingerprint, expiresAt: Date.now() + 60000 });
  return true;
}

export async function discoverSignTool({ explicitPath, cacheRoots, ...options } = {}) {
  if (explicitPath) {
    if (
      !path.isAbsolute(explicitPath) ||
      path.basename(explicitPath).toLowerCase() !== 'signtool.exe'
    )
      return null;
    try {
      const stat = await fs.lstat(explicitPath);
      if (!stat.isFile() || stat.isSymbolicLink()) return null;
      return (await trustedToolDirectory(explicitPath, options))
        ? path.resolve(explicitPath)
        : null;
    } catch {
      return null;
    }
  }
  const roots = cacheRoots || [
    path.resolve(directory, '../work/signing-tools'),
    path.resolve(directory, '../../../work/builder-cache'),
    ...(process.env.ELECTRON_BUILDER_CACHE ? [process.env.ELECTRON_BUILDER_CACHE] : []),
    ...(process.env.LOCALAPPDATA
      ? [path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache')]
      : []),
    path.join(
      process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
      'Windows Kits',
      '10',
      'bin',
    ),
  ];
  const found = [];
  let examined = 0;
  async function visit(current, depth) {
    if (depth > 5 || examined > 8000) return;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (++examined > 8000) break;
      if (entry.isSymbolicLink()) continue;
      const name = path.join(current, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === 'signtool.exe') found.push(name);
      else if (entry.isDirectory()) await visit(name, depth + 1);
    }
  }
  for (const root of roots)
    if (typeof root === 'string' && path.isAbsolute(root)) await visit(root, 0);
  // Prefer x64 over x86 and newer version directories without relying on PATH.
  found.sort(
    (a, b) =>
      Number(/[/\\]x64[/\\]/i.test(b)) - Number(/[/\\]x64[/\\]/i.test(a)) ||
      b.localeCompare(a, undefined, { numeric: true }),
  );
  for (const candidate of found)
    if (await trustedToolDirectory(candidate, options)) return candidate;
  return null;
}

async function fileFingerprint(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function isPortableExecutable(file) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    const header = Buffer.alloc(64);
    if (
      stat.size < 64 ||
      (await handle.read(header, 0, 64, 0)).bytesRead !== 64 ||
      header.readUInt16LE(0) !== 0x5a4d
    )
      return false;
    const offset = header.readUInt32LE(60);
    const signature = Buffer.alloc(24);
    return (
      offset >= 64 &&
      offset + 24 <= stat.size &&
      (await handle.read(signature, 0, 24, offset)).bytesRead === 24 &&
      signature.readUInt32LE(0) === 0x4550
    );
  } finally {
    await handle.close();
  }
}
function normalizedSignatures(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 64).map((value) => {
    const sig = value && typeof value === 'object' ? value : {};
    return {
      fileDigestOID: oid(sig.fileDigestOID),
      signatureDigestOID: oid(sig.signatureDigestOID),
      publicKeyOID: oid(sig.publicKeyOID),
      certificateSignatureOID: oid(sig.certificateSignatureOID),
      signerThumbprint: thumbprint(sig.signerThumbprint),
      signerSubject: cleanString(sig.signerSubject),
      signatureValid: sig.signatureValid === true,
      parseErrors: codes(sig.parseErrors),
      nestedDepth: Number.isInteger(sig.nestedDepth) ? sig.nestedDepth : 0,
      timestamps: Array.isArray(sig.timestamps)
        ? sig.timestamps
            .filter((stamp) => stamp && typeof stamp === 'object')
            .slice(0, 16)
            .map((stamp) => ({
              type:
                stamp.type === 'RFC3161'
                  ? 'RFC3161'
                  : stamp.type === 'Authenticode'
                    ? 'Authenticode'
                    : 'Unknown',
              digestOID: oid(stamp.digestOID),
              signatureValid: stamp.signatureValid === true,
              imprintMatches: stamp.imprintMatches === true,
              genTime: cleanString(stamp.genTime, 64),
              chainValid: stamp.chainValid === true,
              signerDigestOIDs: Array.isArray(stamp.signerDigestOIDs)
                ? stamp.signerDigestOIDs.map(oid).filter(Boolean).slice(0, 16)
                : [],
              signerThumbprints: Array.isArray(stamp.signerThumbprints)
                ? stamp.signerThumbprints.map(thumbprint).filter(Boolean).slice(0, 16)
                : [],
            }))
        : [],
    };
  });
}

export function evaluateSignatureEvidence({
  file,
  authenticode = {},
  pe = {},
  signTool = {},
  fileSHA256 = null,
  unchanged = true,
  isPE = false,
} = {}) {
  const signatures = normalizedSignatures(pe.signatures);
  const parseErrors = codes(pe.parseErrors);
  if (Array.isArray(pe.signatures) && pe.signatures.length > 64) parseErrors.push('CMS_LIMIT');
  const authValid = authenticode.status === 'Valid';
  const toolValid =
    signTool.status === 'Valid' && signTool.exitCode === 0 && signTool.toolTrusted === true;
  const chainValid = authValid && toolValid && unchanged;
  const rsa =
    authenticode.publicKeyOID === RSA &&
    (signatures.length === 0 || signatures.every((s) => s.publicKeyOID === RSA));
  const parsedValid =
    signatures.length > 0 &&
    parseErrors.length === 0 &&
    signatures.every((s) => s.signatureValid && s.parseErrors.length === 0);
  const sha256 =
    parsedValid &&
    signatures.every((s) => s.fileDigestOID === SHA256 && s.signatureDigestOID === SHA256);
  const rfc3161 =
    parsedValid && signatures.every((s) => s.timestamps.some((t) => t.type === 'RFC3161'));
  const timestampSha256 =
    parsedValid &&
    signatures.every((s) =>
      s.timestamps.some((t) => t.type === 'RFC3161' && t.digestOID === SHA256),
    );
  const timestampValid =
    chainValid &&
    parsedValid &&
    signatures.every((s) =>
      s.timestamps.some(
        (t) => t.signatureValid && t.imprintMatches && (t.type === 'Authenticode' || t.chainValid),
      ),
    );
  const modernTimestampValid =
    chainValid &&
    parsedValid &&
    signatures.every((s) =>
      s.timestamps.some(
        (t) =>
          t.type === 'RFC3161' &&
          t.digestOID === SHA256 &&
          t.signatureValid &&
          t.imprintMatches &&
          t.chainValid,
      ),
    );
  // Preservation doesn't rewrite a valid vendor signature merely because its
  // historical digest/timestamp predates the stricter policy for our new signing.
  const preservationReady = isPE && chainValid && rsa;
  const productionReady = preservationReady && parsedValid && sha256 && modernTimestampValid;
  const issues = [];
  if (!isPE) issues.push('NOT_PE');
  if (!authValid) issues.push('AUTHENTICODE_NOT_VALID');
  if (!toolValid)
    issues.push(signTool.status === 'Unavailable' ? 'SIGNTOOL_UNAVAILABLE' : 'SIGNTOOL_NOT_VALID');
  if (!unchanged) issues.push('FILE_CHANGED_DURING_VERIFICATION');
  if (!rsa) issues.push('RSA_REQUIRED');
  if (!parsedValid) issues.push('CMS_EVIDENCE_INCOMPLETE');
  if (!sha256) issues.push('SHA256_FILE_AND_SIGNATURE_DIGEST_REQUIRED');
  if (!modernTimestampValid) issues.push('VALID_RFC3161_SHA256_TIMESTAMP_REQUIRED');
  return {
    file,
    isPE,
    fileSHA256,
    authenticodeStatus: statusValues.has(authenticode.status) ? authenticode.status : 'Unavailable',
    signTool: {
      status: ['Valid', 'Invalid', 'Unavailable'].includes(signTool.status)
        ? signTool.status
        : 'Unavailable',
      exitCode: Number.isInteger(signTool.exitCode) ? signTool.exitCode : null,
      path: cleanString(signTool.path),
      toolTrusted: signTool.toolTrusted === true,
    },
    rsa,
    sha256,
    rfc3161,
    timestampSha256,
    timestampValid,
    chainValid,
    fileDigestOID: signatures.length === 1 ? signatures[0].fileDigestOID : null,
    signatureDigestOID: signatures.length === 1 ? signatures[0].signatureDigestOID : null,
    fileDigestOIDs: [...new Set(signatures.map((s) => s.fileDigestOID).filter(Boolean))],
    signatureDigestOIDs: [...new Set(signatures.map((s) => s.signatureDigestOID).filter(Boolean))],
    signerSubject: cleanString(authenticode.signerSubject),
    signerPublisher: cleanString(authenticode.signerPublisher),
    signerThumbprint: thumbprint(authenticode.signerThumbprint),
    signatures,
    parseErrors,
    issues,
    unchanged,
    preservationReady,
    productionReady,
    chainValidation:
      'Windows Authenticode and SignTool /pa /all; includes Authenticode timestamp lifetime policy',
  };
}

export class SignatureVerificationError extends Error {
  constructor(evidence) {
    super(`Windows production signature verification failed: ${evidence.issues.join(', ')}`);
    this.name = 'SignatureVerificationError';
    this.evidence = evidence;
  }
}

export async function inspectSignature(file, options = {}) {
  const resolved = path.resolve(file);
  let before = null,
    after = null,
    peFlag = false,
    pe = { parseErrors: ['SIGNATURE_READ_FAILED'] },
    authenticode = { status: 'Unavailable' };
  let signTool = { status: 'Unavailable', exitCode: null, path: null, toolTrusted: false };
  try {
    const stat = await fs.lstat(resolved);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('NOT_FILE');
    before = await fileFingerprint(resolved);
    peFlag = await isPortableExecutable(resolved);
    authenticode = await inspectAuthenticode(resolved, options);
    let parsed;
    try {
      parsed = await invoke(options, powershell(options), [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-File',
        helper,
        '-FilePath',
        resolved,
      ]);
    } catch {
      parsed = { code: null };
    }
    const raw = parsed.code === 0 ? parseJSON(parsed.stdout) : null;
    if (raw && Array.isArray(raw.signatures)) pe = raw;
    const tool = await discoverSignTool({
      explicitPath: options.signtoolPath,
      cacheRoots: options.cacheRoots,
      ...options,
    });
    if (tool) {
      const toolHash = await fileFingerprint(tool);
      // Recheck after discovery immediately before running any discovered executable.
      const toolAuth = await inspectAuthenticode(tool, options);
      if (isTrustedMicrosoftTool(toolAuth)) {
        let verified;
        try {
          verified = await invoke(options, tool, ['verify', '/pa', '/all', '/v', '/tw', resolved]);
        } catch {
          verified = { code: null };
        }
        const toolUnchanged = toolHash === (await fileFingerprint(tool));
        signTool = {
          path: tool,
          status:
            verified.code === 0 && toolUnchanged
              ? 'Valid'
              : verified.code === null
                ? 'Unavailable'
                : 'Invalid',
          exitCode: verified.code ?? null,
          toolTrusted: toolUnchanged,
        };
      }
    }
    after = await fileFingerprint(resolved);
  } catch {
    /* Return public, fail-closed evidence; never arbitrary native diagnostics. */
  }
  const evidence = evaluateSignatureEvidence({
    file: resolved,
    authenticode,
    pe,
    signTool,
    fileSHA256: before,
    unchanged: before !== null && before === after,
    isPE: peFlag,
  });
  if (options.production === true && !evidence.productionReady)
    throw new SignatureVerificationError(evidence);
  return evidence;
}
