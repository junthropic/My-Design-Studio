import { it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { promisify } from 'node:util';
it('hides nested build processes without breaking promisified stdout/stderr', async () => {
  const calls = [];
  const cp = Object.fromEntries(
    ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync'].map((name) => [
      name,
      (...args) => {
        calls.push([name, args]);
        if (typeof args.at(-1) === 'function') args.at(-1)(null, 'stdout', 'stderr');
        return { pid: 42 };
      },
    ]),
  );
  vm.runInNewContext(await readFile('scripts/hidden-build.cjs', 'utf8'), {
    require: (id) =>
      id === 'node:child_process'
        ? cp
        : id === 'node:util'
          ? { promisify }
          : { syncBuiltinESMExports() {} },
  });
  cp.spawn('tool', ['arg'], { windowsHide: false, shell: true });
  cp.execFileSync('tool', [], { windowsHide: false });
  cp.exec('read-only fixture', { windowsHide: false }, () => {});
  expect(await promisify(cp.execFile)('tool', [])).toEqual({ stdout: 'stdout', stderr: 'stderr' });
  expect(await promisify(cp.exec)('fixture')).toEqual({ stdout: 'stdout', stderr: 'stderr' });
  for (const [name, args] of calls) {
    const options = args.find((a) => a && typeof a === 'object' && !Array.isArray(a));
    expect(options.windowsHide).toBe(true);
    if (name.startsWith('spawn') || name.startsWith('execFile')) expect(options.shell).toBe(false);
  }
});
