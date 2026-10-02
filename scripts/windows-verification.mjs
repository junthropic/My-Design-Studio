import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function runHidden(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      ...options,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

export async function collectReleaseBinaries(directory) {
  const root = path.resolve(directory);
  const files = [];
  async function visit(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink())
        throw new Error('Release binaries must not contain symbolic links.');
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile() && /\.(exe|dll|node)$/i.test(entry.name)) files.push(full);
    }
  }
  await visit(root);
  return files.sort();
}

export async function verifyWindowsSignatures(paths, { reportPath } = {}) {
  if (process.platform !== 'win32')
    throw new Error('Windows signature verification requires Windows.');
  if (
    !Array.isArray(paths) ||
    paths.length === 0 ||
    paths.some((p) => typeof p !== 'string' || !path.isAbsolute(p))
  )
    throw new Error('Supply at least one absolute binary path.');
  const scratchRoot = path.join(projectRoot, 'work');
  await fs.mkdir(scratchRoot, { recursive: true });
  const scratch = await fs.mkdtemp(path.join(scratchRoot, 'signature-check-'));
  const input = path.join(scratch, 'files.json');
  const destination = path.resolve(reportPath || path.join(scratch, 'report.json'));
  await fs.writeFile(input, JSON.stringify({ files: paths }));
  const powershell = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  // A PowerShell 7 parent can pass incompatible module paths to Windows PowerShell 5.1.
  // Let the child construct its own standard module paths; no machine setting changes.
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  const result = await runHidden(
    powershell,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-File',
      path.join(projectRoot, 'scripts', 'check-windows-signatures.ps1'),
      '-FilesJsonPath',
      input,
      '-ReportPath',
      destination,
    ],
    { env },
  );
  let report;
  try {
    report = JSON.parse((await fs.readFile(destination, 'utf8')).replace(/^\uFEFF/, ''));
  } catch {
    throw new Error(
      'Windows signature audit failed: ' + (result.stderr || result.stdout).slice(0, 1500),
    );
  }
  if (result.code !== 0 || !report.Passed) {
    const error = new Error(
      `공인 RSA 서명 검증 실패: ${report.InvalidCount}개 무효·미서명, ${report.NonRsaCount}개 비RSA. 실행 검증은 시작하지 않았습니다.`,
    );
    error.report = report;
    error.reportPath = destination;
    throw error;
  }
  return report;
}
