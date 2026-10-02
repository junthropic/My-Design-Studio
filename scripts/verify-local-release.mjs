import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  localRoot,
  inside,
  writeJson,
  sha256,
  assertProductionPreserved,
} from './local-common.mjs';
import { verifyLocalIntegrity } from './local-inventory.mjs';
import { readSmartAppControl, localLaunchDecision } from './local-policy.mjs';
import { verifyLocalRuntime } from './local-runtime-verification.mjs';

export async function verifyLocalRelease({
  buildDirectory,
  integrity = verifyLocalIntegrity,
  readSAC = readSmartAppControl,
  runtime = verifyLocalRuntime,
  preserve = assertProductionPreserved,
} = {}) {
  buildDirectory ??= JSON.parse(
    await fs.readFile(path.join(localRoot, 'latest.json'), 'utf8'),
  ).buildDirectory;
  buildDirectory = path.resolve(buildDirectory);
  if (!inside(path.join(localRoot, 'builds'), buildDirectory))
    throw Error('LOCAL_VERIFY_OUTSIDE_RELEASE_ROOT');
  const actual = await fs.realpath(buildDirectory);
  if (actual.toLowerCase() !== buildDirectory.toLowerCase())
    throw Error('LOCAL_VERIFY_LINK_REJECTED');
  const appDirectory = path.join(buildDirectory, 'win-unpacked'),
    exe = path.join(appDirectory, 'Design Studio.exe');
  const report = {
    releaseMode: 'local',
    build: 'PASS',
    integrity: 'FAIL',
    codeSigningRequired: false,
    productionCredentialRequired: false,
    unsignedFirstPartyAllowed: true,
    applicationLaunch: 'FAIL',
    exportVerification: 'NOT_RUN',
    restartVerification: 'NOT_RUN',
    launchAttempted: false,
    policyChanged: false,
    productionPipelineChanged: false,
  };
  const root = path.join(buildDirectory, 'work', 'verification-' + Date.now());
  await fs.mkdir(root, { recursive: true });
  try {
    const build = JSON.parse(
      await fs.readFile(path.join(buildDirectory, 'build-report.json'), 'utf8'),
    );
    if (build.build !== 'PASS') throw Error('LOCAL_BUILD_NOT_PASSED');
    report.productionPreserved = await preserve();
    report.smartAppControl = await readSAC();
    const manifest = await integrity({
      appDirectory,
      manifestPath: path.join(buildDirectory, 'local-inventory.json'),
    });
    report.integrity = 'PASS';
    report.beforeSHA256 = await sha256(exe);
    const main = manifest.executables.find((e) => e.path === 'Design Studio.exe');
    if (!main) throw Error('LOCAL_MAIN_INVENTORY_MISSING');
    const decision = localLaunchDecision(
      report.smartAppControl,
      main.signature.status === 'NotSigned',
    );
    if (!decision.launch) {
      Object.assign(report, decision);
      return report;
    }
    report.launchAttempted = true;
    try {
      Object.assign(report, await runtime({ exe, root }));
    } catch (error) {
      if (error.runtimeReport) Object.assign(report, error.runtimeReport);
      if (
        error.errno === 4551 ||
        String(error.code) === '4551' ||
        String(error.message).includes('4551')
      ) {
        report.applicationLaunch = 'BLOCKED_BY_SAC';
        report.status = 'BLOCKED_BY_SMART_APP_CONTROL';
        report.errorCode = 4551;
        report.errorName = 'ERROR_SYSTEM_INTEGRITY_POLICY_VIOLATION';
        report.basis = 'OS launch error';
      } else {
        report.status = 'FAILED';
        report.error = error.message;
      }
    }
    // Validate all delivered files again; successful exports do not waive integrity checks.
    await integrity({
      appDirectory,
      manifestPath: path.join(buildDirectory, 'local-inventory.json'),
    });
    return report;
  } catch (error) {
    report.integrity = 'FAIL';
    report.status = 'FAILED';
    report.error = error.message;
    return report;
  } finally {
    report.afterSHA256 = await sha256(exe).catch(() => null);
    if (report.beforeSHA256 && report.beforeSHA256 !== report.afterSHA256) {
      report.integrity = 'FAIL';
      report.error = 'LOCAL_EXE_HASH_CHANGED';
    }
    report.finishedAt = new Date().toISOString();
    await writeJson(path.join(root, 'verification.json'), report);
    await writeJson(path.join(buildDirectory, 'local-verification.json'), report);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const index = process.argv.indexOf('--build-dir');
  try {
    const report = await verifyLocalRelease({
      buildDirectory: index < 0 ? undefined : process.argv[index + 1],
    });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode =
      report.integrity !== 'PASS' ||
      report.status === 'FAILED' ||
      report.applicationLaunch === 'FAIL'
        ? 1
        : report.applicationLaunch === 'BLOCKED_BY_SAC'
          ? 3
          : 0;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
