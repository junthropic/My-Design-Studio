import { it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/index';
import { createProject } from '../src/core/templates';

it('copies complete projects independently, protects revisions/jobs and preserves shared assets after deletion', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'studio-projects-'));
  const server = await createServer({ dataDir: dir, port: 0 });
  const request = (url: string, method: string, body: unknown) =>
    fetch(server.url + '/api' + url, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-studio-request': '1' },
      body: JSON.stringify(body),
    });
  try {
    let source = server.store.create(createProject('원본'));
    const data = new FormData();
    data.append(
      'file',
      new Blob(
        [
          '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
        ],
        { type: 'image/svg+xml' },
      ),
      'logo.svg',
    );
    const upload = await fetch(server.url + '/api/projects/' + source.id + '/assets', {
      method: 'POST',
      headers: { 'x-studio-request': '1' },
      body: data,
    });
    expect(upload.status).toBe(201);
    source = (await upload.json()).project;
    expect(
      (await request(`/projects/${source.id}/duplicate`, 'POST', { name: '사본', baseRevision: 1 }))
        .status,
    ).toBe(409);
    const copyResponse = await request(`/projects/${source.id}/duplicate`, 'POST', {
      name: '사본',
      baseRevision: source.revision,
    });
    expect(copyResponse.status).toBe(201);
    const copy = await copyResponse.json();
    expect(copy.id).not.toBe(source.id);
    expect(copy.revision).toBe(1);
    for (const key of [
      'brand',
      'slides',
      'webPages',
      'motion',
      'assets',
      'datasets',
      'overrides',
      'customStyles',
      'collections',
    ] as const)
      expect(copy[key]).toEqual(source[key]);
    server.store.save({ ...copy, brand: { ...copy.brand, name: '독립 수정' } }, copy.revision);
    expect(server.store.project(source.id).brand.name).toBe(source.brand.name);
    expect((await request(`/projects/${source.id}`, 'DELETE', { baseRevision: 1 })).status).toBe(
      409,
    );
    server.store.putJob({
      id: 'busy',
      projectId: source.id,
      revision: source.revision,
      format: 'web',
      status: 'running',
      progress: 0,
      createdAt: new Date().toISOString(),
    } as any);
    expect(
      (await request(`/projects/${source.id}`, 'DELETE', { baseRevision: source.revision })).status,
    ).toBe(409);
    server.store.putJob({ ...server.store.job('busy'), status: 'completed' });
    expect(
      (await request(`/projects/${source.id}`, 'DELETE', { baseRevision: source.revision })).status,
    ).toBe(200);
    expect(() => server.store.project(source.id)).toThrow('없습니다');
    expect(server.store.revisions(copy.id)).toHaveLength(2);
    expect((await fetch(server.url + '/api/assets/' + copy.assets[0].id)).status).toBe(200);
    const last = await request(`/projects/${copy.id}`, 'DELETE', { baseRevision: 2 });
    const replacement = (await last.json()).nextProject;
    expect(replacement.id).not.toBe(copy.id);
    expect(server.store.projects()).toHaveLength(1);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it('persists app theme outside project data and across server restarts', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'studio-theme-'));
  let server = await createServer({ dataDir: dir, port: 0 });
  try {
    const project = server.store.create(createProject());
    const update = async (appTheme: string) =>
      fetch(server.url + '/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-studio-request': '1' },
        body: JSON.stringify({ appTheme }),
      });
    expect((await update('light')).status).toBe(200);
    expect((await update('invalid')).status).toBe(400);
    expect(server.store.project(project.id)).toEqual(project);
    await server.close();
    server = await createServer({ dataDir: dir, port: 0 });
    expect((await (await fetch(server.url + '/api/settings')).json()).appTheme).toBe('light');
    expect(server.store.project(project.id)).toEqual(project);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
