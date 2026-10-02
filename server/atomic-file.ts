import { renameSync } from 'node:fs';

// Windows may briefly deny atomic replacement while another process holds a read handle.
// Keep the destination intact: never unlink it to force replacement, and never mask permanent errors.
export function replaceFileWithRetry(
  source: string,
  destination: string,
  options: {
    rename?: typeof renameSync;
    wait?: (ms: number) => void;
    platform?: string;
  } = {},
) {
  const rename = options.rename ?? renameSync;
  const wait =
    options.wait ??
    ((ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
  for (let attempt = 0; ; attempt++) {
    try {
      rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        (options.platform ?? process.platform) !== 'win32' ||
        !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') ||
        attempt >= 6
      )
        throw error;
      wait(25 * 2 ** attempt);
    }
  }
}
