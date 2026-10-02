import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const digest = async (file) =>
  createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex');
const failure = (code) => Object.assign(new Error(`Signing release failed: ${code}`), { code });
const relative = (root, file) => {
  const name = path.relative(root, path.resolve(file));
  if (!name || name.startsWith('..') || path.isAbsolute(name))
    throw failure('OUTSIDE_RELEASE_ROOT');
  return name.replaceAll('\\', '/');
};

export async function isPortableExecutable(file) {
  const handle = await fs.open(file, 'r');
  try {
    const header = Buffer.alloc(64);
    if ((await handle.read(header, 0, 64, 0)).bytesRead !== 64 || header.readUInt16LE(0) !== 0x5a4d)
      return false;
    const offset = header.readUInt32LE(60),
      size = (await handle.stat()).size;
    if (offset < 64 || offset > size - 4) return false;
    const pe = Buffer.alloc(4);
    await handle.read(pe, 0, 4, offset);
    return pe.readUInt32LE(0) === 0x00004550;
  } finally {
    await handle.close();
  }
}

/** Inspect headers as well as suffixes so PE files with unexpected names cannot escape inventory. */
export async function collectSigningFiles(directory) {
  const root = path.resolve(directory),
    files = [];
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('INVALID_RELEASE_ROOT');
  async function visit(folder) {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) throw failure('SYMLINK_IN_RELEASE');
      if (entry.isDirectory()) await visit(file);
      else if (
        entry.isFile() &&
        (/\.(exe|dll|node)$/i.test(entry.name) || (await isPortableExecutable(file)))
      )
        files.push(file);
    }
  }
  await visit(root);
  return files.sort();
}

export async function readOwnershipPolicy() {
  const policy = JSON.parse(await fs.readFile(path.join(here, 'signing-ownership.json'), 'utf8'));
  if (policy.schemaVersion !== 1 || !Array.isArray(policy.rules))
    throw failure('INVALID_OWNERSHIP_POLICY');
  const seen = new Set();
  for (const rule of policy.rules) {
    if (
      typeof rule.path !== 'string' ||
      rule.path.includes('..') ||
      path.isAbsolute(rule.path) ||
      seen.has(rule.path.toLowerCase())
    )
      throw failure('INVALID_OWNERSHIP_RULE');
    seen.add(rule.path.toLowerCase());
  }
  return policy;
}

function publicEvidence(evidence) {
  const allowedStatus = new Set([
    'Valid',
    'NotSigned',
    'HashMismatch',
    'NotTrusted',
    'UnknownError',
    'NotSupportedFileFormat',
    'Invalid',
    'Unavailable',
  ]);
  return {
    authenticodeStatus: allowedStatus.has(evidence.authenticodeStatus)
      ? evidence.authenticodeStatus
      : 'Invalid',
    signTool: {
      status: allowedStatus.has(evidence.signTool?.status)
        ? evidence.signTool.status
        : 'Unavailable',
      exitCode: Number.isInteger(evidence.signTool?.exitCode) ? evidence.signTool.exitCode : null,
    },
    rsa: evidence.rsa === true,
    sha256: evidence.sha256 === true,
    rfc3161: evidence.rfc3161 === true,
    timestampSha256: evidence.timestampSha256 === true,
    timestampValid: evidence.timestampValid === true,
    chainValid: evidence.chainValid === true,
    signerThumbprint: /^[0-9a-f]{40,64}$/i.test(evidence.signerThumbprint || '')
      ? evidence.signerThumbprint.toUpperCase()
      : null,
  };
}

function dualValid(e) {
  return (
    e.authenticodeStatus === 'Valid' &&
    e.signTool?.status === 'Valid' &&
    e.signTool.exitCode === 0 &&
    e.chainValid === true
  );
}
function productionValid(e) {
  return dualValid(e) && e.rsa && e.sha256 && e.rfc3161 && e.timestampSha256 && e.timestampValid;
}

export function classifySigningTarget(name, evidence, policy, kind = 'internal') {
  const rule =
    kind === 'internal'
      ? policy.rules.find((r) => r.path.toLowerCase() === name.toLowerCase())
      : policy.installer;
  if (!rule)
    return {
      ownership: 'unknown',
      action: 'blocked-unknown',
      origin: null,
      purpose: null,
      licenseEvidence: [],
    };
  const publicRule = {
    ownership: rule.ownership,
    origin: rule.origin,
    purpose: rule.purpose,
    licenseEvidence: rule.licenseEvidence || [],
  };
  if (evidence.authenticodeStatus === 'Valid')
    return { ...publicRule, action: 'preserve-existing-signature' };
  if (evidence.authenticodeStatus !== 'NotSigned')
    return { ...publicRule, action: 'blocked-invalid-signature' };
  if (rule.signUnsigned !== true) return { ...publicRule, action: 'blocked-unsigned-policy' };
  return {
    ...publicRule,
    action:
      kind !== 'internal'
        ? 'sign-installer-component'
        : rule.ownership === 'first-party'
          ? 'sign-first-party'
          : 'sign-bundled-distribution',
  };
}

