import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire, syncBuiltinESMExports } from 'node:module';

// Remotion 4.0.363 omits windowsHide on some browser/compositor cleanup calls.
// Scope the option to this async render job; unrelated app processes are unchanged.
const hiddenScope = new AsyncLocalStorage<boolean>();
let installed = false;
export async function withHiddenWindowsProcesses<T>(run: () => Promise<T>): Promise<T> {
  if (process.platform !== 'win32') return run();
  if (!installed) {
    const require = createRequire(import.meta.url),
      child = require('node:child_process');
    for (const name of [
      'spawn',
      'spawnSync',
      'exec',
      'execSync',
      'execFile',
      'execFileSync',
      'fork',
    ]) {
      const original = child[name];
      child[name] = function (...args: unknown[]) {
        if (hiddenScope.getStore()) {
          const index = name === 'exec' || name === 'execSync' ? 1 : Array.isArray(args[1]) ? 2 : 1;
          const existing = args[index];
          const options = {
            ...(existing && typeof existing === 'object' ? existing : {}),
            windowsHide: true,
          };
          if (typeof existing === 'function') args.splice(index, 0, options);
          else args[index] = options;
        }
        return Reflect.apply(original, this, args);
      };
    }
    syncBuiltinESMExports();
    installed = true;
  }
  return hiddenScope.run(true, run);
}
