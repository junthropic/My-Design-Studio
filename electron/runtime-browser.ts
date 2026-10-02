import { createHash } from 'node:crypto';
import {
  readdirSync,
  lstatSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import path from 'node:path';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function files(root: string): string[] {
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('BROWSER_CACHE_INVALID_ROOT');
  const output: string[] = [];
  function visit(dir: string) {
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name),
        entry = lstatSync(file);
      if (entry.isSymbolicLink()) throw Error('BROWSER_CACHE_LINK_REJECTED');
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) output.push(path.relative(root, file));
    }
  }
  visit(root);
  return output.sort();
}
// Chromium 134's GPU process writes debug.log next to its EXE even with log-file set.
// Run a byte-verified copy from private app data; never mutate the delivered runtime.
export function prepareRuntimeBrowser(source: string, cacheRoot: string): string {
  const entries = files(source)
    .filter((name) => name !== 'debug.log')
    .map((name) => ({ name, sha256: hash(readFileSync(path.join(source, name))) }));
  if (!entries.some((e) => e.name === 'chrome-headless-shell.exe'))
    throw Error('BROWSER_RUNTIME_MISSING');
  const fingerprint = hash(Buffer.from(JSON.stringify(entries)));
  mkdirSync(cacheRoot, { recursive: true });
  if (lstatSync(cacheRoot).isSymbolicLink()) throw Error('BROWSER_CACHE_LINK_REJECTED');
  // Keep executable paths below legacy CreateProcess limits in deep Korean workspaces.
  // The directory is an abbreviated key; every cached file is still compared with full SHA256.
  const destination = path.join(cacheRoot, fingerprint.slice(0, 32));
  mkdirSync(destination, { recursive: true });
  for (const relative of files(destination))
    if (relative !== 'debug.log' && !entries.some((e) => e.name === relative))
      throw Error('BROWSER_CACHE_UNEXPECTED_FILE');
  for (const entry of entries) {
    const target = path.join(destination, entry.name);
    if (existsSync(target)) {
      if (!lstatSync(target).isFile() || hash(readFileSync(target)) !== entry.sha256)
        throw Error('BROWSER_CACHE_HASH_MISMATCH');
    } else {
      const bytes = readFileSync(path.join(source, entry.name));
      if (hash(bytes) !== entry.sha256) throw Error('BROWSER_SOURCE_CHANGED');
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, bytes, { flag: 'wx' });
      if (hash(readFileSync(target)) !== entry.sha256) throw Error('BROWSER_CACHE_COPY_FAILED');
    }
  }
  return path.join(destination, 'chrome-headless-shell.exe');
}