async function atomicJson(file, object) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.pending';
  await fs.writeFile(temporary, JSON.stringify(object, null, 2));
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(temporary, file);
      break;
    } catch (error) {
      if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code))
        throw failure('MANIFEST_COMMIT_FAILED');
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

/** Read-only plan. A pre-existing signature is a preservation candidate, not proof of release approval. */
export async function createTargetManifest({
  appDirectory,
  installer,
  inspect,
  policy,
  outputPath,
}) {
  const entries = [];
  for (const file of [
    ...(await collectSigningFiles(appDirectory)),
    ...(installer ? [installer] : []),
  ]) {
    const kind = file === installer ? 'installer' : 'internal';
    const name = kind === 'internal' ? relative(appDirectory, file) : path.basename(file);
    const evidence = await inspect(file, { production: false });
    entries.push({
      path: name,
      kind,
      pe: await isPortableExecutable(file),
      ...classifySigningTarget(name, evidence, policy, kind),
      beforeSHA256: await digest(file),
      afterSHA256: null,
      before: publicEvidence(evidence),
      after: null,
      status: 'planned',
    });
  }
  const manifest = {
    schemaVersion: 1,
    mode: 'preparation',
    status: 'awaiting-production-credential',
    createdAt: new Date().toISOString(),
    signingPolicy: {
      key: 'RSA',
      fileDigest: 'SHA256',
      timestamp: 'RFC3161',
      timestampDigest: 'SHA256',
    },
    actualSigningPerformed: false,
    generatedComponents: installer
      ? [
          {
            path: path.basename(installer).slice(0, -3) + '__uninstaller.exe',
            kind: 'uninstaller',
            ...classifySigningTarget(
              '',
              { authenticodeStatus: 'NotSigned' },
              policy,
              'uninstaller',
            ),
            beforeSHA256: null,
            afterSHA256: null,
            status: 'generated-after-internal-verification',
          },
        ]
      : [],
    entries,
  };
  if (outputPath) await atomicJson(outputPath, manifest);
  return manifest;
}

