import { contextBridge, ipcRenderer } from 'electron';

// The entire bridge. Everything else the GUI needs it gets from the daemon over
// tRPC, exactly as the TUI does — a second IPC protocol would be a second API
// to keep in sync with the runtime.
contextBridge.exposeInMainWorld('mission', {
  notifyApprovalPending: (message: string) => ipcRenderer.send('approval-pending', message),
  /** The repository `org gui` was launched from. `container` is the path as the
   *  sandbox sees it, which is what a new run must be given; `error` explains
   *  why there is none, when there is none. */
  repo: {
    path: process.env.ORG_GUI_REPO ?? null,
    container: process.env.ORG_GUI_REPO_CONTAINER ?? null,
    error: process.env.ORG_GUI_REPO_ERROR ?? null,
  },
  /** Writes a case receipt to a file the user picks. The renderer builds the
   *  HTML; main only owns the save dialog, because a renderer cannot have one.
   *  Returns the path written, or null if the dialog was cancelled. */
  exportReceipt: (caseId: string, html: string): Promise<string | null> =>
    ipcRenderer.invoke('export-receipt', caseId, html),
});
