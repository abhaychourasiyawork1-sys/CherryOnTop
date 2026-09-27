import { app, BrowserWindow, Notification, shell, dialog, ipcMain } from 'electron';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Detached Deep Dive windows, one per inspected object. Only ever opened by
 *  an explicit request from the renderer — the default flow never spawns a
 *  window — and closing one stops nothing: the daemon owns the work. */
const detached = new Map<string, BrowserWindow>();
/** `decision:<caseId>:<id>`, `evidence:<caseId>` … — a kind and ids, nothing
 *  that could become a URL or a path. */
const DETACHED_TARGET = /^[a-z-]+(:[A-Za-z0-9._-]+){1,4}$/;

function createWindow(detachedTarget?: string): BrowserWindow {
  const window = new BrowserWindow({
    width: detachedTarget ? 920 : 1440,
    height: 900,
    minWidth: detachedTarget ? 560 : 900,
    minHeight: 560,
    show: false,
    // macOS can hide the title bar and let the rail absorb the traffic lights,
    // which keeps the graph edge-to-edge. Elsewhere the frame is the only way to
    // move or close the window, so it stays.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    backgroundColor: '#11171E',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      sandbox: false,
    },
  });

  // Painting an empty window before the first frame is what makes an Electron
  // app feel cheap. Wait for content.
  window.once('ready-to-show', () => window.show());

  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Renderer errors are otherwise invisible from a terminal, which makes a
  // blank window impossible to diagnose without opening devtools by hand.
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') {
      console.error(`[renderer] ${event.message}`);
    }
  });
  window.webContents.on('render-process-gone', (_e, details) =>
    console.error('[renderer] gone:', details.reason));

  const hash = detachedTarget ? `detached=${encodeURIComponent(detachedTarget)}` : undefined;
  const devServer = process.env.ELECTRON_RENDERER_URL;
  if (devServer) window.loadURL(hash ? `${devServer}#${hash}` : devServer);
  else window.loadFile(path.join(__dirname, '../renderer/index.html'), hash ? { hash } : undefined);

  return window;
}

app.whenReady().then(() => {
  const window = createWindow();

  // The renderer holds the tRPC subscription; it tells us when something needs a
  // human. Keeping the notification in main is what lets it fire when the window
  // is in the background, which is the only time it matters.
  window.webContents.ipc.on('approval-pending', (_event, message: string) => {
    if (window.isFocused()) return;
    new Notification({ title: 'Waiting on you', body: message }).show();
  });

  // A receipt is a file, not a link. Local-first means there is no server to
  // host a shareable URL on, and a self-contained file is the better object
  // anyway: it attaches to a pull request or a ticket and still opens in five
  // years on a machine that has never heard of this program.
  ipcMain.handle('export-receipt', async (_event, caseId: string, html: string) => {
    const result = await dialog.showSaveDialog(window, {
      title: 'Export case receipt',
      defaultPath: `receipt-${caseId.slice(0, 8)}.html`,
      filters: [{ name: 'Web page', extensions: ['html'] }],
    });
    if (result.canceled || !result.filePath) return null;
    await writeFile(result.filePath, html, 'utf8');
    return result.filePath;
  });

  // Choosing a folder to work in. Main only owns the dialog; whether the folder
  // is usable is decided by the daemon (daemon.resolveRepo), in one place.
  ipcMain.handle('pick-folder', async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? window;
    const result = await dialog.showOpenDialog(owner, {
      title: 'Choose a project folder',
      properties: ['openDirectory'],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle('open-detached', (_event, target: unknown) => {
    if (typeof target !== 'string' || !DETACHED_TARGET.test(target)) return false;
    const existing = detached.get(target);
    if (existing && !existing.isDestroyed()) {
      existing.focus();
      return true;
    }
    const child = createWindow(target);
    detached.set(target, child);
    child.on('closed', () => detached.delete(target));
    return true;
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Runs keep going in the daemon after the window closes — that is the whole
  // point of the daemon. Quitting the app must not read as cancelling work.
  if (process.platform !== 'darwin') app.quit();
});