/** One ledger per build; raw provider/runner messages never enter the manifest or errors. */
export function createSigningSession({
  appDirectory,
  outputDirectory,
  manifestPath,
  provider,
  inspect,
  policy,
  installerName,
  mode = 'production',
}) {
  const root = path.resolve(appDirectory),
    output = path.resolve(outputDirectory);
  if (
    !provider ||
    !['production', 'mock'].includes(mode) ||
    provider.mode !== mode ||
    !['rsa-ov', 'azure-artifact-signing'].includes(provider.id)
  )
    throw failure('PROVIDER_MODE_MISMATCH');
  if (
    path.basename(installerName) !== installerName ||
    !installerName.toLowerCase().endsWith('.exe')
  )
    throw failure('INVALID_INSTALLER_NAME');
  const uninstallerName = installerName.slice(0, -3) + '__uninstaller.exe';
  const ledger = {
    schemaVersion: 1,
    mode,
    provider: provider.id,
    status: 'internal-signing',
    createdAt: new Date().toISOString(),
    signingPolicy: {
      key: 'RSA',
      fileDigest: 'SHA256',
      timestamp: 'RFC3161',
      timestampDigest: 'SHA256',
    },
    actualSigningPerformed: false,
    actualSigningAttempted: false,
    productionVerified: false,
    entries: [],
    events: [],
  };
  let ready = false,
    failed = false,
    phase = 'internal',
    queue = Promise.resolve();
  const save = () => atomicJson(manifestPath, ledger);
  const event = (name) => ledger.events.push({ name, at: new Date().toISOString() });
  async function fail(code) {
    failed = true;
    ledger.status = 'failed';
    ledger.failureCode = code;
    event(code);
    await save();
    throw failure(code);
  }
  const serialize = (task) => {
    const result = queue.then(async () => {
      if (failed) throw failure('RELEASE_ALREADY_FAILED');
      return task();
    });
    queue = result.catch(() => {});
    return result;
  };
  function locate(file, kind) {
    const absolute = path.resolve(file);
    if (kind === 'internal') return relative(root, absolute);
    if (
      !['uninstaller', 'installer'].includes(kind) ||
      path.dirname(absolute) !== output ||
      path.basename(absolute) !== (kind === 'installer' ? installerName : uninstallerName)
    )
      throw failure('UNEXPECTED_INSTALLER_COMPONENT');
    return path.basename(absolute);
  }
  async function ensureReady() {
    if (!ready) {
      try {
        await provider.preflight();
        ready = true;
        event('provider-ready');
      } catch {
        await fail('PRODUCTION_CREDENTIAL_OR_TOOL_UNAVAILABLE');
      }
    }
  }
  async function verifyEntry(entry, file) {
    let evidence;
    try {
      evidence = await inspect(file, { production: entry.status === 'signed' });
    } catch {
      return fail('SIGNATURE_RECHECK_FAILED');
    }
    if (!dualValid(evidence) || (entry.status === 'signed' && !productionValid(evidence)))
      return fail('SIGNATURE_RECHECK_FAILED');
    if ((await digest(file)) !== entry.afterSHA256) return fail('SIGNED_FILE_CHANGED');
  }
  async function processOne(file, kind) {
    await ensureReady();
    let name;
    try {
      name = locate(file, kind);
    } catch {
      return fail('UNEXPECTED_SIGNING_PATH');
    }
    const previous = ledger.entries.find((entry) => entry.path === name && entry.kind === kind);
    if (previous) {
      await verifyEntry(previous, file);
      return previous;
    }
    if (
      (kind === 'internal' && phase !== 'internal') ||
      (kind === 'uninstaller' && phase !== 'internals-verified') ||
      (kind === 'installer' && phase !== 'uninstaller-verified')
    )
      return fail('SIGNING_ORDER_VIOLATION');
    if (!(await isPortableExecutable(file))) return fail('NOT_A_PE_FILE');
    let evidence;
    try {
      evidence = await inspect(file, { production: false });
    } catch {
      return fail('PRE_SIGN_INSPECTION_FAILED');
    }
    const entry = {
      path: name,
      kind,
      pe: true,
      ...classifySigningTarget(name, evidence, policy, kind),
      beforeSHA256: await digest(file),
      afterSHA256: null,
      before: publicEvidence(evidence),
      after: null,
      status: 'pending',
    };
    ledger.entries.push(entry);
    await save();
    if (entry.action.startsWith('blocked')) return fail('OWNERSHIP_OR_SIGNATURE_REJECTED');
    if (entry.action === 'preserve-existing-signature') {
      if (!dualValid(evidence)) return fail('EXISTING_SIGNATURE_NOT_VALID_IN_BOTH_TOOLS');
      entry.afterSHA256 = await digest(file);
      if (entry.afterSHA256 !== entry.beforeSHA256) return fail('PRESERVED_FILE_CHANGED');
      entry.after = publicEvidence(evidence);
      entry.status = 'preserved';
      event('preserved-existing-signature');
    } else {
      if ((await digest(file)) !== entry.beforeSHA256) return fail('FILE_CHANGED_BEFORE_SIGNING');
      ledger.actualSigningAttempted = mode === 'production';
      await save();
      try {
        await provider.sign(file);
      } catch {
        entry.afterSHA256 = await digest(file).catch(() => null);
        entry.status = 'signing-failed';
        return fail('SIGN_OR_TIMESTAMP_FAILED');
      }
      ledger.actualSigningPerformed = mode === 'production';
      // Record post-attempt bytes even when validation fails; never call a failure release-ready.
      entry.afterSHA256 = await digest(file);
      try {
        evidence = await inspect(file, { production: true });
      } catch {
        return fail('POST_SIGN_VERIFICATION_FAILED');
      }
      entry.after = publicEvidence(evidence);
      if (!productionValid(evidence)) return fail('RSA_SHA256_RFC3161_OR_CHAIN_INVALID');
      if (entry.beforeSHA256 === entry.afterSHA256)
        return fail('SIGNER_DID_NOT_CHANGE_UNSIGNED_FILE');
      entry.status = 'signed';
      event(kind + '-signed-and-verified');
    }
    if (kind === 'uninstaller') phase = 'uninstaller-verified';
    if (kind === 'installer') phase = 'installer-verified';
    ledger.status = phase;
    await save();
    return entry;
  }
  return {
    processFile(file, { kind = 'internal' } = {}) {
      return serialize(() => processOne(file, kind));
    },
    auditInternals(files) {
      return serialize(async () => {
        if (phase !== 'internal') return fail('INTERNALS_ALREADY_SEALED');
        for (const file of files) await processOne(file, 'internal');
        event('internal-audit-before-nsis-helper');
        await save();
      });
    },
    completeInternals(files) {
      return serialize(async () => {
        if (phase !== 'internal') return fail('INTERNALS_ALREADY_SEALED');
        if (!files.length) return fail('EMPTY_INTERNAL_INVENTORY');
        const names = new Set();
        for (const file of files) {
          names.add(relative(root, file));
          await processOne(file, 'internal');
        }
        if (ledger.entries.some((e) => e.kind === 'internal' && !names.has(e.path)))
          return fail('INTERNAL_FILE_DISAPPEARED');
        for (const file of files) {
          const entry = ledger.entries.find(
            (e) => e.kind === 'internal' && e.path === relative(root, file),
          );
          await verifyEntry(entry, file);
        }
        phase = 'internals-verified';
        ledger.status = phase;
        event('internals-verified-before-installer');
        await save();
      });
    },
    finish(installer) {
      return serialize(async () => {
        if (phase !== 'installer-verified') return fail('INSTALLER_NOT_SIGNED');
        const finalFiles = await collectSigningFiles(root);
        const internal = ledger.entries.filter((e) => e.kind === 'internal');
        if (finalFiles.length !== internal.length) return fail('INTERNAL_INVENTORY_CHANGED');
        for (const file of finalFiles) {
          const entry = internal.find((e) => e.path === relative(root, file));
          if (!entry) return fail('INTERNAL_INVENTORY_CHANGED');
          await verifyEntry(entry, file);
        }
        const entry = ledger.entries.find(
          (e) => e.kind === 'installer' && e.path === locate(installer, 'installer'),
        );
        if (!entry) return fail('INSTALLER_NOT_SIGNED');
        await verifyEntry(entry, installer);
        ledger.status =
          mode === 'production' ? 'signed-awaiting-final-verification' : 'mock-complete';
        ledger.productionVerified = mode === 'production';
        event(ledger.status);
        await save();
        return structuredClone(ledger);
      });
    },
    snapshot() {
      return structuredClone(ledger);
    },
  };
}

