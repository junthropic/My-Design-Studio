import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

export const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const localRoot = path.resolve(projectDir, '../local');
export function releaseMode(value = 'local') {
  if (!['local', 'production'].includes(value)) throw Error('INVALID_RELEASE_MODE');
  return value;
}
export function inside(root, file) {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}
export async function sha256(file) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}
export async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}
export function localEnvironment(source = process.env) {
  const allowed = new Set([
    'systemroot',
    'comspec',
    'pathext',
    'windir',
    'temp',
    'tmp',
    'path',
    'userprofile',
    'appdata',
    'localappdata',
    'programfiles',
    'programfiles(x86)',
    'programw6432',
    'systemdrive',
    'allusersprofile',
    'commonprogramfiles',
    'commonprogramfiles(x86)',
    'npm_execpath',
    'electron_cache',
    'electron_builder_cache',
    'studio_nsis_fixture_compiler',
  ]);
  const env = Object.fromEntries(
    Object.entries(source).filter(
      ([key, value]) => allowed.has(key.toLowerCase()) && typeof value === 'string',
    ),
  );
  // No certificate discovery, cloud identity, private key, debug flags or user NODE_OPTIONS.
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  return env;
}
export function runLocalTool(
  file,
  args,
  { env = localEnvironment(), cwd = projectDir, timeoutMs = 600000 } = {},
) {
  return new Promise((resolve) => {
    let child,
      done = false;
    let stdout = '',
      stderr = '';
    const finish = (code, reason) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, reason });
    };
    const timer = setTimeout(() => {
      child?.kill();
      finish(null, 'OWNED_TOOL_TIMEOUT');
    }, timeoutMs);
    try {
      child = spawn(file, args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (data) => {
        stdout = (stdout + data.toString('utf8')).slice(-250000);
      });
      child.stderr.on('data', (data) => {
        stderr = (stderr + data.toString('utf8')).slice(-250000);
      });
      child.once('error', () => finish(null, 'OWNED_TOOL_START_FAILED'));
      child.once('close', (code) => finish(code));
    } catch {
      finish(null, 'OWNED_TOOL_START_FAILED');
    }
  });
}
export async function assertProductionPreserved({ artifactsRequired = false } = {}) {
  const baseline = JSON.parse(
    await fs.readFile(path.join(projectDir, 'scripts/production-baseline.local.json'), 'utf8'),
  );
  const checked = [];
  for (const [name, expected] of Object.entries(baseline.productionCode)) {
    if ((await sha256(path.join(projectDir, name))) !== expected)
      throw Error('PRODUCTION_BASELINE_CHANGED: ' + name);
    checked.push(name);
  }
  for (const [name, expected] of Object.entries(baseline.protectedArtifacts)) {
    const file = path.join(projectDir, name);
    try {
      if ((await sha256(file)) !== expected) throw Error('PRODUCTION_ARTIFACT_CHANGED: ' + name);
      checked.push(name);
    } catch (error) {
      if (error.code !== 'ENOENT' || artifactsRequired) throw error;
    }
  }
  const current = JSON.parse(await fs.readFile(path.join(projectDir, 'package.json'), 'utf8'));
  for (const [name, command] of Object.entries(baseline.originalScripts))
    if (current.scripts[name] !== command) throw Error('PRODUCTION_COMMAND_CHANGED: ' + name);
  return { passed: true, files: checked.length, productionPipelineChanged: false };
}
