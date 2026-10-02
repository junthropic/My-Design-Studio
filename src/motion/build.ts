import { bundle } from '@remotion/bundler';
import { ensureBrowser } from '@remotion/renderer';
import { cp, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import JSZip from 'jszip';
import { withHiddenWindowsProcesses } from './windows';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
async function bundleWindowsBrowser(destination: string) {
  // Version-pinned Remotion metadata selects the official Chrome archive. Its extract-zip
  // stream stalls on Node 26; JSZip uses a bounded, checked extraction path instead.
  const require = createRequire(import.meta.url),
    rendererDir = path.dirname(require.resolve('@remotion/renderer'));
  const { getRevisionInfo } = require(path.join(rendererDir, 'browser/BrowserFetcher.js'));
  const info = getRevisionInfo('headless-shell') as { url: string; executablePath: string };
  const source = new URL(info.url);
  if (
    source.origin !== 'https://storage.googleapis.com' ||
    !source.pathname.startsWith('/chrome-for-testing-public/') ||
    !source.pathname.endsWith('/win64/chrome-headless-shell-win64.zip')
  )
    throw new Error('Unexpected Remotion browser source.');
  const archivePath = path.join(
    root,
    'node_modules/.remotion/chrome-headless-shell/chrome-headless-shell-win64.zip',
  );
  let archive: Buffer;
  try {
    archive = await readFile(archivePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    console.log('Downloading pinned Chrome Headless Shell from the official Google archive.');
    const response = await fetch(source);
    if (!response.ok) throw new Error(`Browser download failed: HTTP ${response.status}`);
    archive = Buffer.from(await response.arrayBuffer());
    const length = Number(response.headers.get('content-length'));
    if (length && length !== archive.length) throw new Error('Browser download length mismatch.');
    await mkdir(path.dirname(archivePath), { recursive: true });
    await writeFile(archivePath, archive);
  }
  const zip = await JSZip.loadAsync(archive, { checkCRC32: true }),
    prefix = 'chrome-headless-shell-win64/';
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    if (!entry.name.startsWith(prefix)) throw new Error('Unexpected browser archive entry.');
    const relative = entry.name.slice(prefix.length),
      target = path.resolve(destination, relative),
      check = path.relative(destination, target);
    if (
      !relative ||
      path.isAbsolute(check) ||
      check.startsWith('..') ||
      entry.unsafeOriginalName?.includes('..')
    )
      throw new Error('Unsafe browser archive path.');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await entry.async('nodebuffer'));
  }
  const executable = path.join(destination, 'chrome-headless-shell.exe');
  if ((await stat(executable)).size < 1000000)
    throw new Error('Browser executable was not extracted.');
  return {
    executable,
    source: source.href,
    archiveSha256: createHash('sha256').update(archive).digest('hex'),
  };
}
await withHiddenWindowsProcesses(async () => {
  await bundle({
    entryPoint: path.join(root, 'src/motion/entry.tsx'),
    outDir: path.join(root, 'dist-remotion'),
    publicDir: path.join(root, 'public'),
    enableCaching: false,
  });
  console.log('Remotion composition bundled: dist-remotion');
  if (process.argv.includes('--browser')) {
    const destination = path.join(root, 'vendor/remotion-browser');
    await mkdir(destination, { recursive: true });
    let result: { executable: string; source?: string; archiveSha256?: string };
    if (process.platform === 'win32' && process.arch === 'x64')
      result = await bundleWindowsBrowser(destination);
    else {
      const browser = await ensureBrowser({ chromeMode: 'headless-shell' });
      if (browser.type === 'no-browser')
        throw new Error('Standalone browser download did not finish.');
      await cp(path.dirname(browser.path), destination, { recursive: true });
      result = { executable: path.join(destination, path.basename(browser.path)) };
    }
    const bytes = await readFile(result.executable);
    await writeFile(
      path.join(destination, 'studio-browser.json'),
      JSON.stringify(
        {
          remotion: '4.0.363',
          executable: path.basename(result.executable),
          sha256: createHash('sha256').update(bytes).digest('hex'),
          source: result.source,
          archiveSha256: result.archiveSha256,
        },
        null,
        2,
      ),
    );
    console.log('Standalone render browser copied: vendor/remotion-browser');
  }
});
