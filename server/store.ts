import initSqlJs, { type Database } from 'sql.js';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { replaceFileWithRetry } from './atomic-file';
import path from 'node:path';
import type { Project, Job } from '../src/core/types';
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
export class StudioStore {
  private constructor(
    public db: Database,
    public dataDir: string,
  ) {}
  static async open(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    const require = createRequire(import.meta.url);
    const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
    const file = path.join(dataDir, 'studio.sqlite');
    const store = new StudioStore(
      existsSync(file) ? new SQL.Database(readFileSync(file)) : new SQL.Database(),
      dataDir,
    );
    store.db.run(
      'PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS revisions(project_id TEXT NOT NULL, revision INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY(project_id,revision)); CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS settings(id TEXT PRIMARY KEY,json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS integrations(id TEXT PRIMARY KEY,json TEXT NOT NULL);',
    );
    for (const job of store.jobs())
      if (job.status === 'running' || job.status === 'queued') {
        job.status = 'failed';
        job.message = '앱이 종료되어 작업이 중단되었습니다. 다시 내보내세요.';
        job.error = 'PROCESS_RESTARTED';
        store.putJob(job);
      }
    store.flush();
    return store;
  }
  rows<T>(sql: string, args: (string | number)[] = []): T[] {
    const q = this.db.prepare(sql);
    try {
      q.bind(args);
      const rows: T[] = [];
      while (q.step()) rows.push(JSON.parse(String(q.getAsObject().json)) as T);
      return rows;
    } finally {
      q.free();
    }
  }
  flush() {
    const file = path.join(this.dataDir, 'studio.sqlite');
    const tmp = file + '.tmp';
    writeFileSync(tmp, Buffer.from(this.db.export()), { mode: 0o600 });
    replaceFileWithRetry(tmp, file);
  }
  projects() {
    return this.rows<Project>('SELECT json FROM projects').sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
  }
  project(id: string) {
    const p = this.rows<Project>('SELECT json FROM projects WHERE id=?', [id])[0];
    if (!p) throw new ApiError(404, '프로젝트가 없습니다.');
    return p;
  }
  create(project: Project) {
    if (this.rows('SELECT json FROM projects WHERE id=?', [project.id]).length)
      throw new ApiError(409, '같은 ID의 프로젝트가 존재합니다.');
    const p = { ...project, revision: 1, updatedAt: new Date().toISOString() };
    this.commit(p);
    return p;
  }
  save(project: Project, baseRevision: number) {
    const current = this.project(project.id);
    if (current.revision !== baseRevision)
      throw new ApiError(409, '다른 창에서 변경되었습니다. 최신 프로젝트를 다시 불러오세요.', {
        currentRevision: current.revision,
      });
    const p = { ...project, revision: current.revision + 1, updatedAt: new Date().toISOString() };
    this.commit(p);
    return p;
  }
  private commit(p: Project) {
    this.db.run('BEGIN');
    try {
      this.db.run('INSERT OR REPLACE INTO projects(id,json) VALUES(?,?)', [
        p.id,
        JSON.stringify(p),
      ]);
      this.db.run('INSERT INTO revisions(project_id,revision,json) VALUES(?,?,?)', [
        p.id,
        p.revision,
        JSON.stringify(p),
      ]);
      this.db.run(
        'DELETE FROM revisions WHERE project_id=? AND revision NOT IN (SELECT revision FROM revisions WHERE project_id=? ORDER BY revision DESC LIMIT 50)',
        [p.id, p.id],
      );
      this.db.run('COMMIT');
      this.flush();
    } catch (e) {
      try {
        this.db.run('ROLLBACK');
      } catch {}
      throw e;
    }
  }
  revisions(id: string) {
    this.project(id);
    return this.rows<Project>(
      'SELECT json FROM revisions WHERE project_id=? ORDER BY revision DESC',
      [id],
    ).map((p) => ({ revision: p.revision, updatedAt: p.updatedAt, name: p.name }));
  }
  restore(id: string, revision: number, baseRevision: number) {
    const p = this.rows<Project>('SELECT json FROM revisions WHERE project_id=? AND revision=?', [
      id,
      revision,
    ])[0];
    if (!p) throw new ApiError(404, '저장된 버전이 없습니다.');
    return this.save(p, baseRevision);
  }
  delete(id: string) {
    this.project(id);
    this.db.run('DELETE FROM projects WHERE id=?', [id]);
    this.db.run('DELETE FROM revisions WHERE project_id=?', [id]);
    this.flush();
  }
  jobs() {
    return this.rows<Job>('SELECT json FROM jobs').sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }
  job(id: string) {
    const j = this.rows<Job>('SELECT json FROM jobs WHERE id=?', [id])[0];
    if (!j) throw new ApiError(404, '작업을 찾을 수 없습니다.');
    return j;
  }
  putJob(job: Job) {
    this.db.run('INSERT OR REPLACE INTO jobs(id,json) VALUES(?,?)', [job.id, JSON.stringify(job)]);
    this.flush();
  }
  setting<T>(id: string, fallback: T): T {
    return this.rows<T>('SELECT json FROM settings WHERE id=?', [id])[0] ?? fallback;
  }
  setSetting(id: string, value: unknown) {
    this.db.run('INSERT OR REPLACE INTO settings(id,json) VALUES(?,?)', [
      id,
      JSON.stringify(value),
    ]);
    this.flush();
  }
  integration<T>(id: string) {
    return this.rows<T>('SELECT json FROM integrations WHERE id=?', [id])[0];
  }
  setIntegration(id: string, value: unknown) {
    this.db.run('INSERT OR REPLACE INTO integrations(id,json) VALUES(?,?)', [
      id,
      JSON.stringify(value),
    ]);
    this.flush();
  }
  close() {
    this.flush();
    this.db.close();
  }
}
