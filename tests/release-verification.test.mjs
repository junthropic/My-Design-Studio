import { afterEach, it, expect } from 'vitest';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  collectReleaseBinaries,
  verifyWindowsSignatures,
} from '../scripts/windows-verification.mjs';

const temporary = [];
afterEach(async () => {
  for (const directory of temporary.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const root = path.resolve('work');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'release-verification-test-'));
  temporary.push(directory);
  return directory;
}

it('discovers nested Windows executable code including native Node modules', async () => {
  const directory = await fixture(),
    nested = path.join(directory, 'resources', 'native');
  await mkdir(nested, { recursive: true });
  await writeFile(path.join(directory, 'Design Studio.EXE'), 'fixture');
  await writeFile(path.join(nested, 'renderer.exe'), 'fixture');
  await writeFile(path.join(nested, 'image.DLL'), 'fixture');
  await writeFile(path.join(nested, 'sharp.NODE'), 'fixture');
  await writeFile(path.join(nested, 'logo.png'), 'fixture');
  const names = (await collectReleaseBinaries(directory)).map((file) => path.basename(file)).sort();
  expect(names).toEqual(['Design Studio.EXE', 'image.DLL', 'renderer.exe', 'sharp.NODE']);
});

it.skipIf(process.platform !== 'win32')(
  'accepts an existing Microsoft RSA signature without running the inspected binary',
  async () => {
    const executable = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    const report = await verifyWindowsSignatures([executable]);
    expect(report.Passed).toBe(true);
    expect(report.FileCount).toBe(1);
    expect(report.Files[0].Status).toBe('Valid');
    expect(report.Files[0].Signer).toContain('Microsoft');
    expect(report.PolicyChanged).toBe(false);
  },
);

it.skipIf(process.platform !== 'win32')(
  'rejects unsigned input with a reviewable report before any app launch',
  async () => {
    const directory = await fixture(),
      file = path.join(directory, 'unsigned.exe');
    await writeFile(file, 'not an executable');
    const error = await verifyWindowsSignatures([file]).catch((error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.report.Passed).toBe(false);
    expect(error.report.InvalidCount).toBe(1);
    expect(error.report.PolicyChanged).toBe(false);
  },
);
