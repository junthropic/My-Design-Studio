import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import JSZip from 'jszip';
import { verifyReleaseManifest } from './signing-pipeline.mjs';
import { inspectSignature, discoverSignTool } from './signature-evidence.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}
const appDirectory = path.resolve(
  option('--app-dir', path.join(projectRoot, 'release-signed/win-unpacked')),
);
const installer = path.resolve(
  option('--installer', path.join(appDirectory, '../Design Studio Setup 0.1.0.exe')),
);
const checkOnly = process.argv.includes('--check');
const manifestPath = path.resolve(
  option('--manifest', path.join(appDirectory, '../signing-manifest.json')),
);
const root = path.join(projectRoot, 'work', 'signed-release-verification-' + Date.now());
const exe = path.join(appDirectory, 'Design Studio.exe');
const results = [],
  logs = [];
const report = {
  status: 'running',
  executable: exe,
  installer,
  startedAt: new Date().toISOString(),
  results,
};
await fs.mkdir(root, { recursive: true });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function launch(round) {
  const output = path.join(root, round);
  await fs.mkdir(output);
  const env = {
    STUDIO_DATA_DIR: path.join(root, 'data'),
    STUDIO_VERIFY_OUTPUT: output,
    STUDIO_PORT: '0',
    PATH: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
  };
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA'])
    if (process.env[key]) env[key] = process.env[key];
  const child = spawn(exe, [], {
    env,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let closed = false,
    spawnError;
  const completion = new Promise((resolve) => {
    child.once('error', (error) => {
      spawnError = error;
      closed = true;
      resolve(null);
    });
    child.once('close', (code) => {
      closed = true;
      resolve(code);
    });
  });
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));
  const close = async () => {
    await fs.writeFile(path.join(output, 'finish'), 'done');
    const code = await Promise.race([completion, pause(15000).then(() => 'timeout')]);
    if (code === 'timeout')
      throw new Error(
        '검증용 앱이 정상 종료되지 않았습니다. 자동으로 다른 앱을 종료하지 않습니다.',
      );
    return code;
  };
  try {
    for (let attempt = 0; attempt < 120; attempt++) {
      if (spawnError) throw spawnError;
      if (closed) throw new Error('Final EXE exited before its UI was ready.');
      try {
        const error = JSON.parse(await fs.readFile(path.join(output, 'error.json'), 'utf8'));
        throw new Error(error.error || error.message || 'Desktop launch failed');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      try {
        const ready = JSON.parse(await fs.readFile(path.join(output, 'ready.json'), 'utf8'));
        if (new URL(ready.url).hostname !== '127.0.0.1') throw new Error('Unexpected API origin');
        return { ready, output, close };
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await pause(300);
    }
    throw new Error('Final EXE readiness timed out.');
  } catch (error) {
    if (!closed) await close().catch(() => {});
    throw error;
  }
}
async function api(origin, route, method = 'GET', body) {
  const response = await fetch(origin + '/api' + route, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-studio-request': '1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`API ${method} ${route}: ${response.status}`);
  return response.json();
}
try {
  const signtoolPath = await discoverSignTool({ explicitPath: process.env.STUDIO_SIGNTOOL_PATH });
  if (!signtoolPath) throw new Error('Final verification requires Microsoft SignTool.');
  const signatures = await verifyReleaseManifest({
    appDirectory,
    installer,
    manifestPath,
    inspect: (file, options) => inspectSignature(file, { ...options, signtoolPath }),
  });
  await fs.writeFile(path.join(root, 'signatures.json'), JSON.stringify(signatures, null, 2));
  results.push({
    check: 'authenticode-and-signtool-and-manifest',
    passed: true,
    files: signatures.FileCount,
  });
  const expectedHash = createHash('sha256')
    .update(await fs.readFile(exe))
    .digest('hex');
  report.executableSHA256 = expectedHash;
  if (checkOnly) report.status = 'signatures-passed-launch-not-requested';
  else {
    const first = await launch('first');
    let projectId;
    try {
      results.push({ check: 'desktop-ready', ...first.ready });
      const health = await api(first.ready.url, '/health');
      if (!health.ok) throw new Error('Application health check failed');
      let project = await api(first.ready.url, '/projects', 'POST', {
        name: '서명된 최종 EXE 검증',
      });
      projectId = project.id;
      project.motion.width = 640;
      project.motion.height = 360;
      project.motion.scenes = [{ ...project.motion.scenes[0], durationFrames: 30 }];
      project = await api(first.ready.url, '/projects/' + project.id, 'PUT', {
        project,
        baseRevision: project.revision,
      });
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
      ]) {
        const start = Date.now();
        let job = await api(first.ready.url, `/projects/${project.id}/export`, 'POST', { format });
        while (['queued', 'running'].includes(job.status)) {
          await pause(350);
          job = await api(first.ready.url, '/jobs/' + job.id);
          if (Date.now() - start > 120000) throw new Error('Export timeout: ' + format);
        }
        if (job.status !== 'completed')
          throw new Error(`Export failed ${format}: ${job.error || job.message}`);
        for (const file of job.files)
          if ((await fs.stat(file.path)).size === 0) throw new Error('Empty result file');
        if (format === 'pptx') {
          const pptx = job.files.find((f) => f.name.endsWith('.pptx'));
          const zip = await JSZip.loadAsync(await fs.readFile(pptx.path), { checkCRC32: true });
          const xml = await zip.file('ppt/presentation.xml').async('string');
          if (!/<p:sldSz[^>]*cx="12192000"[^>]*cy="6858000"/.test(xml))
            throw new Error('Final EXE PPT does not use 960×540pt');
        }
        results.push({
          check: 'export',
          format,
          status: job.status,
          files: job.files,
          elapsedMs: Date.now() - start,
        });
        console.log('EXPORT_OK ' + format);
      }
    } finally {
      const exitCode = await first.close();
      results.push({ check: 'normal-shutdown', exitCode });
      if (exitCode !== 0) throw new Error('Desktop did not close normally');
    }
    const reopen = await launch('reopen');
    try {
      const project = await api(reopen.ready.url, '/projects/' + projectId),
        jobs = await api(reopen.ready.url, '/jobs?projectId=' + projectId);
      if (project.revision < 2 || jobs.filter((j) => j.status === 'completed').length !== 9)
        throw new Error('Project or job history was not restored');
      results.push({ check: 'restart-persistence', revision: project.revision, completedJobs: 9 });
    } finally {
      if ((await reopen.close()) !== 0) throw new Error('Reopened desktop did not close normally');
    }
    if (
      createHash('sha256')
        .update(await fs.readFile(exe))
        .digest('hex') !== expectedHash
    )
      throw new Error('EXE changed during verification');
    report.status = 'passed';
  }
} catch (error) {
  report.status = error.report ? 'blocked-signature-prerequisite' : 'failed';
  report.error = String(error.message || error);
  if (error.code) report.errorCode = error.code;
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(root, 'process.log'), logs.join(''));
  console.log(
    JSON.stringify(
      { status: report.status, error: report.error, report: path.join(root, 'report.json') },
      null,
      2,
    ),
  );
}
