import { it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  archivePortable,
  verifyPortableArchive,
  validateTag,
  requireVerified,
  publicReport,
  assertTrackedPayload,
  findDraftRelease,
} from '../scripts/publish-github-release.mjs';
import { sha256 } from '../scripts/local-common.mjs';
const temporary = [];
it('looks up a new draft by release ID before its Git tag exists', async () => {
  const calls = [];
  const draft = {id: 123, tag_name: 'v0.1.0-local.20261002.2', target_commitish: 'abc', draft: true, assets: []};
  const request = async (args) => {
    calls.push(args[1]);
    if (args[1].endsWith('?per_page=100')) return JSON.stringify([draft]);
    if (args[1].endsWith('/123')) return JSON.stringify(draft);
    throw Error('Unexpected endpoint');
  };
  expect(await findDraftRelease(draft.tag_name, 'abc', request)).toEqual(draft);
  expect(calls).toHaveLength(2);
  await expect(findDraftRelease(draft.tag_name, 'wrong-commit', request)).rejects.toThrow('DRAFT_NOT_FOUND');
});
it('checks every byte inside the portable download, not just the original EXE', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'publish-archive-'));
  temporary.push(root);
  const app = path.join(root, 'app');
  await fs.mkdir(app);
  await fs.writeFile(path.join(app, 'Design Studio.exe'), 'test executable');
  const manifest = {
    entries: [
      { path: 'Design Studio.exe', sha256: await sha256(path.join(app, 'Design Studio.exe')) },
    ],
  };
  const zip = path.join(root, 'portable.zip');
  await archivePortable(app, zip);
  await verifyPortableArchive(zip, manifest);
  await expect(
    verifyPortableArchive(zip, { entries: [{ ...manifest.entries[0], sha256: '0'.repeat(64) }] }),
  ).rejects.toThrow('ARCHIVE_HASH_MISMATCH');
  await expect(archivePortable(app, zip)).rejects.toThrow();
});
afterEach(async () => {
  for (const p of temporary.splice(0)) await fs.rm(p, { recursive: true, force: true });
});
const build = {
  releaseMode: 'local',
  build: 'PASS',
  tests: { existingTests: 122, status: 'PASS' },
};
const verification = {
  integrity: 'PASS',
  applicationLaunch: 'PASS',
  exportVerification: 'PASS',
  restartVerification: 'PASS',
  policyChanged: false,
  beforeSHA256: 'a'.repeat(64),
  afterSHA256: 'a'.repeat(64),
  results: [
    'pptx',
    'web',
    'tokens',
    'project',
    'after-effects',
    'blender',
    'mp4',
    'webm',
    'png-sequence',
  ].map((format) => ({ check: 'export', status: 'PASS', format })),
};
it('requires a versioned LOCAL tag', () => {
  expect(validateTag('v0.1.0-local.20261002.1')).toBe('v0.1.0-local.20261002.1');
  for (const t of [undefined, 'latest', 'main', 'v0.1.0', '--delete'])
    expect(() => validateTag(t)).toThrow();
});
it('accepts the complete real verification contract', () => {
  expect(() => requireVerified(build, verification)).not.toThrow();
});
it.each(['integrity', 'applicationLaunch', 'exportVerification', 'restartVerification'])(
  'rejects failed %s before release creation',
  (key) => {
    expect(() => requireVerified(build, { ...verification, [key]: 'FAIL' })).toThrow();
  },
);
it('rejects skipped signing tests, SAC blocking, hash changes, missing exports and policy changes', () => {
  expect(() =>
    requireVerified({ ...build, tests: { existingTests: 121, status: 'PASS' } }, verification),
  ).toThrow();
  expect(() =>
    requireVerified(build, { ...verification, applicationLaunch: 'BLOCKED_BY_SAC' }),
  ).toThrow();
  expect(() => requireVerified(build, { ...verification, afterSHA256: 'b'.repeat(64) })).toThrow(
    'HASH_MISMATCH',
  );
  expect(() =>
    requireVerified(build, { ...verification, results: verification.results.slice(1) }),
  ).toThrow('EXPORT_MISSING');
  expect(() => requireVerified(build, { ...verification, policyChanged: true })).toThrow();
});
it('removes credentials and machine-specific paths from public reports', () => {
  const data = publicReport(
    {
      token: 'test-sentinel',
      nested: { clientSecret: 'test-sentinel', path: 'C:/private/work/file', status: 'PASS' },
      beforeSHA256: 'a'.repeat(64),
    },
    ['C:/private/work'],
  );
  expect(JSON.stringify(data)).not.toContain('test-sentinel');
  expect(data.nested.path).toBe('${LOCAL_PATH}/file');
  expect(data.nested.status).toBe('PASS');
});
it('detects bytes changed or added after the EXE verification', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'publish-payload-'));
  temporary.push(dir);
  const file = path.join(dir, 'app.exe');
  await fs.writeFile(file, 'fixture');
  const m = { entries: [{ path: 'app.exe', sha256: await sha256(file) }] };
  await assertTrackedPayload(m, dir);
  await fs.appendFile(file, 'tampered');
  await expect(assertTrackedPayload(m, dir)).rejects.toThrow('PAYLOAD_CHANGED');
  await fs.writeFile(path.join(dir, 'extra.dll'), 'unexpected');
  await expect(assertTrackedPayload(m, dir)).rejects.toThrow('PAYLOAD_CHANGED');
});
