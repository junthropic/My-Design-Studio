import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import {
  projectDir,
  localRoot,
  sha256,
  writeJson,
  runLocalTool,
  localEnvironment,
  assertProductionPreserved,
} from './local-common.mjs';
import { listLocalFiles } from './local-inventory.mjs';
import { buildLocalRelease } from './local-release.mjs';
import { verifyLocalRelease } from './verify-local-release.mjs';

export const repository = 'junthropic/My-Design-Studio';
export async function archivePortable(appDirectory, outputFile) {
  const require = createRequire(import.meta.url),
    archiver = require('archiver');
  await new Promise((resolve, reject) => {
    const output = createWriteStream(outputFile, { flags: 'wx' }),
      archive = archiver('zip', { zlib: { level: 6 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.on('warning', reject);
    archive.pipe(output);
    archive.directory(appDirectory, 'win-unpacked');
    archive.finalize().catch(reject);
  });
}
export async function verifyPortableArchive(file, manifest) {
  const zip = await JSZip.loadAsync(await fs.readFile(file));
  if (Object.values(zip.files).filter((f) => !f.dir).length !== manifest.entries.length)
    throw Error('PUBLISH_ARCHIVE_CONTENTS_MISMATCH');
  for (const entry of manifest.entries) {
    const member = zip.file('win-unpacked/' + entry.path);
    if (!member) throw Error('PUBLISH_ARCHIVE_CONTENTS_MISMATCH');
    const hash = createHash('sha256');
    await new Promise((resolve, reject) => {
      member
        .nodeStream()
        .on('data', (data) => hash.update(data))
        .on('error', reject)
        .on('end', resolve);
    });
    if (hash.digest('hex') !== entry.sha256) throw Error('PUBLISH_ARCHIVE_HASH_MISMATCH');
  }
}
export function validateTag(tag) {
  if (!/^v\d+\.\d+\.\d+-local\.\d{8}\.\d+$/.test(tag ?? ''))
    throw Error('TAG_REQUIRED: v0.1.0-local.YYYYMMDD.N');
  return tag;
}
export function requireVerified(build, verification) {
  if (
    build.releaseMode !== 'local' ||
    build.build !== 'PASS' ||
    build.tests?.existingTests !== 122 ||
    build.tests?.status !== 'PASS'
  )
    throw Error('PUBLISH_BUILD_NOT_VERIFIED');
  if (
    verification.integrity !== 'PASS' ||
    verification.applicationLaunch !== 'PASS' ||
    verification.exportVerification !== 'PASS' ||
    verification.restartVerification !== 'PASS' ||
    verification.policyChanged !== false
  )
    throw Error('PUBLISH_EXE_NOT_VERIFIED');
  if (
    !/^[a-f0-9]{64}$/.test(verification.beforeSHA256 ?? '') ||
    verification.beforeSHA256 !== verification.afterSHA256
  )
    throw Error('PUBLISH_EXE_HASH_MISMATCH');
  const formats = verification.results
    .filter((r) => r.check === 'export' && r.status === 'PASS')
    .map((r) => r.format);
  for (const format of [
    'pptx',
    'web',
    'tokens',
    'project',
    'after-effects',
    'blender',
    'mp4',
    'webm',
    'png-sequence',
  ])
    if (!formats.includes(format)) throw Error('PUBLISH_EXPORT_MISSING');
}
export function publicReport(
  value,
  roots = [projectDir, path.dirname(projectDir), process.env.USERPROFILE].filter(Boolean),
) {
  if (typeof value === 'string') {
    for (const root of roots)
      value = value
        .split(root)
        .join('${LOCAL_PATH}')
        .split(root.replaceAll('\\', '/'))
        .join('${LOCAL_PATH}');
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => publicReport(v, roots));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !/^(password|privateKey|clientSecret|accessToken|refreshToken|token|authorization)$/i.test(
              key,
            ),
        )
        .map(([k, v]) => [k, publicReport(v, roots)]),
    );
  return value;
}
async function command(executable, args, { cwd = projectDir, ...options } = {}) {
  const env = localEnvironment();
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'never';
  // gh can use its OS credential store or an ephemeral process-only token. Never write it.
  if (process.env.GH_TOKEN) env.GH_TOKEN = process.env.GH_TOKEN;
  const result = await runLocalTool(executable, args, { cwd, env, timeoutMs: 1800000, ...options });
  if (result.code !== 0) throw Error('PUBLISH_TOOL_FAILED: ' + path.basename(executable));
  return result.stdout.trim();
}
const git = (args) => command('git.exe', ['-c', 'safe.directory=' + projectDir, ...args]);
const gh = (args) => command('gh.exe', args);
export async function assertTrackedPayload(manifest, appDirectory) {
  const files = await listLocalFiles(appDirectory);
  if (files.length !== manifest.entries.length) throw Error('PUBLISH_PAYLOAD_CHANGED');
  for (const entry of manifest.entries) {
    const file = path.resolve(appDirectory, entry.path),
      rel = path.relative(appDirectory, file);
    if (
      !rel ||
      rel.startsWith('..') ||
      path.isAbsolute(rel) ||
      (await sha256(file)) !== entry.sha256
    )
      throw Error('PUBLISH_PAYLOAD_CHANGED');
  }
}
export async function publishLocal(tag) {
  validateTag(tag);
  const origin = await git(['remote', 'get-url', 'origin']);
  if (
    ![
      'https://github.com/' + repository + '.git',
      'https://github.com/' + repository,
      'git@github.com:' + repository + '.git',
    ].includes(origin)
  )
    throw Error('PUBLISH_WRONG_REMOTE');
  if (await git(['status', '--porcelain'])) throw Error('PUBLISH_COMMIT_CHANGES_FIRST');
  if ((await git(['branch', '--show-current'])) !== 'main') throw Error('PUBLISH_MAIN_REQUIRED');
  const commit = await git(['rev-parse', 'HEAD']);
  if (await git(['ls-remote', '--tags', 'origin', 'refs/tags/' + tag]))
    throw Error('PUBLISH_TAG_ALREADY_EXISTS');
  const releases = JSON.parse(
    await gh(['release', 'list', '--repo', repository, '--limit', '100', '--json', 'tagName']),
  );
  if (releases.some((r) => r.tagName === tag)) throw Error('PUBLISH_RELEASE_ALREADY_EXISTS');
  console.log('PUBLISH: build and final EXE verification');
  const build = await buildLocalRelease();
  const verification = await verifyLocalRelease({ buildDirectory: build.buildDirectory });
  requireVerified(build, verification);
  if ((await git(['rev-parse', 'HEAD'])) !== commit || (await git(['status', '--porcelain'])))
    throw Error('PUBLISH_SOURCE_CHANGED_DURING_BUILD');
  const inventory = JSON.parse(
    await fs.readFile(path.join(build.buildDirectory, 'local-inventory.json'), 'utf8'),
  );
  await assertTrackedPayload(inventory, build.appDirectory);
  const output = path.join(localRoot, 'releases', tag);
  await fs.mkdir(output, { recursive: true });
  const portable = 'Design-Studio-Windows-x64-LOCAL.zip',
    source = 'Design-Studio-source.zip';
  console.log('PUBLISH: package verified executable and source commit');
  // No archive updating: old release bytes are never mixed into this new archive.
  if (await fs.stat(path.join(output, portable)).catch(() => null))
    throw Error('PUBLISH_OUTPUT_ALREADY_EXISTS');
  await archivePortable(build.appDirectory, path.join(output, portable));
  await verifyPortableArchive(path.join(output, portable), inventory);
  await git([
    'archive',
    '--format=zip',
    '--prefix=Design-Studio/',
    '--output=' + path.join(output, source),
    commit,
  ]);
  await writeJson(
    path.join(output, 'verification.json'),
    publicReport({ sourceCommit: commit, build, verification }),
  );
  await writeJson(path.join(output, 'local-inventory.json'), publicReport(inventory));
  const assets = [portable, source, 'verification.json', 'local-inventory.json'];
  const manifest = {
    schemaVersion: 1,
    repository,
    tag,
    sourceCommit: commit,
    releaseMode: 'LOCAL',
    productionSigned: false,
    executableSHA256: verification.afterSHA256,
    createdAt: new Date().toISOString(),
    assets: [],
  };
  for (const name of assets)
    manifest.assets.push({
      name,
      bytes: (await fs.stat(path.join(output, name))).size,
      sha256: await sha256(path.join(output, name)),
    });
  await writeJson(path.join(output, 'release-manifest.json'), manifest);
  assets.push('release-manifest.json');
  const lines = [];
  for (const name of assets) lines.push((await sha256(path.join(output, name))) + '  ' + name);
  await fs.writeFile(path.join(output, 'SHA256SUMS.txt'), lines.join('\n') + '\n');
  assets.push('SHA256SUMS.txt');
  const notes = `Windows 개인 사용용 LOCAL 빌드입니다. 공개 코드 서명은 적용하지 않았습니다.\n\n- portable ZIP을 모두 풀고 win-unpacked/Design Studio.exe를 실행하세요. EXE만 복사하지 마세요.\n- 소스 커밋: ${commit}\n- 실제 동일 EXE: UI, 저장/로드, 9종 내보내기, PPT 960×540pt, 종료/재시작/이력 복원 PASS\n- 실행 전후 EXE SHA256 동일: ${verification.afterSHA256}\n- 전체 테스트 ${build.tests.totalPassed} PASS, 선택 시험 ${build.tests.skipped}개 미실행. 기존 Production 122개 모두 PASS.\n- Windows 보안 정책 변경 없음. Production 서명 파이프라인은 보존했습니다.\n- 이전 릴리스는 그대로 보존합니다. 해시·무결성·실행 검증 보고서를 함께 제공합니다.\n`;
  const notesFile = path.join(output, 'release-notes.md');
  await fs.writeFile(notesFile, notes);
  await assertProductionPreserved();
  console.log('PUBLISH: push source and upload a draft release');
  await git(['push', '-u', 'origin', 'main']);
  const remote = await git(['ls-remote', 'origin', 'refs/heads/main']);
  if (!remote.startsWith(commit + '\t')) throw Error('PUBLISH_REMOTE_COMMIT_MISMATCH');
  await gh([
    'release',
    'create',
    tag,
    ...assets.map((a) => path.join(output, a)),
    '--repo',
    repository,
    '--target',
    commit,
    '--draft',
    '--title',
    'Design Studio ' + tag + ' · Windows LOCAL',
    '--notes-file',
    notesFile,
  ]);
  const remoteRelease = JSON.parse(await gh(['api', `repos/${repository}/releases/tags/${tag}`]));
  for (const name of assets) {
    const actual = remoteRelease.assets.find((a) => a.name === name),
      file = path.join(output, name),
      expected = await sha256(file);
    if (!actual || actual.size !== (await fs.stat(file)).size)
      throw Error('PUBLISH_REMOTE_ASSET_MISMATCH');
    if (actual.digest) {
      if (actual.digest !== 'sha256:' + expected) throw Error('PUBLISH_REMOTE_HASH_MISMATCH');
    } else {
      const downloaded = path.join(output, 'remote-check');
      await fs.mkdir(downloaded, { recursive: true });
      await gh([
        'release',
        'download',
        tag,
        '--repo',
        repository,
        '--pattern',
        name,
        '--dir',
        downloaded,
      ]);
      if ((await sha256(path.join(downloaded, name))) !== expected)
        throw Error('PUBLISH_REMOTE_HASH_MISMATCH');
    }
  }
  await gh(['release', 'edit', tag, '--repo', repository, '--draft=false', '--latest']);
  const final = JSON.parse(await gh(['api', `repos/${repository}/releases/latest`]));
  if (final.tag_name !== tag || final.draft) throw Error('PUBLISH_LATEST_NOT_UPDATED');
  await git(['fetch', 'origin', 'tag', tag]);
  await writeJson(path.join(output, 'publication.json'), {
    url: final.html_url,
    sourceCommit: commit,
    tag,
    assets: final.assets.map((a) => ({
      name: a.name,
      url: a.browser_download_url,
      size: a.size,
      digest: a.digest,
    })),
    verified: true,
  });
  console.log(JSON.stringify({ published: final.html_url, sourceCommit: commit, output }, null, 2));
  return final.html_url;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const i = process.argv.indexOf('--tag');
    await publishLocal(i < 0 ? undefined : process.argv[i + 1]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
