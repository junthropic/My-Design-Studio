import { it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, renameSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { replaceFileWithRetry } from '../server/atomic-file';

it('replaces the snapshot after transient Windows sharing failures without deleting the old snapshot', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'studio-atomic-'));
  const source = path.join(dir, 'db.tmp'),
    destination = path.join(dir, 'db');
  writeFileSync(source, 'new');
  writeFileSync(destination, 'old');
  let attempts = 0;
  try {
    const wait = vi.fn(() => expect(readFileSync(destination, 'utf8')).toBe('old'));
    replaceFileWithRetry(source, destination, {
      platform: 'win32',
      wait,
      rename: (a, b) => {
        if (++attempts < 3) throw Object.assign(Error('sharing'), { code: 'EPERM' });
        renameSync(a, b);
      },
    });
    expect(readFileSync(destination, 'utf8')).toBe('new');
    expect(attempts).toBe(3);
    expect(wait.mock.calls).toEqual([[25], [50]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it('persistent sharing failure is bounded and remains an error', () => {
  const error = Object.assign(Error('locked'), { code: 'EACCES' }),
    rename = vi.fn(() => {
      throw error;
    }),
    wait = vi.fn();
  expect(() => replaceFileWithRetry('a', 'b', { platform: 'win32', rename, wait })).toThrow(error);
  expect(rename).toHaveBeenCalledTimes(7);
  expect(wait.mock.calls.flat().reduce((a, b) => a + b, 0)).toBe(1575);
});
it('disk/path errors are not retried or hidden', () => {
  const error = Object.assign(Error('disk full'), { code: 'ENOSPC' }),
    wait = vi.fn();
  expect(() =>
    replaceFileWithRetry('a', 'b', {
      platform: 'win32',
      wait,
      rename: () => {
        throw error;
      },
    }),
  ).toThrow(error);
  expect(wait).not.toHaveBeenCalled();
});
it('does not retry access denial outside Windows', () => {
  const error = Object.assign(Error('permission'), { code: 'EPERM' }),
    wait = vi.fn();
  expect(() =>
    replaceFileWithRetry('a', 'b', {
      platform: 'linux',
      wait,
      rename: () => {
        throw error;
      },
    }),
  ).toThrow(error);
  expect(wait).not.toHaveBeenCalled();
});
