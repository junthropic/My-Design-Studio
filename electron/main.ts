import { app, BrowserWindow, safeStorage, session, dialog } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { prepareRuntimeBrowser } from './runtime-browser';

let mainWindow: BrowserWindow | null = null;
let service: { close: () => Promise<void>; url: string } | undefined;
let quitting = false;
let verifyTimer: ReturnType<typeof setInterval> | undefined;
let verifyWatchdog: ReturnType<typeof setTimeout> | undefined;
const verifyInput = process.env.STUDIO_VERIFY_OUTPUT;
const verifyDir =
  verifyInput &&
  path.isAbsolute(verifyInput) &&
  path
    .resolve(verifyInput)
    .split(/[\\/]/)
    .some((part) => part.toLowerCase() === 'work')
    ? path.resolve(verifyInput)
    : undefined;
if (verifyInput && !verifyDir)
  throw new Error('STUDIO_VERIFY_OUTPUT은 work 폴더 안의 절대 경로여야 합니다.');
if (verifyDir) {
  mkdirSync(verifyDir, { recursive: true });
  verifyWatchdog = setTimeout(() => {
    writeFileSync(
      path.join(verifyDir, 'timeout.json'),
      JSON.stringify({ error: 'Packaged verification reached its 180 second limit.' }),
      'utf8',
    );
    app.quit();
  }, 180000);
}
if (process.env.STUDIO_DATA_DIR) {
  const localData = path.resolve(process.env.STUDIO_DATA_DIR, 'electron-user-data');
  mkdirSync(localData, { recursive: true });
  app.setPath('userData', localData);
  app.setPath('sessionData', localData);
  app.setAppLogsPath(path.join(localData, 'logs'));
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.focus();
  });
  app
    .whenReady()
    .then(async () => {
      const root = app.getAppPath();
      if (app.isPackaged)
        process.env.REMOTION_BROWSER_EXECUTABLE = prepareRuntimeBrowser(
          path.join(process.resourcesPath, 'remotion-browser'),
          path.join(app.getPath('userData'), 'renderer-cache'),
        );
      const { createServer } = await import(
        pathToFileURL(path.join(root, 'dist-server', 'index.js')).href
      );
      const encrypted =
        safeStorage.isEncryptionAvailable() &&
        (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
      service = await createServer({
        dataDir: process.env.STUDIO_DATA_DIR ?? path.join(app.getPath('userData'), 'studio'),
        port: Number(process.env.STUDIO_PORT ?? 0),
        staticDir: path.join(root, 'dist'),
        ...(encrypted
          ? {
              secretCipher: {
                encrypt: (text: string) => safeStorage.encryptString(text),
                decrypt: (buffer: Buffer) => safeStorage.decryptString(buffer),
              },
            }
          : {}),
      });
      const studioUrl = service!.url;
      session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      session.defaultSession.setPermissionCheckHandler(() => false);
      mainWindow = new BrowserWindow({
        width: 1480,
        height: 1000,
        minWidth: 1100,
        minHeight: 720,
        title: 'Design Studio',
        backgroundColor: '#0b1018',
        show: false,
        autoHideMenuBar: true,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
          allowRunningInsecureContent: false,
          backgroundThrottling: !verifyDir,
        },
      });
      mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      mainWindow.webContents.on('will-navigate', (event, url) => {
        if (!url.startsWith(studioUrl + '/') && url !== studioUrl) event.preventDefault();
      });
      mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
      mainWindow.once('ready-to-show', () => {
        if (!verifyDir) mainWindow?.show();
      });
      mainWindow.on('closed', () => (mainWindow = null));
      await mainWindow.loadURL(studioUrl);
      if (verifyDir) {
        // A hidden Chromium surface can keep an old loading-frame bitmap despite a ready DOM.
        // Show only this verification app without taking keyboard focus; no console is opened.
        mainWindow.showInactive();
        let navigationReady = false;
        const readyDeadline = Date.now() + 20000;
        while (!navigationReady && Date.now() < readyDeadline) {
          navigationReady = await mainWindow.webContents.executeJavaScript(
            "document.querySelectorAll('nav button').length >= 9 && !!document.querySelector('main')",
          );
          if (!navigationReady) await new Promise((resolve) => setTimeout(resolve, 200));
        }
        if (!navigationReady) throw new Error('UI navigation did not finish loading.');
        await mainWindow.webContents.executeJavaScript(
          'Promise.race([document.fonts.ready.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),15000))])',
        );
        await new Promise((resolve) => setTimeout(resolve, 600));
        const capture = await mainWindow.webContents.capturePage();
        writeFileSync(path.join(verifyDir, 'preview.png'), capture.toPNG());
        writeFileSync(
          path.join(verifyDir, 'ready.json'),
          JSON.stringify(
            {
              url: studioUrl,
              title: mainWindow.getTitle(),
              nodeVersion: process.versions.node,
              electronVersion: process.versions.electron,
              navigationReady,
            },
            null,
            2,
          ),
          'utf8',
        );
        const deadline = Date.now() + 180000;
        verifyTimer = setInterval(() => {
          if (existsSync(path.join(verifyDir, 'finish')) || Date.now() > deadline) {
            if (verifyTimer) clearInterval(verifyTimer);
            verifyTimer = undefined;
            app.quit();
          }
        }, 300);
      }
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (verifyDir)
        writeFileSync(
          path.join(verifyDir, 'error.json'),
          JSON.stringify({ error: message }, null, 2),
          'utf8',
        );
      else dialog.showErrorBox('Design Studio 실행 오류', message);
      app.quit();
    });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (verifyTimer) clearInterval(verifyTimer);
    if (verifyWatchdog) clearTimeout(verifyWatchdog);
    if (service && !quitting) {
      event.preventDefault();
      quitting = true;
      service.close().finally(() => app.quit());
    }
  });
}
