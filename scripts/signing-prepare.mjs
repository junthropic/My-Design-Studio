import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTargetManifest, readOwnershipPolicy } from './signing-pipeline.mjs';
import { inspectSignature, discoverSignTool } from './signature-evidence.mjs';
import { runHidden } from './windows-verification.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportDirectory = path.join(project, 'work', 'signing-preparation');
await fs.mkdir(reportDirectory, { recursive: true });
const metadata = JSON.parse(await fs.readFile(path.join(project, 'package.json'), 'utf8'));
const appDirectory = path.join(project, 'release', 'win-unpacked');
const installer = path.join(
  project,
  'release',
  `${metadata.build.productName} Setup ${metadata.version}.exe`,
);
try {
  const signtoolPath = await discoverSignTool({ explicitPath: process.env.STUDIO_SIGNTOOL_PATH });
  const manifest = await createTargetManifest({
    appDirectory,
    installer,
    policy: await readOwnershipPolicy(),
    inspect: (file, options) => inspectSignature(file, { ...options, signtoolPath }),
    outputPath: path.join(reportDirectory, 'signing-target-manifest.json'),
  });
  const result = {
    mode: 'preparation',
    actualSigningAttempted: false,
    policyChanged: false,
    manifestFileCount: manifest.entries.length,
    mock: 'not-requested',
    productionGate: 'not-requested',
  };
  if (process.argv.includes('--mock-and-check')) {
    // Mocks receive only basic system process variables, never production credentials.
    const env = {};
    for (const key of [
      'SystemRoot',
      'WINDIR',
      'TEMP',
      'TMP',
      'PATH',
      'USERPROFILE',
      'LOCALAPPDATA',
      'STUDIO_NSIS_FIXTURE_COMPILER',
    ])
      if (process.env[key]) env[key] = process.env[key];
    const tests = await runHidden(
      process.execPath,
      [
        path.join(project, 'node_modules/vitest/vitest.mjs'),
        'run',
        '--configLoader',
        'runner',
        'tests/signing-config.test.ts',
        'tests/release-verification.test.mjs',
        'tests/signing-pipeline.integration.test.mjs',
        'tests/signing-providers.test.mjs',
        'tests/signature-evidence.test.mjs',
        'tests/nsis-safe-extraction.test.mjs',
        'tests/signing-build.test.mjs',
        'tests/hidden-build.test.mjs',
        '--reporter=json',
        `--outputFile=${path.join(reportDirectory, 'mock-tests.json')}`,
      ],
      { cwd: project, env },
    );
    if (tests.code !== 0) throw new Error('MOCK_TESTS_FAILED');
    result.mock = 'passed';
    // This entry point NEVER signs, even if credentials become available later.
    try {
      const { default: check } = await import('./signing-config.mjs');
      await check();
      result.productionGate = 'credentials-ready; explicit signing command required';
    } catch {
      result.productionGate = 'stopped-before-signing; production credential or tools unavailable';
      process.exitCode = 2;
    }
  }
  await fs.writeFile(
    path.join(reportDirectory, 'preparation-result.json'),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify({ ...result, reportDirectory }, null, 2));
} catch {
  console.error('Signing preparation failed; no production signing was attempted.');
  process.exitCode = 1;
}
