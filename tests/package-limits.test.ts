import { it, expect } from 'vitest';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createProject } from '../src/core/templates';
import { exportProject } from '../src/exporters/index';

it('refuses to produce a project backup whose assets cannot be imported again', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'design-studio-package-limit-'));
  try {
    const project = createProject('용량 검사');
    project.assets = [
      {
        id: 'large-video',
        name: '큰 영상.mp4',
        hash: '0'.repeat(64),
        mime: 'video/mp4',
        size: 101 * 1024 * 1024,
        relativePath: 'large.mp4',
      },
    ];
    const outputDir = path.join(root, 'output');
    await mkdir(outputDir);
    await expect(exportProject(project, 'project', { outputDir, assetsDir: root })).rejects.toThrow(
      '파일당 100MB',
    );
    expect(await readdir(outputDir)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
