import path from 'node:path';
import { runLocalTool, localEnvironment } from './local-common.mjs';

export async function readSmartAppControl({ runner = runLocalTool, env = process.env } = {}) {
  const command =
    "$ErrorActionPreference='Stop'; $v=(Get-ItemProperty -LiteralPath 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy' -Name VerifiedAndReputablePolicyState).VerifiedAndReputablePolicyState; [pscustomobject]@{value=[int]$v} | ConvertTo-Json -Compress";
  const tool = path.join(
    env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  try {
    const result = await runner(
      tool,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
      { env: localEnvironment(env), timeoutMs: 15000 },
    );
    if (result.code !== 0) throw Error('SAC_READ_UNAVAILABLE');
    const { value } = JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
    return {
      state: value === 1 ? 'ON' : value === 0 ? 'OFF' : 'UNKNOWN',
      rawValue: value,
      detail: value === 2 ? 'evaluation' : null,
      readOnly: true,
      policyChanged: false,
    };
  } catch {
    return { state: 'UNKNOWN', rawValue: null, readOnly: true, policyChanged: false };
  }
}
export function localLaunchDecision(sac, unsigned) {
  if (sac.state === 'ON' && unsigned)
    return {
      launch: false,
      status: 'BLOCKED_BY_SMART_APP_CONTROL',
      applicationLaunch: 'BLOCKED_BY_SAC',
      errorCode: 4551,
      errorName: 'ERROR_SYSTEM_INTEGRITY_POLICY_VIOLATION',
      basis: 'read-only SAC preflight; no new OS launch attempted',
      actionRequired:
        'User must change Smart App Control manually if they want to execute this unsigned LOCAL build.',
    };
  return { launch: true, status: 'READY_TO_ATTEMPT' };
}
