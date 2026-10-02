import { afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import JSZip from 'jszip';
import { assertSafeSvg } from '../src/core/svg';
import { validateImportedAsset } from '../src/exporters/import-validation';
import { importProjectPackage } from '../src/exporters/packages';
import { createProject } from '../src/core/templates';
import { createServer } from './index';

const svg = (inner: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="40" height="40">${inner}</svg>`;
const bad = [
  svg('<image href="javascript:alert(1)"/>'),
  svg('<image href="../outside.png"/>'),
  svg('<image href="file:///C:/private.png"/>'),
  svg('<image href="//evil.invalid/image.png"/>'),
  svg('<image href="&#x68;ttps://evil.invalid/image.png"/>'),
  svg('<image href="data:image/svg+xml;base64,PHN2Zy8+"/>'),
  svg('<style>@import "https://evil.invalid/style.css";</style>'),
  svg('<style>@im\\70ort "https://evil.invalid/style.css";</style>'),
  svg('<rect style="fill:u\\72l(https://evil.invalid/x)"/>'),
  svg('<style>svg{background-image:image-set("https://evil.invalid/x" 1x)}</style>'),
  svg('<use href="#ok"><set attributeName="href" to="https://evil.invalid/x"/></use>'),
  svg('<animate attributeName="fill" values="url(https://evil.invalid/x);red"/>'),
  '<s:svg xmlns:s="http://www.w3.org/2000/svg"><s:script>alert(1)</s:script></s:svg>',
  '<?xml-stylesheet type="text/css" href="https://evil.invalid/x"?>' + svg('<rect/>'),
  '<svg xmlns="http://www.w3.org/2000/svg" xml:base="https://evil.invalid/"><use href="#x"/></svg>',
  '<!DOCTYPE svg [<!ENTITY secret SYSTEM "file:///C:/secret">]>' + svg('<text>&secret;</text>'),
  svg('<rect onload="alert(1)"/>'),
  svg(
    '<foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><img src="https://evil.invalid/x"/></body></foreignObject>',
  ),
];
const good = svg(
  '<defs><linearGradient id="gradient"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#112233"/></linearGradient><path id="shape" d="M0 0 L20 20"/></defs><style>.shape{fill:url(#gradient);stroke:rgb(10,20,30)}</style><rect class="shape" width="40" height="40"/><use xlink:href="#shape"/><text x="2" y="20">안전한 SVG &amp; 로고</text>',
);
let running: Awaited<ReturnType<typeof createServer>> | undefined;
const dirs: string[] = [];
function temp() {
  const dir = mkdtempSync(path.join(tmpdir(), 'studio-svg-test-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await running?.close();
  running = undefined;
  for (const dir of dirs.splice(0)) {
    const rel = path.relative(tmpdir(), dir);
    if (rel.startsWith('studio-svg-test-') && !rel.includes(path.sep))
      rmSync(dir, { recursive: true, force: true });
  }
});
describe('static SVG boundary', () => {
  it('keeps valid vector shapes, local fragments, gradients and text', async () => {
    expect(() => assertSafeSvg(good)).not.toThrow();
    expect(
      await validateImportedAsset(
        {
          id: 'logo',
          name: 'logo.svg',
          mime: 'image/svg+xml',
          hash: '',
          size: 0,
          relativePath: 'logo.svg',
        },
        Buffer.from(good),
      ),
    ).toBe('.svg');
  });
  it.each(bad.map((value, i) => [i, value] as const))(
    'rejects active or external SVG variant %i',
    (_index, value) => {
      expect(() => assertSafeSvg(value)).toThrow('정적 SVG');
    },
  );
  it('rejects malicious SVG in a correctly hashed project ZIP before writing assets', async () => {
    const dir = temp();
    const bytes = Buffer.from(bad[1]),
      hash = createHash('sha256').update(bytes).digest('hex');
    const p = createProject();
    p.assets = [
      {
        id: 'logo',
        name: 'evil.svg',
        mime: 'image/svg+xml',
        hash,
        size: bytes.length,
        relativePath: 'assets/evil.svg',
      },
    ];
    const zip = new JSZip();
    zip.file('project.json', JSON.stringify(p));
    zip.file(
      'manifest.json',
      JSON.stringify({
        schemaVersion: 1,
        format: 'project',
        assets: [
          { id: 'logo', path: 'assets/evil.svg', hash, size: bytes.length, mime: 'image/svg+xml' },
        ],
      }),
    );
    zip.file('assets/evil.svg', bytes);
    const assetsDir = path.join(dir, 'assets');
    await expect(
      importProjectPackage(await zip.generateAsync({ type: 'nodebuffer' }), {
        assetsDir,
        outputDir: path.join(dir, 'outputs'),
      }),
    ).rejects.toThrow('정적 SVG');
    expect(existsSync(assetsDir) ? readdirSync(assetsDir) : []).toEqual([]);
  });
  it('uses the same validation for direct asset uploads and leaves rejected uploads unsaved', async () => {
    const dir = temp();
    running = await createServer({ port: 0, dataDir: dir });
    const p = running.store.create(createProject());
    for (const text of [bad[0], bad[1], bad[6], bad[12]]) {
      const data = new FormData();
      data.append('file', new Blob([text], { type: 'image/svg+xml' }), 'test.svg');
      const response = await fetch(running.url + `/api/projects/${p.id}/assets`, {
        method: 'POST',
        headers: { 'x-studio-request': '1' },
        body: data,
      });
      expect(response.status).toBe(400);
    }
    expect(running.store.project(p.id).assets).toHaveLength(0);
    expect(readdirSync(path.join(dir, 'assets'))).toHaveLength(0);
    const data = new FormData();
    data.append('file', new Blob([good], { type: 'image/svg+xml' }), 'logo.svg');
    const valid = await fetch(running.url + `/api/projects/${p.id}/assets`, {
      method: 'POST',
      headers: { 'x-studio-request': '1' },
      body: data,
    });
    expect(valid.status).toBe(201);
  });
});
