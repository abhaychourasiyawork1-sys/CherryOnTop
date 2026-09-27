/** The Electron bridge (see src/preload/index.ts). Absent when the renderer
 *  is opened in a plain browser during development, so every use is optional. */
export interface RepoInfo {
  path: string | null;
  container: string | null;
  error: string | null;
}

declare global {
  interface Window {
    mission?: {
      notifyApprovalPending: (message: string) => void;
      repo: RepoInfo;
      exportReceipt?: (caseId: string, html: string) => Promise<string | null>;
      openDetached?: (target: string) => Promise<boolean>;
      pathForFile?: (file: File) => string;
    };
  }
}

export const REPO: RepoInfo = window.mission?.repo ?? { path: null, container: null, error: null };
