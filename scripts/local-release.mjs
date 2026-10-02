import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  projectDir,
  localRoot,
  writeJson,
  localEnvironment,
  runLocalTool,
  assertProductionPreserved,
} from './local-common.mjs';
import { createLocalInventory } from './local-inventory.mjs';

export function checkBaselineTests(report, baseline) {
  let passed = 0;
  for (const expected of baseline.productionTests) {
    const test = report.testResults.find((r) =>
      r.name.replaceAll('\\', '/').endsWith('/' + expected.path),
    );
    if (
      !test ||
      test.assertionResults.length !== expected.passed ||
      test.assertionResults.some((t) => t.status !== 'passed')
    )
      throw Error('PRODUCTION_TEST_REGRESSION: ' + expected.path);
    passed += expected.passed;
  }
  if (!report.success || report.numFailedTests) throw Error('LOCAL_TEST_FAILURE');
  return {
    existingTests: passed,
    status: 'PASS',
    totalPassed: report.numPassedTests,
    skipped: report.numPendingTests,
  };
}
export async function buildLocalRelease({
  runner = runLocalTool,
  inventory = createLocalInventory,
  preserve = assertProductionPreserved,
  envSource = process.env,
} = {}) {
  await preserve();
  await fs.mkdir(path.join(localRoot, 'builds'), { recursive: true });
  const buildDirectory = await fs.mkdtemp(
    path.join(localRoot, 'builds', new Date().toISOString().replaceAll(/[:.]/g, '-') + '-'),
  );
  const report = {
    releaseMode: 'local',
    build: 'RUNNING',
    integrity: 'NOT_RUN',
    codeSigningRequired: false,
    productionCredentialRequired: false,
    installerRequired: false,
    signingProviderCalled: false,
    buildDirectory,
    steps: [],
  };
  const env = localEnvironment(envSource);
  env.STUDIO_LOCAL_BUILD_DIR = buildDirectory;
  const hidden = path.join(projectDir, 'scripts/hidden-build.cjs');
  env.NODE_OPTIONS = '--require ' + JSON.stringify(hidden);
  const fixture = path.resolve(
    projectDir,
    '../../work/builder-cache/nsis-3.0.4.1/nsis-3.0.4.1-1mx3n/Bin/makensis.exe',
  );
  if (!env.STUDIO_NSIS_FIXTURE_COMPILER && (await fs.stat(fixture).catch(() => null)))
    env.STUDIO_NSIS_FIXTURE_COMPILER = fixture;
  if (!env.ELECTRON_BUILDER_CACHE)
    env.ELECTRON_BUILDER_CACHE = path.resolve(projectDir, '../../work/builder-cache');
  const step = async (name, args) => {
    console.log('LOCAL_STEP ' + name);
    const result = await runner(process.execPath, ['--require', hidden, ...args], { env });
    report.steps.push({ name, exitCode: result.code, reason: result.reason });
    // Only credential-free child processes are logged; inherited signing/debug environment is removed.
    await fs.writeFile(
      path.join(buildDirectory, name + '.log'),
      result.stdout + '\n' + result.stderr,
    );
    if (result.code !== 0) throw Error('LOCAL_STEP_FAILED: ' + name);
  };
  try {
    await step('typecheck', ['node_modules/typescript/bin/tsc', '--noEmit']);
    // All browser integration tests must consume this source revision, including a fresh clone.
    await step('ui', ['node_modules/vite/bin/vite.js', 'build', '--configLoader', 'runner']);
    const testsPath = path.join(buildDirectory, 'tests.json');
    await step('tests', [
      'node_modules/vitest/vitest.mjs',
      'run',
      '--configLoader',
      'runner',
      '--exclude',
      'tests/ui.test.ts',
      '--reporter=json',
      '--outputFile=' + testsPath,
    ]);
    report.tests = checkBaselineTests(
      JSON.parse(await fs.readFile(testsPath, 'utf8')),
      JSON.parse(
        await fs.readFile(path.join(projectDir, 'scripts/production-baseline.local.json'), 'utf8'),
      ),
    );
    // Equivalent compilation stages to the existing build, without a visible shell or modifying it.
    await step('motion', ['node_modules/tsx/dist/cli.mjs', 'src/motion/build.ts', '--browser']);
    await step('server', [
      'node_modules/tsup/dist/cli-default.js',
      'server/index.ts',
      '--format',
      'esm',
      '--platform',
      'node',
      '--out-dir',
      'dist-server',
      '--external',
      'electron',
      '--external',
      '@remotion/renderer',
      '--external',
      '@remotion/bundler',
    ]);
    await step('electron', [
      'node_modules/tsup/dist/cli-default.js',
      'electron/main.ts',
      '--format',
      'cjs',
      '--platform',
      'node',
      '--out-dir',
      'dist-electron',
      '--external',
      'electron',
    ]);
    // The browser acceptance test consumes dist; run it against THIS build, not stale output.
    const acceptancePath = path.join(buildDirectory, 'ui-tests.json');
    await step('ui-acceptance', [
      'node_modules/vitest/vitest.mjs',
      'run',
      'tests/ui.test.ts',
      '--configLoader',
      'runner',
      '--reporter=json',
      '--outputFile=' + acceptancePath,
    ]);
    const acceptance = JSON.parse(await fs.readFile(acceptancePath, 'utf8'));
    if (
      !acceptance.success ||
      acceptance.numPassedTests !== 1 ||
      acceptance.numPendingTests ||
      acceptance.numFailedTests
    )
      throw Error('LOCAL_UI_ACCEPTANCE_FAILED');
    report.tests.totalPassed += acceptance.numPassedTests;
    await step('package', [
      'node_modules/electron-builder/cli.js',
      '--win',
      '--dir',
      '--config',
      'scripts/local-builder.config.mjs',
      '--publish',
      'never',
    ]);
    report.appDirectory = path.join(buildDirectory, 'win-unpacked');
    const manifest = await inventory({
      appDirectory: report.appDirectory,
      outputPath: path.join(buildDirectory, 'local-inventory.json'),
    });
    report.integrity = manifest.integrity;
    report.productionPreserved = await preserve();
    report.build = 'PASS';
    await writeJson(path.join(localRoot, 'latest.json'), { buildDirectory });
    return report;
  } catch (error) {
    report.build = 'FAIL';
    report.error = error.message;
    throw Object.assign(error, { report });
  } finally {
    await writeJson(path.join(buildDirectory, 'build-report.json'), report);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const report = await buildLocalRelease();
    console.log(JSON.stringify(report, null, 2));
    if (!process.argv.includes('--build')) {
      const { verifyLocalRelease } = await import('./verify-local-release.mjs');
      const verification = await verifyLocalRelease({ buildDirectory: report.buildDirectory });
      console.log(JSON.stringify(verification, null, 2));
      if (
        verification.applicationLaunch === 'FAIL' ||
        verification.integrity === 'FAIL' ||
        verification.status === 'FAILED'
      )
        process.exitCode = 1;
      else if (verification.applicationLaunch === 'BLOCKED_BY_SAC') process.exitCode = 3;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
