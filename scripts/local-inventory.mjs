import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { inspectAuthenticode } from './signature-evidence.mjs';
import { sha256, inside, writeJson, projectDir } from './local-common.mjs';

const require = createRequire(import.meta.url);
const fixedRuntime = [
  'Design Studio.exe',
  'resources/app.asar',
  'icudtl.dat',
  'resources.pak',
  'snapshot_blob.bin',
  'v8_context_snapshot.bin',
  'locales/en-US.pak',
  'resources/remotion-browser/chrome-headless-shell.exe',
  'resources/remotion-browser/studio-browser.json',
];
export async function readLocalPE(file) {
  const handle = await fs.open(file, 'r');
  try {
    const size = (await handle.stat()).size,
      dos = Buffer.alloc(64);
    if (
      size < 64 ||
      (await handle.read(dos, 0, 64, 0)).bytesRead !== 64 ||
      dos.readUInt16LE(0) !== 0x5a4d
    )
      return { pe: false, valid: false };
    const offset = dos.readUInt32LE(60),
      header = Buffer.alloc(24);
    if (offset < 64 || offset + 24 > size) return { pe: true, valid: false };
    await handle.read(header, 0, 24, offset);
    if (header.readUInt32LE(0) !== 0x4550) return { pe: true, valid: false };
    const sections = header.readUInt16LE(6),
      optionalSize = header.readUInt16LE(20),
      table = offset + 24 + optionalSize;
    if (!sections || sections > 96 || optionalSize < 96 || table + sections * 40 > size)
      return { pe: true, valid: false };
    const optional = Buffer.alloc(optionalSize);
    await handle.read(optional, 0, optionalSize, offset + 24);
    const magic = optional.readUInt16LE(0);
    if (
      ![0x10b, 0x20b].includes(magic) ||
      !optional.readUInt32LE(56) ||
      optional.readUInt32LE(60) > size
    )
      return { pe: true, valid: false };
    const tableBytes = Buffer.alloc(sections * 40);
    await handle.read(tableBytes, 0, tableBytes.length, table);
    for (let i = 0; i < sections; i++) {
      const raw = tableBytes.readUInt32LE(i * 40 + 16),
        position = tableBytes.readUInt32LE(i * 40 + 20);
      if (raw && (position < optional.readUInt32LE(60) || position + raw > size))
        return { pe: true, valid: false };
    }
    return { pe: true, valid: true, machine: header.readUInt16LE(4), sections };
  } finally {
    await handle.close();
  }
}
export async function listLocalFiles(root) {
  const info = await fs.lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error('LOCAL_INVALID_ROOT');
  const files = [];
  async function visit(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw Error('LOCAL_SYMLINK_REJECTED');
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  await visit(root);
  return files.sort();
}
export function acceptLocalSignature({ signature, rule, previous, hash, pe }) {
  if (!pe.valid) throw Error('LOCAL_CORRUPTED_BINARY');
  if (!rule) throw Error('LOCAL_UNKNOWN_EXECUTABLE');
  if (previous?.status === 'Valid' && (signature.status !== 'Valid' || hash !== previous.sha256))
    throw Error('LOCAL_VENDOR_SIGNATURE_CHANGED');
  if (signature.status === 'Valid') return 'preserve-valid-signature';
  if (signature.status !== 'NotSigned') throw Error('LOCAL_INVALID_SIGNATURE');
  if (rule.signUnsigned !== true) throw Error('LOCAL_EXPECTED_VENDOR_SIGNATURE_MISSING');
  return rule.ownership === 'first-party'
    ? 'allow-unsigned-first-party'
    : 'allow-unsigned-bundled-runtime';
}
async function productionVendorBaseline() {
  // Already-established, read-only provenance. No production report is updated.
  return JSON.parse(
    await fs.readFile(path.join(projectDir, 'scripts/local-vendor-baseline.json'), 'utf8'),
  );
}
export async function validateLocalRuntime(root, policy) {
  const required = [
    ...fixedRuntime,
    ...policy.rules.filter((r) => r.path !== 'resources/elevate.exe').map((r) => r.path),
  ];
  for (const relative of new Set(required)) {
    if (!inside(root, path.join(root, relative))) throw Error('LOCAL_INVALID_RUNTIME_PATH');
    const stat = await fs.stat(path.join(root, relative)).catch(() => null);
    if (!stat?.isFile() || stat.size === 0) throw Error('LOCAL_RUNTIME_MISSING: ' + relative);
  }
  const asar = require('@electron/asar'),
    archive = path.join(root, 'resources/app.asar');
  for (const entry of [
    'package.json',
    'dist/index.html',
    'dist-electron/main.cjs',
    'dist-server/index.js',
    'dist-remotion/index.html',
    'node_modules/sql.js/dist/sql-wasm.wasm',
  ]) {
    let bytes;
    try {
      bytes = asar.extractFile(archive, path.normalize(entry));
    } catch {
      throw Error('LOCAL_ASAR_ENTRY_MISSING: ' + entry);
    }
    if (!bytes.length) throw Error('LOCAL_ASAR_ENTRY_EMPTY');
  }
  const metadata = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
  if (metadata.name !== 'design-studio' || metadata.main !== 'dist-electron/main.cjs')
    throw Error('LOCAL_ASAR_METADATA_INVALID');
  const browser = JSON.parse(
    await fs.readFile(path.join(root, 'resources/remotion-browser/studio-browser.json'), 'utf8'),
  );
  if (
    browser.executable !== 'chrome-headless-shell.exe' ||
    (await sha256(path.join(root, 'resources/remotion-browser/chrome-headless-shell.exe'))) !==
      browser.sha256
  )
    throw Error('LOCAL_BROWSER_HASH_MISMATCH');
  return {
    passed: true,
    requiredFiles: new Set(required).size,
    archiveEntrypoints: 'PASS',
    browserHash: 'PASS',
  };
}
export async function createLocalInventory({
  appDirectory,
  outputPath,
  inspect = inspectAuthenticode,
  policy,
  vendorBaseline,
  runtimeCheck = validateLocalRuntime,
}) {
  policy ??= JSON.parse(
    await fs.readFile(path.join(projectDir, 'scripts/signing-ownership.json'), 'utf8'),
  );
  vendorBaseline ??= await productionVendorBaseline();
  const inventory = {
    schemaVersion: 1,
    releaseMode: 'local',
    createdAt: new Date().toISOString(),
    codeSigningRequired: false,
    productionCredentialRequired: false,
    signingPerformed: false,
    policyChanged: false,
    integrity: 'RUNNING',
    entries: [],
    executables: [],
  };
  try {
    inventory.runtime = await runtimeCheck(appDirectory, policy);
    for (const file of await listLocalFiles(appDirectory)) {
      const relative = path.relative(appDirectory, file).replaceAll('\\', '/'),
        stat = await fs.stat(file),
        hash = await sha256(file);
      inventory.entries.push({ path: relative, bytes: stat.size, sha256: hash });
      const pe = await readLocalPE(file);
      if (!pe.pe && !/\.(exe|dll|node)$/i.test(file)) continue;
      const signature = await inspect(file),
        rule = policy.rules.find((r) => r.path.toLowerCase() === relative.toLowerCase());
      const action = acceptLocalSignature({
        signature,
        rule,
        previous: vendorBaseline[relative.toLowerCase()],
        hash,
        pe,
      });
      inventory.executables.push({
        path: relative,
        ownership: rule.ownership,
        origin: rule.origin,
        signature: {
          status: signature.status,
          signerThumbprint: signature.signerThumbprint || null,
        },
        action,
        beforeSHA256: hash,
        afterSHA256: hash,
        pe,
      });
    }
    for (const name of Object.keys(vendorBaseline))
      if (!inventory.executables.some((e) => e.path.toLowerCase() === name))
        throw Error('LOCAL_VALID_VENDOR_MISSING');
    inventory.integrity = 'PASS';
  } catch (error) {
    inventory.integrity = 'FAIL';
    inventory.failure = error.message;
    await writeJson(outputPath, inventory);
    throw error;
  }
  await writeJson(outputPath, inventory);
  return inventory;
}
export async function verifyLocalIntegrity({
  appDirectory,
  manifestPath,
  inspect = inspectAuthenticode,
  runtimeCheck = validateLocalRuntime,
  policy,
}) {
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (
    manifest.releaseMode !== 'local' ||
    manifest.integrity !== 'PASS' ||
    !Array.isArray(manifest.entries)
  )
    throw Error('LOCAL_MANIFEST_INVALID');
  policy ??= JSON.parse(
    await fs.readFile(path.join(projectDir, 'scripts/signing-ownership.json'), 'utf8'),
  );
  const files = await listLocalFiles(appDirectory);
  if (files.length !== manifest.entries.length) throw Error('LOCAL_INVENTORY_CHANGED');
  const seen = new Set();
  for (const entry of manifest.entries) {
    const file = path.resolve(appDirectory, entry.path);
    if (!inside(appDirectory, file) || seen.has(entry.path.toLowerCase()))
      throw Error('LOCAL_MANIFEST_PATH_INVALID');
    seen.add(entry.path.toLowerCase());
    if ((await sha256(file)) !== entry.sha256) throw Error('LOCAL_HASH_MISMATCH: ' + entry.path);
  }
  await runtimeCheck(appDirectory, policy);
  const nativePaths = [];
  for (const file of files) {
    const pe = await readLocalPE(file);
    if (pe.pe || /\.(exe|dll|node)$/i.test(file))
      nativePaths.push(path.relative(appDirectory, file).replaceAll('\\', '/'));
  }
  if (
    !Array.isArray(manifest.executables) ||
    nativePaths.length !== manifest.executables.length ||
    new Set(manifest.executables.map((e) => e.path.toLowerCase())).size !== nativePaths.length ||
    nativePaths.some((p) => !manifest.executables.some((e) => e.path === p))
  )
    throw Error('LOCAL_EXECUTABLE_INVENTORY_INCOMPLETE');
  for (const entry of manifest.executables) {
    const file = path.join(appDirectory, entry.path),
      signature = await inspect(file),
      pe = await readLocalPE(file);
    acceptLocalSignature({
      signature,
      rule: policy.rules.find((r) => r.path.toLowerCase() === entry.path.toLowerCase()),
      previous: { status: entry.signature.status, sha256: entry.afterSHA256 },
      hash: await sha256(file),
      pe,
    });
  }
  return manifest;
}
