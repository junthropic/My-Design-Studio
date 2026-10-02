import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import JSZip from 'jszip';
import { chromium } from '@playwright/test';
import { createProject, makeSlide, SLIDE_LAYOUTS } from '../src/core/templates.ts';
import { exportProject, importProjectPackage } from '../src/exporters/index.ts';
import { renderWebHTML } from '../src/exporters/web.ts';
import { hashBuffer } from '../src/exporters/common.ts';
import type { ExportContext, Project } from '../src/core/types.ts';

let root: string, context: ExportContext, project: Project;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'design-studio-export-'));
  context = { outputDir: path.join(root, 'out'), assetsDir: path.join(root, 'assets') };
  await mkdir(context.assetsDir, { recursive: true });
  project = createProject('내 디자인');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
async function zipFor(format: string) {
  const output = await exportProject(project, format, context);
  const file = output.files.find((f) => /\.(zip|designstudio|pptx)$/.test(f.name))!;
  return { output, zip: await JSZip.loadAsync(await readFile(file.path)) };
}

describe('실제 내보내기 결과', () => {
  it.skipIf(process.env.DESIGN_STUDIO_OFFICE_SAMPLE !== '1')('Office 검증 샘플 생성', async () => {
    const dir = path.resolve('../../work/office-verification');
    await mkdir(dir, { recursive: true });
    const count = Number(process.env.DESIGN_STUDIO_OFFICE_SLIDES || 12);
    project.slides = Array.from({ length: count }, (_, i) =>
      makeSlide(SLIDE_LAYOUTS[i % 12].id, project.brand.name, i),
    );
    const exported = await exportProject(project, 'pptx', { outputDir: dir, assetsDir: dir });
    await writeFile(
      path.join(dir, 'sample-path.txt'),
      exported.files.find((f) => f.name.endsWith('.pptx'))!.path,
      'utf8',
    );
    await writeFile(
      path.join(dir, 'sample-project.json'),
      JSON.stringify(project, null, 2),
      'utf8',
    );
  });
  it('12종 장표를 네이티브 OOXML 텍스트·표·차트·노트로 만든다', async () => {
    project.slides = SLIDE_LAYOUTS.map((l, i) => makeSlide(l.id, project.brand.name, i));
    project.slides[0].notes = '발표자 노트 확인';
    project.slides[1].hidden = true;
    const { zip, output } = await zipFor('pptx');
    const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
    expect(slides).toHaveLength(12);
    const xml = (await Promise.all(slides.map((n) => zip.file(n)!.async('string')))).join('');
    expect(xml).toContain('<a:t>생각을 디자인으로,');
    expect(xml).toContain('<a:tbl>');
    expect(xml).toContain('show="0"');
    expect(Object.keys(zip.files).some((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n))).toBe(true);
    expect(Object.keys(zip.files).some((n) => n.endsWith('.xlsx'))).toBe(true);
    const notes = await zip.file('ppt/notesSlides/notesSlide1.xml')!.async('string');
    expect(notes).toContain('발표자 노트 확인');
    expect(output.manifest.editable).toBe(true);
  });
  it.each([
    { width: 960, height: 540 },
    { width: 720, height: 540 },
  ])('PPTX $width×$height pt는 실제 장표 EMU와 글자 pt 크기를 유지한다', async (size) => {
    project.slideSize = size;
    project.overrides.dark['font.tracking'] = 1.25;
    project.slides = [makeSlide('body')];
    project.slides[0].elements = [
      {
        id: 'unit-text',
        type: 'text',
        x: 72,
        y: 36,
        w: 144,
        h: 48,
        fontSize: 23.5,
        text: '단위 검증',
      },
      { id: 'unit-line', type: 'shape', shape: 'line', x: 72, y: 108, w: 144, h: 2.5 },
      {
        id: 'unit-table',
        type: 'table',
        x: 72,
        y: 144,
        w: 288,
        h: 96,
        fontSize: 19,
        tableData: [
          ['제목', '값'],
          ['데이터', '42'],
        ],
      },
    ];
    const { zip, output } = await zipFor('pptx');
    const presentation = await zip.file('ppt/presentation.xml')!.async('string');
    expect(presentation).toContain(
      `<p:sldSz cx="${size.width * 12700}" cy="${size.height * 12700}"`,
    );
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
    const shapes = [...xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].map((m) => m[0]);
    const text = shapes.find((s) => s.includes('name="unit-text"'))!;
    expect(text).toContain('<a:off x="914400" y="457200"/>');
    expect(text).toContain('<a:ext cx="1828800" cy="609600"/>');
    expect(text).toMatch(/<a:rPr\b[^>]*\bsz="2350"/);
    expect(text).toMatch(/<a:rPr\b[^>]*\bspc="125"/);
    const line = shapes.find((s) => s.includes('name="unit-line"'))!;
    expect(line).toContain('<a:ln w="31750"');
    const table = xml.match(/<a:tbl>[\s\S]*?<\/a:tbl>/)![0];
    expect(table).toMatch(/<a:rPr\b[^>]*\bsz="1900"/);
    expect(output.manifest.coordinateConversion).toEqual({
      source: 'pt',
      inchesPerPoint: 1 / 72,
      emuPerPoint: 12700,
      slideSizePoints: size,
    });
  });
  it('DTCG는 px 치수, ms 시간, 배수 행간을 저장한다', async () => {
    const { zip } = await zipFor('tokens');
    const data = JSON.parse(await zip.file('tokens.dtcg.json')!.async('string'));
    expect(data.dark.typography.body.$value.lineHeight).toBe(1.55);
    expect(data.dark.typography.body.$value.letterSpacing.unit).toBe('px');
    expect(data.dark.motion.duration.$value.unit).toBe('ms');
    expect(data.dark.color.accent.$value.colorSpace).toBe('srgb');
    expect(zip.file('DESIGN.md')).not.toBeNull();
  });
  it('PPTX 이미지 자산은 텍스트와 분리된 미디어 및 대체 텍스트로 포함한다', async () => {
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFOUAAAAASUVORK5CYII=',
      'base64',
    );
    await writeFile(path.join(context.assetsDir, 'pixel.png'), bytes);
    project.assets = [
      {
        id: 'pixel',
        name: '흰색 샘플',
        mime: 'image/png',
        hash: hashBuffer(bytes),
        size: bytes.length,
        relativePath: 'pixel.png',
      },
    ];
    project.slides[0].elements.push({
      id: 'image-one',
      type: 'image',
      assetId: 'pixel',
      x: 100,
      y: 100,
      w: 40,
      h: 40,
      alt: '대체 텍스트 예시',
    });
    project.brand.logoAssetId = 'pixel';
    const { zip, output } = await zipFor('pptx');
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
    expect(xml).toContain('대체 텍스트 예시');
    expect(xml).toContain('<p:pic>');
    expect(
      Object.keys(zip.files).filter((n) => /^ppt\/media\/.*\.png$/.test(n)).length,
    ).toBeGreaterThan(0);
    const masterXML = (
      await Promise.all(
        Object.keys(zip.files)
          .filter((n) => /^ppt\/(slideMasters|slideLayouts)\/.*\.xml$/.test(n))
          .map((n) => zip.file(n)!.async('string')),
      )
    ).join('');
    expect(masterXML).toContain('brand-logo-pixel');
    expect(JSON.stringify(output.manifest)).toContain('브랜드 로고');
    expect(renderWebHTML(project)).toContain('class="brand-logo"');
  });
  it('웹 ZIP은 3페이지·React 소스·실제 인터랙션과 인증 없는 스냅샷을 포함한다', async () => {
    project.datasets[0].connection = {
      url: 'https://private.example/data?key=VERY_SECRET',
      headers: { Authorization: 'Bearer VERY_SECRET' },
      secretRef: 'VERY_SECRET',
    };
    const { zip } = await zipFor('web');
    expect(Object.keys(zip.files).filter((n) => /^page-.*\.html$/.test(n))).toHaveLength(2);
    expect(zip.file('react/src/App.tsx')).not.toBeNull();
    expect(zip.file('server/proxy.mjs')).not.toBeNull();
    for (const entry of Object.values(zip.files).filter(
      (f) => !f.dir && /\.(html|json|tsx?|mjs|md)$/.test(f.name),
    )) {
      expect(await entry.async('string')).not.toContain('VERY_SECRET');
    }
    const dashboard = await zip.file(`page-${project.webPages[2].id}.html`)!.async('string');
    expect(dashboard).toContain('data-sort');
    expect(dashboard).toContain('data-table-filter');
    expect(dashboard).toContain('data-row-detail');
    expect(dashboard).toContain('data-tab-panel');
    const scripts = [...dashboard.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    for (const code of scripts) expect(() => new Function(code)).not.toThrow();
  });
  it('미리보기 HTML은 주입된 콘텐츠를 이스케이프하고 데이터 인증을 노출하지 않는다', () => {
    project.webPages[0].title = '</title><script>ATTACK()</script>';
    project.webPages[0].sections[0].body = '<img src=x onerror=ATTACK()>';
    project.datasets[0].rows[0]['프로젝트'] = '</script><script>ATTACK()</script>';
    const html = renderWebHTML(project);
    expect(html).not.toContain('<script>ATTACK()');
    expect(html).toContain('&lt;img');
    expect(html).toContain('\\u003c/script>');
  });
  it('자산 포함 프로젝트는 해시 검사 후 다시 편집할 수 있으며 인증을 제거한다', async () => {
    const bytes = Buffer.from('a valid round-trip asset');
    const hash = hashBuffer(bytes);
    await writeFile(path.join(context.assetsDir, 'demo.txt'), bytes);
    project.assets = [
      {
        id: 'asset-one',
        name: '샘플',
        mime: 'text/plain',
        hash,
        size: bytes.length,
        relativePath: 'demo.txt',
      },
    ];
    project.datasets[0].connection = {
      url: 'https://example.com',
      headers: { Authorization: 'SECRET' },
    };
    const { zip } = await zipFor('project');
    const target = { ...context, assetsDir: path.join(root, 'import') };
    const restored = await importProjectPackage(
      await zip.generateAsync({ type: 'nodebuffer' }),
      target,
    );
    expect(restored.datasets[0].connection).toBeUndefined();
    expect(restored.slides).toEqual(project.slides);
    expect(await readFile(path.join(target.assetsDir, restored.assets[0].relativePath))).toEqual(
      bytes,
    );
    zip.file('assets/asset-one.txt', 'tampered');
    await expect(
      importProjectPackage(await zip.generateAsync({ type: 'nodebuffer' }), target),
    ).rejects.toThrow('무결성');
  });
  it('경로 순회 ZIP을 가져오지 않는다', async () => {
    const { zip } = await zipFor('project');
    zip.file('../escape.txt', 'unexpected');
    await expect(
      importProjectPackage(await zip.generateAsync({ type: 'nodebuffer' }), context),
    ).rejects.toThrow('안전하지 않은');
  });
  it('해시가 맞더라도 활성 SVG 및 허위 MIME을 신뢰하지 않고 파일 쓰기 전에 거부한다', async () => {
    for (const [mime, text] of [
      ['image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
      ['image/png', 'not a PNG'],
    ]) {
      const bytes = Buffer.from(text),
        hash = hashBuffer(bytes);
      await writeFile(path.join(context.assetsDir, 'unsafe.bin'), bytes);
      project.assets = [
        {
          id: 'unsafe',
          name: 'untrusted',
          mime,
          hash,
          size: bytes.length,
          relativePath: 'unsafe.bin',
        },
      ];
      if (mime === 'image/svg+xml') await expect(zipFor('project')).rejects.toThrow('정적 SVG');
      const zip = new JSZip(),
        unsafeProject = structuredClone(project);
      unsafeProject.assets[0].relativePath = 'assets/unsafe.bin';
      zip.file('project.json', JSON.stringify(unsafeProject));
      zip.file(
        'manifest.json',
        JSON.stringify({
          schemaVersion: 1,
          format: 'project',
          assets: [{ id: 'unsafe', path: 'assets/unsafe.bin', hash, size: bytes.length, mime }],
        }),
      );
      zip.file('assets/unsafe.bin', bytes);
      const target = path.join(root, 'rejected');
      await expect(
        importProjectPackage(await zip.generateAsync({ type: 'nodebuffer' }), {
          ...context,
          assetsDir: target,
        }),
      ).rejects.toThrow();
      await expect(readdir(target)).rejects.toThrow();
    }
  });
  it('빈 표·차트와 열 길이가 다른 표를 안전하게 처리한다', async () => {
    project.slides = [makeSlide('table')];
    project.slides[0].elements = [
      { id: 'empty-table', type: 'table', x: 0, y: 0, w: 100, h: 100, tableData: [[]] },
      {
        id: 'ragged-table',
        type: 'table',
        x: 100,
        y: 0,
        w: 200,
        h: 100,
        tableData: [['A', 'B'], ['C']],
      },
      {
        id: 'empty-chart',
        type: 'chart',
        x: 0,
        y: 150,
        w: 100,
        h: 100,
        chartData: { labels: [], values: [] },
      },
    ];
    const { output, zip } = await zipFor('pptx');
    expect(JSON.stringify(output.manifest)).toContain('행 또는 열이 없는');
    expect(await zip.file('ppt/slides/slide1.xml')!.async('string')).not.toContain('NaN');
    project.datasets[0].columns = [];
    project.datasets[0].rows = [];
    expect(renderWebHTML(project, project.webPages[2].id)).toContain('데이터 열이 없습니다.');
  });
  it('실제 ZIP의 세 페이지 탐색·자산·OFL 글꼴·데이터 표시가 동작한다', async () => {
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFOUAAAAASUVORK5CYII=',
      'base64',
    );
    await writeFile(path.join(context.assetsDir, 'pixel.png'), bytes);
    project.assets = [
      {
        id: 'pixel',
        name: '테스트 이미지',
        mime: 'image/png',
        hash: hashBuffer(bytes),
        size: bytes.length,
        relativePath: 'pixel.png',
      },
    ];
    for (const p of project.webPages) p.sections[0].assetId = 'pixel';
    project.datasets[0].columns = ['문자열', '숫자', '백분율', '통화', '날짜'];
    project.datasets[0].formats = {
      문자열: 'text',
      숫자: 'number',
      백분율: 'percent',
      통화: 'currency',
      날짜: 'date',
    };
    project.datasets[0].rows = [
      { 문자열: '00123', 숫자: '1234.567', 백분율: 0.75, 통화: '5000', 날짜: '2026-10-02' },
      { 문자열: 'negative', 숫자: '-10', 백분율: null, 통화: '', 날짜: 'invalid' },
    ];
    const { zip } = await zipFor('web');
    expect(zip.file('fonts/PretendardVariable.woff2')).not.toBeNull();
    expect(await zip.file('fonts/OFL.txt')!.async('string')).toContain('SIL OPEN FONT LICENSE');
    const site = path.join(root, 'site');
    for (const entry of Object.values(zip.files).filter(
      (f) => !f.dir && !f.name.startsWith('react/'),
    )) {
      const file = path.join(site, entry.name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, await entry.async('nodebuffer'));
    }
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(pathToFileURL(path.join(site, 'index.html')).href);
      await page.locator('.page-links a').nth(1).click();
      expect(page.url()).toContain(project.webPages[1].id);
      await page.locator('.page-links a').nth(2).click();
      expect(page.url()).toContain(project.webPages[2].id);
      const table = page.locator('[data-tab-panel="all"] section.table');
      const cells = await table.locator('tbody tr').first().locator('td').allTextContents();
      expect(cells.slice(0, 5)).toEqual(['00123', '1,234.57', '75%', '₩5,000', '2026. 10. 02.']);
      expect(await page.locator('[data-tab-panel="all"] .chart-row').count()).toBe(2);
      expect(
        await page
          .locator('img')
          .first()
          .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
      ).toBe(true);
      await page.locator('.page-links a').first().click();
      expect(page.url()).toContain('index.html');
    } finally {
      await browser.close();
    }
  }, 30000);
  it.each(['after-effects', 'blender'])(
    '%s는 데이터·수동 실행 스크립트와 정직한 지원 범위를 포함한다',
    async (format) => {
      const { zip, output } = await zipFor(format);
      expect(zip.file('scene.json')).not.toBeNull();
      expect(
        zip.file(format === 'blender' ? 'import_scene.py' : 'import-scene.jsx'),
      ).not.toBeNull();
      expect(output.manifest.generatedProjectFile).toBe(false);
      expect(JSON.stringify(output.manifest)).toContain('unsupported');
      if (format === 'after-effects') {
        const jsx = await zip.file('import-scene.jsx')!.async('string');
        expect(() => new Function(jsx)).not.toThrow();
        expect(jsx).toContain("file.encoding='UTF-8'");
      }
    },
  );
  it('웹 미리보기는 실제 브라우저에서 검색·숫자 정렬·상세·탭·FAQ와 모바일 폭을 처리한다', async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.setContent(renderWebHTML(project, project.webPages[2].id));
      const panel = page.locator('[data-tab-panel="all"]');
      const table = panel.locator('section.table');
      await table.locator('[data-table-filter]').fill('브랜드 리뉴얼');
      expect(await table.locator('tbody tr:visible').count()).toBe(1);
      await table.locator('[data-table-filter]').fill('');
      await table.locator('[data-sort="3"]').click();
      expect(await table.locator('tbody tr').first().locator('td').nth(3).textContent()).toBe('30');
      await table.locator('[data-row-detail]').first().click();
      expect(await page.locator('dialog').isVisible()).toBe(true);
      await page.locator('[data-close-dialog]').click();
      await page.locator('[data-page-tab="data"]').click();
      expect(await panel.isVisible()).toBe(false);
      await page.locator('[data-page-tab="data"]').press('ArrowLeft');
      expect(await panel.isVisible()).toBe(true);
      await page.setViewportSize({ width: 390, height: 780 });
      await page.setContent(renderWebHTML(project, project.webPages[1].id));
      await page.locator('.faq summary').first().click();
      expect(await page.locator('.faq details').first().getAttribute('open')).not.toBeNull();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 30000);
});
