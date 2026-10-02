import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import JSZip from 'jszip';
import { sha256, writeJson } from './local-common.mjs';

export const localFormats = [
  'pptx',
  'web',
  'tokens',
  'project',
  'after-effects',
  'blender',
  'mp4',
  'webm',
  'png-sequence',
];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function launchLocalApplication(exe, root, round) {
  const output = path.join(root, round);
  await fs.mkdir(output, { recursive: true });
  const env = {
    STUDIO_DATA_DIR: path.join(root, 'data'),
    STUDIO_VERIFY_OUTPUT: output,
    STUDIO_PORT: '0',
    PATH: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
  };
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA'])
    if (process.env[key]) env[key] = process.env[key];
  const child = spawn(exe, [], { env, shell: false, windowsHide: true, stdio: 'ignore' });
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
  async function close() {
    await fs.writeFile(path.join(output, 'finish'), 'done');
    let timer;
    try {
      return await Promise.race([
        completion,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error('LOCAL_NORMAL_SHUTDOWN_TIMEOUT')), 15000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  try {
    for (let attempt = 0; attempt < 120; attempt++) {
      if (spawnError) throw spawnError;
      if (closed) throw Error('LOCAL_EXE_EXITED_BEFORE_UI_READY');
      const failure = await fs.readFile(path.join(output, 'error.json'), 'utf8').catch((e) => {
        if (e.code !== 'ENOENT') throw e;
        return null;
      });
      if (failure) throw Error('LOCAL_UI_LOAD_FAILED');
      const text = await fs.readFile(path.join(output, 'ready.json'), 'utf8').catch((e) => {
        if (e.code !== 'ENOENT') throw e;
        return null;
      });
      if (text) {
        const ready = JSON.parse(text),
          url = new URL(ready.url);
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1')
          throw Error('LOCAL_INVALID_API_ORIGIN');
        return { ready, close, output };
      }
      await pause(300);
    }
    throw Error('LOCAL_UI_READY_TIMEOUT');
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
  if (!response.ok) throw Error('LOCAL_API_FAILED: ' + response.status);
  return response.json();
}
export async function validateLocalOutput(file, format) {
  const bytes = await fs.readFile(file.path);
  if (!bytes.length) throw Error('LOCAL_EMPTY_EXPORT');
  if (/\.(zip|pptx|designstudio)$/i.test(file.name)) {
    const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
    if (format === 'pptx' && file.name.endsWith('.pptx')) {
      const xml = await zip.file('ppt/presentation.xml')?.async('string');
      if (!/<p:sldSz[^>]*cx="12192000"[^>]*cy="6858000"/.test(xml || ''))
        throw Error('LOCAL_PPT_DIMENSIONS_INVALID');
    }
  }
  if (/\.json$/i.test(file.name)) JSON.parse(bytes.toString('utf8'));
  if (/\.mp4$/i.test(file.name) && bytes.subarray(4, 8).toString() !== 'ftyp')
    throw Error('LOCAL_MP4_INVALID');
  if (/\.webm$/i.test(file.name) && bytes.subarray(0, 4).toString('hex') !== '1a45dfa3')
    throw Error('LOCAL_WEBM_INVALID');
  return { name: file.name, path: file.path, bytes: bytes.length, sha256: await sha256(file.path) };
}
export async function verifyLocalRuntime({
  exe,
  root,
  launch = launchLocalApplication,
  request = api,
}) {
  const report = {
    applicationLaunch: 'FAIL',
    exportVerification: 'NOT_RUN',
    restartVerification: 'NOT_RUN',
    results: [],
    beforeSHA256: await sha256(exe),
  };
  let projectId;
  try {
    const first = await launch(exe, root, 'first');
    report.applicationLaunch = 'PASS';
    report.results.push({ check: 'ui-ready', ...first.ready });
    try {
      if (!(await request(first.ready.url, '/health')).ok) throw Error('LOCAL_HEALTH_FAILED');
      let project = await request(first.ready.url, '/projects', 'POST', {
        name: 'LOCAL 동일 EXE 기능 검증',
      });
      projectId = project.id;
      project.motion.width = 640;
      project.motion.height = 360;
      project.motion.scenes = [{ ...project.motion.scenes[0], durationFrames: 30 }];
      project = await request(first.ready.url, '/projects/' + projectId, 'PUT', {
        project,
        baseRevision: project.revision,
      });
      const loaded = await request(first.ready.url, '/projects/' + projectId);
      if (loaded.id !== projectId || loaded.revision !== project.revision)
        throw Error('LOCAL_PROJECT_SAVE_LOAD_FAILED');
      report.results.push({ check: 'project-create-save-load', revision: project.revision });
      report.exportVerification = 'FAIL';
      for (const format of localFormats) {
        const start = Date.now();
        let job = await request(first.ready.url, `/projects/${projectId}/export`, 'POST', {
          format,
        });
        while (['queued', 'running'].includes(job.status)) {
          await pause(350);
          job = await request(first.ready.url, '/jobs/' + job.id);
          if (Date.now() - start > 120000) throw Error('LOCAL_EXPORT_TIMEOUT: ' + format);
        }
        if (job.status !== 'completed' || !job.files?.length)
          throw Error('LOCAL_EXPORT_FAILED: ' + format);
        const files = [];
        for (const file of job.files) files.push(await validateLocalOutput(file, format));
        report.results.push({ check: 'export', format, status: 'PASS', files });
        console.log('LOCAL_EXPORT_OK ' + format);
      }
      report.exportVerification = 'PASS';
    } finally {
      const code = await first.close();
      report.results.push({ check: 'normal-shutdown', exitCode: code });
      if (code !== 0) throw Error('LOCAL_ABNORMAL_SHUTDOWN');
    }
    report.restartVerification = 'FAIL';
    const reopened = await launch(exe, root, 'reopen');
    try {
      const project = await request(reopened.ready.url, '/projects/' + projectId),
        jobs = await request(reopened.ready.url, '/jobs?projectId=' + projectId);
      if (project.revision < 2 || jobs.filter((j) => j.status === 'completed').length !== 9)
        throw Error('LOCAL_RESTART_HISTORY_FAILED');
      report.results.push({
        check: 'restart-project-and-history',
        revision: project.revision,
        completedJobs: 9,
      });
    } finally {
      if ((await reopened.close()) !== 0) throw Error('LOCAL_RESTART_SHUTDOWN_FAILED');
    }
    report.restartVerification = 'PASS';
    return report;
  } catch (error) {
    throw Object.assign(error, { runtimeReport: report });
  } finally {
    report.afterSHA256 = await sha256(exe);
    await writeJson(path.join(root, 'runtime-report.json'), report);
    if (report.afterSHA256 !== report.beforeSHA256)
      throw Object.assign(Error('LOCAL_EXE_CHANGED_DURING_VERIFICATION'), {
        runtimeReport: report,
      });
  }
}
