import { app, BrowserWindow, Notification, shell, dialog, ipcMain } from 'electron';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 640,
    show: false,
    // macOS can hide the title bar and let the rail absorb the traffic lights,
    // which keeps the graph edge-to-edge. Elsewhere the frame is the only way to
    // move or close the window, so it stays.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    backgroundColor: '#131A22',
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

  const devServer = process.env.ELECTRON_RENDERER_URL;
  if (devServer) window.loadURL(devServer);
  else window.loadFile(path.join(__dirname, '../renderer/index.html'));

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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Runs keep going in the daemon after the window closes — that is the whole
  // point of the daemon. Quitting the app must not read as cancelling work.
  if (process.platform !== 'darwin') app.quit();
});