/** Final verification consumes a production ledger, never a mock or preparation manifest. */
export async function verifyReleaseManifest({ appDirectory, installer, manifestPath, inspect }) {
  const report = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (
    report.schemaVersion !== 1 ||
    report.mode !== 'production' ||
    report.status !== 'signed-awaiting-final-verification' ||
    report.productionVerified !== true ||
    !Array.isArray(report.entries)
  )
    throw failure('PRODUCTION_MANIFEST_REQUIRED');
  const files = await collectSigningFiles(appDirectory);
  const internal = report.entries.filter((e) => e.kind === 'internal');
  if (files.length !== internal.length) throw failure('RELEASE_INVENTORY_MISMATCH');
  const checked = [];
  for (const file of [...files, installer]) {
    const kind = file === installer ? 'installer' : 'internal';
    const name = kind === 'installer' ? path.basename(file) : relative(appDirectory, file);
    const entries = report.entries.filter((e) => e.path === name && e.kind === kind);
    if (entries.length !== 1) throw failure('RELEASE_INVENTORY_MISMATCH');
    const entry = entries[0];
    if (
      !['signed', 'preserved'].includes(entry.status) ||
      !/^([a-f0-9]{64})$/.test(entry.beforeSHA256) ||
      (await digest(file)) !== entry.afterSHA256
    )
      throw failure('RELEASE_HASH_MISMATCH');
    const evidence = await inspect(file, { production: entry.status === 'signed' });
    if (!dualValid(evidence) || (entry.status === 'signed' && !productionValid(evidence)))
      throw failure('RELEASE_DUAL_VERIFICATION_FAILED');
    if (entry.status === 'preserved' && entry.beforeSHA256 !== entry.afterSHA256)
      throw failure('PRESERVED_FILE_CHANGED');
    checked.push({
      path: name,
      kind,
      status: entry.status,
      SHA256: entry.afterSHA256,
      evidence: publicEvidence(evidence),
    });
  }
  const uninstaller = report.entries.filter((e) => e.kind === 'uninstaller');
  if (
    uninstaller.length !== 1 ||
    uninstaller[0].status !== 'signed' ||
    !productionValid(uninstaller[0].after)
  )
    throw failure('UNINSTALLER_SIGNING_EVIDENCE_REQUIRED');
  return {
    Passed: true,
    FileCount: checked.length,
    Files: checked,
    embeddedUninstaller: {
      afterSHA256: uninstaller[0].afterSHA256,
      validation: 'verified-before-embedding; installed-copy-verification-is-separate',
    },
  };
}
