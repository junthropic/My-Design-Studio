import { readFile, mkdir, writeFile, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import JSZip from 'jszip';
import type { Project, ExportContext, ExportResult, Asset, EffectSettings } from '../core/types';
import { resolveDesign } from '../core/design';
import { activeFontAsset } from './font';
import { assertSafeSvg } from '../core/svg';
import { withHiddenWindowsProcesses } from './windows';

type MotionExportContext = ExportContext & { baseUrl?: string; browserExecutable?: string };
export const unpackRuntimePath = (file: string) =>
  file.replace(/app\.asar([\\/])/g, 'app.asar.unpacked$1');
const resourceRoot = () => (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
async function firstFile(candidates: (string | undefined)[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {}
  }
  return undefined;
}
async function renderBundle(report: (progress: number, message: string) => void): Promise<string> {
  const resources = resourceRoot();
  const candidates = [
    process.env.STUDIO_REMOTION_BUNDLE,
    resources ? path.join(resources, 'app.asar.unpacked/dist-remotion') : undefined,
    fileURLToPath(new URL('../dist-remotion', import.meta.url)),
    path.resolve(process.cwd(), 'dist-remotion'),
  ]
    .filter((p): p is string => !!p)
    .map(unpackRuntimePath);
  for (const candidate of candidates)
    if (await firstFile([path.join(candidate, 'index.html')])) return candidate;
  const entries = [
    process.env.STUDIO_REMOTION_ENTRY,
    path.resolve(process.cwd(), 'src/motion/entry.tsx'),
    fileURLToPath(new URL('./entry.tsx', import.meta.url)),
    fileURLToPath(new URL('../src/motion/entry.tsx', import.meta.url)),
    path.resolve(path.dirname(process.argv[1] ?? ''), '../src/motion/entry.tsx'),
  ];
  const entry = await firstFile(entries);
  if (!entry)
    throw new Error(
      '렌더 장면 번들이 없습니다. dist-remotion을 포함해 다시 빌드하거나 STUDIO_REMOTION_BUNDLE을 지정하세요.',
    );
  const { bundle } = await import('@remotion/bundler');
  return bundle({ entryPoint: entry, onProgress: (p) => report(5 + p * 0.2, '모션 장면 준비 중') });
}
async function bundledBinaries(): Promise<string | undefined> {
  if (process.platform !== 'win32' || process.arch !== 'x64') return undefined;
  const require = createRequire(import.meta.url),
    directory = unpackRuntimePath(
      path.dirname(require.resolve('@remotion/compositor-win32-x64-msvc')),
    );
  if (!(await firstFile([path.join(directory, 'ffmpeg.exe')])))
    throw new Error(
      '렌더용 FFmpeg가 없습니다. @remotion 네이티브 패키지의 asarUnpack 설정을 확인하세요.',
    );
  return directory;
}

/** Short localhost URLs allow OffthreadVideo range requests without huge data-URI proxy URLs. */
async function serveAssetBuffers(
  assets: Map<string, { data: Buffer; mime: string }>,
): Promise<{ sources: Record<string, string>; close: () => Promise<void> }> {
  if (!assets.size) return { sources: {}, close: async () => {} };
  const nonce = randomUUID(),
    server = createServer((req, res) => {
      const prefix = `/${nonce}/`;
      if (!req.url?.startsWith(prefix) || !['GET', 'HEAD'].includes(req.method ?? '')) {
        res.writeHead(404).end();
        return;
      }
      let id: string;
      try {
        id = decodeURIComponent(req.url.slice(prefix.length));
      } catch {
        res.writeHead(400).end();
        return;
      }
      const item = assets.get(id);
      if (!item) {
        res.writeHead(404).end();
        return;
      }
      const length = item.data.length,
        range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/),
        start = range ? Number(range[1]) : 0,
        end = range && range[2] ? Math.min(length - 1, Number(range[2])) : length - 1;
      if (start >= length || end < start) {
        res.writeHead(416, { 'Content-Range': `bytes */${length}` }).end();
        return;
      }
      res.writeHead(range ? 206 : 200, {
        'Content-Type': item.mime,
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${length}` } : {}),
      });
      res.end(req.method === 'HEAD' ? undefined : item.data.subarray(start, end + 1));
    });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('렌더 자산 서버를 준비하지 못했습니다.');
  return {
    sources: Object.fromEntries(
      [...assets.keys()].map((id) => [
        id,
        `http://127.0.0.1:${address.port}/${nonce}/${encodeURIComponent(id)}`,
      ]),
    ),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
export function validateMotion(project: Project): void {
  const c = project.motion;
  if (!c.scenes.length) throw new Error('내보낼 장면을 하나 이상 추가하세요.');
  if (
    !Number.isInteger(c.width) ||
    !Number.isInteger(c.height) ||
    c.width < 64 ||
    c.height < 64 ||
    c.width > 7680 ||
    c.height > 7680
  )
    throw new Error('영상 폭과 높이는 64~7680 사이 정수여야 합니다.');
  if (!Number.isInteger(c.fps) || c.fps < 1 || c.fps > 60)
    throw new Error('FPS는 1~60 사이 정수여야 합니다.');
  for (const key of [
    'audioTrimStartFrames',
    'audioTrimEndFrames',
    'audioFadeInFrames',
    'audioFadeOutFrames',
  ] as const)
    if (c[key] !== undefined && (!Number.isInteger(c[key]) || c[key]! < 0))
      throw new Error('오디오 구간과 페이드 프레임은 0 이상의 정수여야 합니다.');
  if (c.audioTrimEndFrames !== undefined && c.audioTrimEndFrames <= (c.audioTrimStartFrames ?? 0))
    throw new Error('오디오 원본 종료 구간은 시작보다 뒤여야 합니다.');
  const validateEffect = (settings: EffectSettings | undefined) => {
    if (!settings) return;
    if (
      (settings.durationFrames !== undefined &&
        (!Number.isInteger(settings.durationFrames) ||
          settings.durationFrames < 1 ||
          settings.durationFrames > 36000)) ||
      (settings.delayFrames !== undefined &&
        (!Number.isInteger(settings.delayFrames) ||
          settings.delayFrames < 0 ||
          settings.delayFrames > 36000)) ||
      (settings.intensity !== undefined &&
        (!Number.isFinite(settings.intensity) || settings.intensity < 0 || settings.intensity > 2))
    )
      throw new Error('효과의 길이·지연·강도 값을 확인하세요.');
  };
  for (const caption of c.captions ?? [])
    if (
      !Number.isFinite(caption.start) ||
      !Number.isFinite(caption.end) ||
      caption.start < 0 ||
      caption.end <= caption.start
    )
      throw new Error('자막의 종료 시간은 시작 시간보다 커야 합니다.');
  for (const scene of c.scenes) {
    validateEffect(scene.effectSettings);
    if (
      !Number.isInteger(scene.durationFrames) ||
      scene.durationFrames < 1 ||
      scene.durationFrames > 36000
    )
      throw new Error(`장면 “${scene.name}”의 길이를 확인하세요.`);
    for (const element of scene.elements) {
      validateEffect(element.effectSettings);
      if (
        ![element.x, element.y, element.w, element.h].every(Number.isFinite) ||
        element.w <= 0 ||
        element.h <= 0
      )
        throw new Error(`레이어 ${element.id}의 위치 또는 크기가 올바르지 않습니다.`);
      if ((element.type === 'image' || element.type === 'video') && !element.assetId)
        throw new Error(
          `장면 “${scene.name}”의 ${element.type === 'image' ? '이미지' : '영상'} 자산을 선택하세요.`,
        );
      const start = element.startFrame ?? 0,
        end = element.endFrame ?? scene.durationFrames;
      if (
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 0 ||
        end <= start ||
        end > scene.durationFrames
      )
        throw new Error(`레이어 ${element.id}의 시작·종료 프레임을 확인하세요.`);
      for (const key of element.keyframes ?? []) {
        if (!Number.isInteger(key.frame) || key.frame < 0 || key.frame >= scene.durationFrames)
          throw new Error(`레이어 ${element.id}의 키프레임이 장면 밖에 있습니다.`);
        if (
          key.property === 'color'
            ? typeof key.value !== 'string' || !key.value.trim()
            : typeof key.value !== 'number' || !Number.isFinite(key.value)
        )
          throw new Error(`레이어 ${element.id}의 키프레임 값 형식을 확인하세요.`);
      }
    }
  }
}
export async function exportMotion(
  project: Project,
  format: string,
  context: MotionExportContext,
): Promise<ExportResult> {
  return withHiddenWindowsProcesses(() => renderMotion(project, format, context));
}
async function renderMotion(
  project: Project,
  format: string,
  context: MotionExportContext,
): Promise<ExportResult> {
  validateMotion(project);
  if (!['mp4', 'webm', 'png-sequence'].includes(format))
    throw new Error('지원하는 영상 형식: mp4, webm, png-sequence');
  if (format === 'mp4' && (project.motion.width % 2 || project.motion.height % 2))
    throw new Error('MP4의 폭과 높이는 짝수여야 합니다.');
  if (format === 'mp4' && project.motion.transparent)
    throw new Error(
      'MP4는 투명 배경을 저장하지 않습니다. 배경을 켜거나 WebM 또는 PNG 시퀀스를 선택하세요.',
    );
  const snapshot = structuredClone(project),
    totalFrames = snapshot.motion.scenes.reduce((n, s) => n + s.durationFrames, 0),
    assetBuffers = new Map<string, { data: Buffer; mime: string }>(),
    actualHashes = new Map<string, string>();
  const refs = new Set(
    snapshot.motion.scenes.flatMap((s) =>
      s.elements.map((e) => e.assetId).filter((x): x is string => !!x),
    ),
  );
  if (snapshot.motion.audioAssetId) refs.add(snapshot.motion.audioAssetId);
  const fontAsset = activeFontAsset(
    snapshot.assets,
    String(resolveDesign(snapshot, 'motion').tokens['font.family']),
  );
  if (fontAsset) refs.add(fontAsset.id);
  if (
    snapshot.assets.some(
      (asset) => asset.id === snapshot.brand.logoAssetId && asset.mime.startsWith('image/'),
    )
  )
    refs.add(snapshot.brand.logoAssetId!);
  for (const id of refs) {
    const asset = snapshot.assets.find((a) => a.id === id);
    if (!asset) throw new Error(`참조한 자산을 찾지 못했습니다: ${id}`);
    const assetFile = context.assetPath
      ? context.assetPath(asset)
      : path.resolve(context.assetsDir, asset.relativePath);
    if (!context.assetPath) {
      const relative = path.relative(path.resolve(context.assetsDir), assetFile);
      if (relative.startsWith('..') || path.isAbsolute(relative))
        throw new Error('자산 경로가 프로젝트 자산 폴더 밖에 있습니다.');
    }
    const data = await readFile(assetFile);
    if (asset.mime === 'image/svg+xml' || path.extname(assetFile).toLowerCase() === '.svg')
      assertSafeSvg(data.toString('utf8'));
    assetBuffers.set(id, { data, mime: asset.mime || 'application/octet-stream' });
    actualHashes.set(id, createHash('sha256').update(data).digest('hex'));
  }
  if (context.signal?.aborted) throw new Error('렌더가 취소되었습니다.');
  const { selectComposition, renderMedia, renderFrames, ensureBrowser, makeCancelSignal } =
    await import('@remotion/renderer');
  const { cancel, cancelSignal } = makeCancelSignal(),
    onAbort = () => cancel();
  context.signal?.addEventListener('abort', onAbort, { once: true });
  const report = (progress: number, message: string) =>
    context.onProgress?.(Math.round(progress), message);
  const resources = resourceRoot();
  let browserExecutable =
    context.browserExecutable ??
    process.env.REMOTION_BROWSER_EXECUTABLE ??
    (await firstFile([
      resources ? path.join(resources, 'remotion-browser/chrome-headless-shell.exe') : undefined,
      path.resolve(process.cwd(), 'vendor/remotion-browser/chrome-headless-shell.exe'),
      process.env.ProgramFiles
        ? path.join(process.env.ProgramFiles, 'Google/Chrome/Application/chrome.exe')
        : undefined,
      process.env['ProgramFiles(x86)']
        ? path.join(process.env['ProgramFiles(x86)'], 'Microsoft/Edge/Application/msedge.exe')
        : undefined,
      process.env.LOCALAPPDATA
        ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe')
        : undefined,
    ]));
  let assetServer: Awaited<ReturnType<typeof serveAssetBuffers>> | undefined;
  try {
    assetServer = await serveAssetBuffers(assetBuffers);
    report(2, '렌더 입력과 자산을 고정했습니다');
    if (!browserExecutable) {
      if (resources && fileURLToPath(import.meta.url).includes('app.asar'))
        throw new Error('설치된 렌더 브라우저가 없습니다. 브라우저를 포함해 앱을 다시 설치하세요.');
      report(3, '렌더용 Chromium 확인 중');
      const browser = await ensureBrowser({ chromeMode: 'headless-shell' });
      if (browser.type === 'no-browser') throw new Error('렌더용 Chromium을 준비하지 못했습니다.');
      browserExecutable = browser.path;
    }
    await mkdir(context.outputDir, { recursive: true });
    const serveUrl = await renderBundle(report),
      binariesDirectory = await bundledBinaries();
    if (context.signal?.aborted) throw new Error('렌더가 취소되었습니다.');
    const inputProps = { project: snapshot, assetSources: assetServer.sources };
    const composition = await selectComposition({
      serveUrl,
      id: 'Studio',
      inputProps,
      browserExecutable,
      binariesDirectory,
    });
    const stem = `motion-${snapshot.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'studio'}`;
    const design = resolveDesign(snapshot, 'motion'),
      font = String(design.tokens['font.family']);
    const manifest: Record<string, unknown> = {
      schemaVersion: 1,
      kind: 'motion',
      format,
      projectId: snapshot.id,
      revision: snapshot.revision,
      width: composition.width,
      height: composition.height,
      fps: composition.fps,
      durationFrames: totalFrames,
      durationSeconds: totalFrames / composition.fps,
      seed: snapshot.motion.seed,
      transparent: !!snapshot.motion.transparent,
      renderer: 'Remotion 4.0.363',
      browser: path.basename(browserExecutable),
      font,
      fontNote: fontAsset
        ? '프로젝트에 업로드한 브랜드 글꼴을 직접 로드했습니다.'
        : font.includes('Pretendard')
          ? '앱에 포함된 Pretendard Variable 웹폰트를 사용합니다.'
          : '이 PC에 설치된 브랜드 글꼴을 사용합니다. 다른 PC의 폰트 차이는 렌더 결과에 영향을 줍니다.',
      audio: {
        assetId: snapshot.motion.audioAssetId,
        trimStartFrames: snapshot.motion.audioTrimStartFrames ?? 0,
        trimEndFrames: snapshot.motion.audioTrimEndFrames,
        fadeInFrames: snapshot.motion.audioFadeInFrames ?? 0,
        fadeOutFrames: snapshot.motion.audioFadeOutFrames ?? 0,
      },
      design: { styleId: snapshot.styleId, mode: snapshot.mode, tokens: design.tokens },
      assets: [...refs].map((id) => {
        const a = snapshot.assets.find((a) => a.id === id) as Asset;
        return { id, hash: actualHashes.get(id), name: a.name };
      }),
      createdAt: new Date().toISOString(),
    };
    let output: string, mime: string;
    if (format === 'png-sequence') {
      const framesDir = path.join(context.outputDir, 'frames');
      await mkdir(framesDir, { recursive: true });
      await renderFrames({
        composition,
        serveUrl,
        inputProps,
        browserExecutable,
        binariesDirectory,
        outputDir: framesDir,
        imageFormat: 'png',
        concurrency: 2,
        cancelSignal,
        onStart: () => report(25, 'PNG 프레임 렌더 시작'),
        onFrameUpdate: (frame) => report(25 + (frame / totalFrames) * 65, 'PNG 프레임 렌더 중'),
      });
      const names = (await readdir(framesDir)).filter((n) => n.endsWith('.png')).sort();
      if (names.length !== totalFrames)
        throw new Error(`프레임 수 불일치: ${names.length}/${totalFrames}`);
      if (snapshot.motion.audioAssetId)
        manifest.audioNote =
          'PNG 시퀀스에는 오디오가 포함되지 않습니다. 원본 오디오를 편집 프로그램에서 따로 배치하세요.';
      report(92, 'PNG 시퀀스 묶는 중');
      const zip = new JSZip();
      for (const name of names) zip.file(name, await readFile(path.join(framesDir, name)));
      zip.file('manifest.json', JSON.stringify(manifest, null, 2));
      output = path.join(context.outputDir, `${stem}-frames.zip`);
      await writeFile(
        output,
        await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }),
      );
      mime = 'application/zip';
    } else {
      output = path.join(context.outputDir, `${stem}.${format}`);
      mime = format === 'mp4' ? 'video/mp4' : 'video/webm';
      await renderMedia({
        composition,
        serveUrl,
        inputProps,
        browserExecutable,
        binariesDirectory,
        outputLocation: output,
        codec: format === 'mp4' ? 'h264' : 'vp8',
        pixelFormat:
          format === 'mp4' ? 'yuv420p' : snapshot.motion.transparent ? 'yuva420p' : 'yuv420p',
        imageFormat: format === 'webm' && snapshot.motion.transparent ? 'png' : 'jpeg',
        muted: !snapshot.motion.audioAssetId,
        enforceAudioTrack: false,
        overwrite: true,
        concurrency: 2,
        cancelSignal,
        onProgress: ({ progress }) => report(25 + progress * 70, '영상 렌더 중'),
      });
    }
    if (context.signal?.aborted) throw new Error('렌더가 취소되었습니다.');
    if ((await stat(output)).size === 0) throw new Error('렌더 결과가 비어 있습니다.');
    const manifestPath = path.join(context.outputDir, `${stem}.manifest.json`);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    report(100, '렌더 완료');
    return {
      files: [
        { name: path.basename(output), path: output, mime },
        { name: path.basename(manifestPath), path: manifestPath, mime: 'application/json' },
      ],
      manifest,
    };
  } finally {
    context.signal?.removeEventListener('abort', onAbort);
    await assetServer?.close();
  }
}
