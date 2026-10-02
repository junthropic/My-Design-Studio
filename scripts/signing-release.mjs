import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageSigned, signingChildEnvironment } from './signing-config.mjs';
import { runHidden } from './windows-verification.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  await packageSigned();
  // Final app validation has no reason to inherit any signing credential.
  const original = signingChildEnvironment(),
    env = {};
  for (const key of [
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'PATH',
    'USERPROFILE',
    'LOCALAPPDATA',
    'STUDIO_SIGNTOOL_PATH',
  ])
    if (original[key]) env[key] = original[key];
  const result = await runHidden(
    process.execPath,
    [path.join(root, 'scripts/verify-windows-release.mjs')],
    { cwd: root, env },
  );
  if (result.code !== 0) throw Error('FINAL_VERIFICATION_FAILED');
  console.log(
    'Production signing and final EXE verification completed. See work/signed-release-verification-*/report.json.',
  );
} catch {
  console.error(
    'Production release stopped. No successful release is declared; inspect the signing manifest and verification report.',
  );
  process.exitCode = 1;
}
