import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { prepareRuntimeBrowser } from '../electron/runtime-browser';
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'studio-browser-')),
    source = path.join(root, 'source'),
    cache = path.join(root, 'cache');
  mkdirSync(source);
  writeFileSync(path.join(source, 'chrome-headless-shell.exe'), 'binary-fixture');
  return { root, source, cache };
}
it('copies identical bytes; runtime logs stay outside the immutable source and cache is reused', () => {
  const f = fixture();
  try {
    const exe = prepareRuntimeBrowser(f.source, f.cache);
    expect(readFileSync(exe, 'utf8')).toBe('binary-fixture');
    writeFileSync(path.join(path.dirname(exe), 'debug.log'), 'runtime log');
    expect(prepareRuntimeBrowser(f.source, f.cache)).toBe(exe);
    expect(existsSync(path.join(f.source, 'debug.log'))).toBe(false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
it('fails closed on cache byte changes', () => {
  const f = fixture();
  try {
    const exe = prepareRuntimeBrowser(f.source, f.cache);
    writeFileSync(exe, 'tampered');
    expect(() => prepareRuntimeBrowser(f.source, f.cache)).toThrow('HASH_MISMATCH');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
it('rejects injected cache components', () => {
  const f = fixture();
  try {
    const exe = prepareRuntimeBrowser(f.source, f.cache);
    writeFileSync(path.join(path.dirname(exe), 'injected.dll'), 'unexpected');
    expect(() => prepareRuntimeBrowser(f.source, f.cache)).toThrow('UNEXPECTED_FILE');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
