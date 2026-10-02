import JSZip from 'jszip';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import type { ExportContext, Project, ExportResult } from '../core/types.ts';
import { ProjectSchema } from '../core/schema.ts';
import {
  assetBytes,
  hashBuffer,
  prepareOutput,
  result,
  safeProject,
  slug,
  writeManifest,
  type Loss,
} from './common.ts';
import { renderWebHTML, WEB_INTERACTIONS, webAssetName } from './web.ts';
import { validateImportedAsset } from './import-validation.ts';

const PACKAGE_LIMITS = {
  compressed: 100 * 1024 * 1024,
  expanded: 500 * 1024 * 1024,
  asset: 100 * 1024 * 1024,
  project: 20 * 1024 * 1024,
  manifest: 5 * 1024 * 1024,
  entries: 2000,
};

async function bundledFont(name: string) {
  const candidates = [
    new URL('../../public/fonts/' + name, import.meta.url),
    new URL('../dist/fonts/' + name, import.meta.url),
  ].map((url) => fileURLToPath(url));
  candidates.push(path.resolve('public/fonts', name), path.resolve('dist/fonts', name));
  for (const candidate of candidates) {
    try {
      return await readFile(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  throw new Error(
    '번들 Pretendard 글꼴 또는 OFL 라이선스를 찾지 못했습니다. 앱의 fonts 폴더를 복구하세요.',
  );
}

export async function addAssets(zip: JSZip, project: Project, context: ExportContext) {
  if (new Set(project.assets.map((a) => a.id)).size !== project.assets.length)
    throw new Error('중복된 에셋 ID가 있습니다.');
  const files: { id: string; path: string; hash: string; size: number; mime: string }[] = [];
  for (const asset of project.assets) {
    const bytes = await assetBytes(asset, context);
    const name = `assets/${webAssetName(project, asset.id)}`;
    zip.file(name, bytes);
    files.push({
      id: asset.id,
      path: name,
      hash: hashBuffer(bytes),
      size: bytes.length,
      mime: asset.mime,
    });
  }
  return files;
}
export async function exportProjectPackage(
  project: Project,
  context: ExportContext,
): Promise<ExportResult> {
  // A backup is only useful when this same application can import it again.
  // Validate metadata before loading large assets; recheck actual bytes below.
  if (project.assets.length + 3 > PACKAGE_LIMITS.entries)
    throw new Error('프로젝트 패키지는 폴더를 포함해 2,000개 항목 이하여야 합니다.');
  if (project.assets.some((a) => a.size > PACKAGE_LIMITS.asset))
    throw new Error(
      '프로젝트 패키지의 자산은 파일당 100MB 이하여야 합니다. 큰 영상은 압축한 뒤 다시 추가하세요.',
    );
  if (project.assets.reduce((sum, a) => sum + a.size, 0) > PACKAGE_LIMITS.expanded)
    throw new Error('프로젝트 패키지의 압축 해제 크기는 500MB 이하여야 합니다.');
  const dir = await prepareOutput(context, 'project');
  const zip = new JSZip();
  const assets = await addAssets(zip, project, context);
  const clean = safeProject(project);
  clean.assets = clean.assets.map((a) => {
    const entry = assets.find((f) => f.id === a.id)!;
    return { ...a, relativePath: entry.path, hash: entry.hash, size: entry.size };
  });
  const projectJson = JSON.stringify(clean, null, 2);
  if (Buffer.byteLength(projectJson) > PACKAGE_LIMITS.project)
    throw new Error(
      '프로젝트 원본 JSON은 20MB 이하여야 합니다. 데이터나 장면을 나누어 저장하세요.',
    );
  if (assets.some((a) => a.size > PACKAGE_LIMITS.asset))
    throw new Error('프로젝트 패키지의 실제 자산 크기가 100MB를 넘습니다.');
  const manifest = await writeManifest(
    dir,
    project,
    'project',
    [
      {
        location: 'project',
        feature: '편집 원본',
        capability: 'native',
        message: '모든 편집 모델과 데이터 스냅샷을 보존합니다.',
      },
      {
        location: 'datasets',
        feature: 'API 연결',
        capability: 'unsupported',
        message:
          'API 인증정보와 연결 설정은 패키지에서 제외됩니다. 가져온 데이터 스냅샷은 유지됩니다.',
      },
    ],
    { assets },
  );
  const manifestJson = JSON.stringify(manifest, null, 2);
  if (Buffer.byteLength(manifestJson) > PACKAGE_LIMITS.manifest)
    throw new Error('프로젝트 매니페스트 크기는 5MB 이하여야 합니다.');
  if (
    assets.reduce((sum, a) => sum + a.size, 0) +
      Buffer.byteLength(projectJson) +
      Buffer.byteLength(manifestJson) >
    PACKAGE_LIMITS.expanded
  )
    throw new Error('프로젝트 패키지의 압축 해제 크기는 500MB 이하여야 합니다.');
  zip.file('project.json', projectJson);
  zip.file('manifest.json', manifestJson);
  const name = slug(project.name) + '.designstudio';
  const archive = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  if (archive.length > PACKAGE_LIMITS.compressed)
    throw new Error(
      '압축된 프로젝트 패키지가 100MB를 넘습니다. 큰 자산을 줄이거나 프로젝트를 나누세요.',
    );
  await writeFile(path.join(dir, name), archive);
  return result(dir, [{ name, mime: 'application/zip' }], manifest);
}
export async function importProjectPackage(
  buffer: Buffer,
  context: ExportContext,
): Promise<Project> {
  if (buffer.length > PACKAGE_LIMITS.compressed)
    throw new Error('프로젝트 패키지는 100MB 이하여야 합니다.');
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files);
  if (names.length > PACKAGE_LIMITS.entries) throw new Error('패키지 파일 수가 너무 많습니다.');
  let declared = 0;
  for (const entry of Object.values(zip.files)) {
    const original =
      (entry as unknown as { unsafeOriginalName?: string }).unsafeOriginalName || entry.name;
    if (
      original.includes('\\') ||
      original.startsWith('/') ||
      /^[a-z]:/i.test(original) ||
      original.split('/').includes('..') ||
      original.includes('\0')
    )
      throw new Error('안전하지 않은 패키지 경로입니다.');
    declared +=
      (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize || 0;
  }
  if (declared > PACKAGE_LIMITS.expanded) throw new Error('압축 해제 크기가 500MB를 넘습니다.');
  const boundedRead = (file: JSZip.JSZipObject, limit: number) =>
    new Promise<Buffer>((resolve, reject) => {
      const stream = file.nodeStream('nodebuffer') as Readable;
      const chunks: Buffer[] = [];
      let count = 0,
        failed = false;
      stream.on('data', (chunk: Buffer) => {
        if (failed) return;
        count += chunk.length;
        if (count > limit) {
          failed = true;
          stream.destroy();
          reject(new Error('압축 해제 크기 한도를 넘습니다.'));
          return;
        }
        chunks.push(chunk);
      });
      stream.on('error', reject);
      stream.on('end', () => {
        if (!failed) resolve(Buffer.concat(chunks));
      });
    });
  const projectFile = zip.file('project.json'),
    manifestFile = zip.file('manifest.json');
  if (!projectFile || !manifestFile) throw new Error('project.json 또는 manifest.json이 없습니다.');
  const project = ProjectSchema.parse(
    JSON.parse((await boundedRead(projectFile, PACKAGE_LIMITS.project)).toString('utf8')),
  ) as Project;
  const manifestSchema = z.object({
    schemaVersion: z.literal(1),
    format: z.literal('project'),
    assets: z
      .array(
        z.object({
          id: z.string().min(1),
          path: z.string().min(1),
          hash: z.string().regex(/^[0-9a-f]{64}$/),
          size: z.number().int().min(0),
          mime: z.string().optional(),
        }),
      )
      .max(2000),
  });
  const parsedManifest = manifestSchema.safeParse(
    JSON.parse((await boundedRead(manifestFile, PACKAGE_LIMITS.manifest)).toString('utf8')),
  );
  if (!parsedManifest.success) throw new Error('지원하지 않는 패키지 형식입니다.');
  const manifest = parsedManifest.data;
  if (
    new Set(project.assets.map((a) => a.id)).size !== project.assets.length ||
    new Set(manifest.assets.map((a) => a.id)).size !== manifest.assets.length ||
    manifest.assets.length !== project.assets.length
  )
    throw new Error('중복되거나 일치하지 않는 에셋 목록입니다.');
  const entries: { asset: Project['assets'][number]; bytes: Buffer; fileName: string }[] = [];
  let bytesTotal = 0;
  for (const asset of project.assets) {
    const item = manifest.assets.find((f) => f.id === asset.id);
    if (
      !item ||
      item.path !== asset.relativePath ||
      !/^assets\/[^/]+$/.test(item.path) ||
      (item.mime && item.mime !== asset.mime)
    )
      throw new Error('에셋 목록이 일치하지 않습니다.');
    const file = zip.file(item.path);
    if (!file) throw new Error(`에셋이 없습니다: ${asset.name}`);
    const bytes = await boundedRead(
      file,
      Math.min(PACKAGE_LIMITS.asset, PACKAGE_LIMITS.expanded - bytesTotal),
    );
    bytesTotal += bytes.length;
    const hash = hashBuffer(bytes);
    if (
      hash !== item.hash ||
      hash !== asset.hash ||
      bytes.length !== item.size ||
      bytes.length !== asset.size
    )
      throw new Error(`에셋 무결성 검사 실패: ${asset.name}`);
    const extension = await validateImportedAsset(asset, bytes);
    entries.push({ asset, bytes, fileName: `${hash}${extension}` });
  }
  // Nothing is written until the full package and every hash has been validated.
  await mkdir(context.assetsDir, { recursive: true });
  for (const item of entries) {
    await writeFile(path.join(context.assetsDir, item.fileName), item.bytes);
    item.asset.relativePath = item.fileName;
  }
  return safeProject(project);
}

export async function exportWebPackage(
  project: Project,
  context: ExportContext,
): Promise<ExportResult> {
  if (!project.webPages.length) throw new Error('내보낼 웹 페이지를 먼저 추가하세요.');
  const dir = await prepareOutput(context, 'web');
  const zip = new JSZip();
  const assets = await addAssets(zip, project, context);
  const clean = safeProject(project);
  for (const name of ['PretendardVariable.woff2', 'OFL.txt']) {
    const bytes = await bundledFont(name);
    zip.file('fonts/' + name, bytes);
    zip.file('react/public/fonts/' + name, bytes);
  }
  const docs = project.webPages.map((page, i) => ({
    name: i === 0 ? 'index.html' : `page-${encodeURIComponent(page.id)}.html`,
    html: renderWebHTML(clean, page.id, 'assets/'),
  }));
  for (const doc of docs) zip.file(doc.name, doc.html);
  zip.file('data/snapshots.json', JSON.stringify(clean.datasets, null, 2));
  const pageData = docs.map((d, i) => ({
    id: project.webPages[i].id,
    name: project.webPages[i].name,
    title: project.webPages[i].title,
    body: d.html.match(/<body>([\s\S]*?)<script type="application\/json"/)?.[1] || '',
    css: d.html.match(/<style>([\s\S]*?)<\/style>/)?.[1] || '',
  }));
  zip.file('react/src/pages.json', JSON.stringify(pageData, null, 2));
  zip.file(
    'react/src/interactions.ts',
    `// @ts-nocheck\n// Browser interactions are shared verbatim with the static site.\nexport const mountWebInteractions = ${WEB_INTERACTIONS};\n`,
  );
  zip.file(
    'react/src/App.tsx',
    `import React,{useEffect,useRef,useState} from 'react';\nimport pages from './pages.json';\nimport {mountWebInteractions} from './interactions';\nexport default function App(){const [index,setIndex]=useState(0);const ref=useRef<HTMLDivElement>(null);useEffect(()=>{if(ref.current)mountWebInteractions(ref.current);document.title=pages[index].title;const el=ref.current!;const handler=(e:MouseEvent)=>{const a=(e.target as Element).closest('a');if(!a)return;const href=a.getAttribute('href')||'';const i=href==='index.html'?0:pages.findIndex(p=>href==='page-'+encodeURIComponent(p.id)+'.html');if(i>=0){e.preventDefault();setIndex(i);}};el.addEventListener('click',handler);return()=>el.removeEventListener('click',handler);},[index]);return <><style>{pages[index].css}</style><div key={index} ref={ref} dangerouslySetInnerHTML={{__html:pages[index].body}}/></>;}\n`,
  );
  zip.file(
    'react/src/main.tsx',
    `import React from 'react';import{createRoot}from'react-dom/client';import App from './App';createRoot(document.getElementById('root')!).render(<App/>);`,
  );
  zip.file(
    'react/index.html',
    '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
  );
  zip.file(
    'react/vite.config.ts',
    "import {defineConfig} from 'vite';\nexport default defineConfig({base:'./',server:{host:'127.0.0.1'}});\n",
  );
  zip.file(
    'react/package.json',
    JSON.stringify(
      {
        name: slug(project.name).toLowerCase(),
        version: '1.0.0',
        private: true,
        type: 'module',
        scripts: {
          dev: 'vite --host 127.0.0.1',
          build: 'vite build',
          preview: 'vite preview --host 127.0.0.1',
        },
        dependencies: { react: '^19.1.0', 'react-dom': '^19.1.0' },
        devDependencies: {
          vite: '^6.3.5',
          typescript: '^5.8.3',
          '@types/react': '^19.1.0',
          '@types/react-dom': '^19.1.0',
        },
      },
      null,
      2,
    ),
  );
  for (const asset of assets) {
    const content = zip.file(asset.path)!;
    zip.file('react/public/' + asset.path, await content.async('nodebuffer'));
  }
  const apiSources = project.datasets.filter((d) => d.connection?.url);
  if (apiSources.length) {
    zip.file(
      'server/proxy.mjs',
      `import http from 'node:http';\nconst routes=${JSON.stringify(Object.fromEntries(apiSources.map((d) => [d.id, `DATA_${slug(d.id).toUpperCase().replace(/-/g, '_')}_URL`])))};\nconst allowedOrigin=process.env.ALLOWED_ORIGIN||'http://127.0.0.1:5173';\nhttp.createServer(async(req,res)=>{let id;try{id=decodeURIComponent((req.url||'').split('?')[0].replace('/api/data/',''));}catch{res.writeHead(400).end();return;}if(req.method!=='GET'||!Object.hasOwn(routes,id)){res.writeHead(404).end();return;}try{const address=process.env[routes[id]];if(!address)throw Error('Environment configuration required');const u=new URL(address);if(u.protocol!=='https:')throw Error('HTTPS required');const token=process.env[routes[id].replace(/_URL$/,'_TOKEN')];const r=await fetch(u,{headers:token?{Authorization:'Bearer '+token}:{},signal:AbortSignal.timeout(15000),redirect:'error'});if(!r.ok)throw Error('Upstream failed');const data=await r.json();res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':allowedOrigin,'Cache-Control':'no-store'}).end(JSON.stringify(data));}catch{res.writeHead(502,{'Content-Type':'application/json'}).end(JSON.stringify({error:'Upstream unavailable'}));}}).listen(Number(process.env.PORT||8788),'127.0.0.1');\n`,
    );
    zip.file(
      'server/.env.example',
      apiSources
        .map(
          (d) =>
            `DATA_${slug(d.id).toUpperCase().replace(/-/g, '_')}_URL=\nDATA_${slug(d.id).toUpperCase().replace(/-/g, '_')}_TOKEN=`,
        )
        .join('\n') + '\nALLOWED_ORIGIN=http://127.0.0.1:5173\n',
    );
  }
  const losses: Loss[] = [
    {
      location: 'web',
      feature: '반응형 페이지·검색·정렬·상세·FAQ',
      capability: 'native',
      message: '미리보기와 같은 HTML 렌더러 및 인터랙션을 사용합니다.',
    },
    {
      location: 'datasets',
      feature: '데이터',
      capability: 'native',
      message: '내보내는 시점의 데이터 스냅샷을 포함합니다.',
    },
  ];
  if (project.brand.logoAssetId)
    losses.push({
      location: 'web-header',
      feature: '브랜드 로고',
      elementId: project.brand.logoAssetId,
      capability: project.assets.some(
        (a) => a.id === project.brand.logoAssetId && a.mime.startsWith('image/'),
      )
        ? 'native'
        : 'unsupported',
      message: '유효한 로고 이미지는 헤더에 비율을 유지해 표시하며 자산 파일로 함께 포함합니다.',
    });
  if (apiSources.length)
    losses.push({
      location: 'datasets',
      feature: '실시간 API',
      capability: 'approximated',
      message:
        '기본 웹사이트는 스냅샷을 표시합니다. 비밀 없는 Node GET 프록시 뼈대가 포함되며 환경 설정 및 UI 연결은 별도로 해야 합니다.',
    });
  const manifest = await writeManifest(dir, project, 'web', losses, {
    pages: docs.map((d) => d.name),
    assets,
    credentialsIncluded: false,
    font: {
      requested: project.brand.font,
      embedded: true,
      bundled: ['PretendardVariable.woff2'],
      license: 'fonts/OFL.txt',
      uploaded: project.assets
        .filter((a) => a.mime.startsWith('font/'))
        .map((a) => ({
          id: a.id,
          name: a.name,
          license: a.license || '사용자가 사용권을 확인해야 합니다.',
        })),
      note: 'Pretendard 웹폰트와 OFL 라이선스를 포함합니다. 업로드한 글꼴은 원본 자산과 함께 포함되며 별도 사용권 조건을 확인해야 합니다. 그 밖의 시스템 글꼴은 포함하지 않습니다.',
    },
  });
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  zip.file(
    'README.md',
    `# ${project.name}\n\n루트 index.html을 열면 정적 웹사이트를 사용할 수 있습니다. 모든 페이지와 자산을 같은 위치에 유지하세요. 검색, 숫자 정렬, 사례·행 상세, FAQ, 대시보드 탭은 실제로 동작합니다.\n\nReact 소스는 react/에 있습니다. 해당 폴더에서 npm install 후 npm run dev 또는 npm run build를 사용합니다. 정적 페이지와 React 소스는 동일한 생성 HTML과 동작을 사용합니다.\n\n${apiSources.length ? 'server/proxy.mjs는 환경변수로 구성하는 읽기 전용 프록시 뼈대입니다. 원본 API URL·헤더·인증정보는 내보내지 않습니다. 기본 사이트의 데이터는 data/snapshots.json의 스냅샷입니다.\n' : ''}요청 글꼴: ${project.brand.font}. Pretendard 웹폰트와 OFL 라이선스는 fonts/에 포함되어 있습니다. 업로드한 글꼴도 자산으로 포함됩니다. 추가 글꼴의 사용권과 배포 허용 범위를 확인하세요.\n`,
  );
  const name = slug(project.name) + '-web.zip';
  await writeFile(
    path.join(dir, name),
    await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
  );
  return result(dir, [{ name, mime: 'application/zip' }], manifest);
}
