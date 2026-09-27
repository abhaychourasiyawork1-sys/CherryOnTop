import { useEffect, useState } from 'react';
import { ResizableSurface } from './ResizableSurface.js';
import { Icon } from './Icon.js';
import { useWorkspace } from './WorkspaceContext.js';
import { visible as visibleSurfaces, type Surface } from '../lib/surfaces.js';
import { titleOf } from '../lib/run.js';
import { displayPath } from '../lib/artifacts.js';
import { PlanSurface } from '../surfaces/PlanSurface.js';
import { FilesSurface, ArtifactSurface } from '../surfaces/ArtifactSurface.js';
import { MemorySurface } from '../surfaces/MemorySurface.js';
import { DecisionSurface } from '../surfaces/DecisionSurface.js';
import { ActivitySurface } from '../surfaces/ActivitySurface.js';
import { DeepDive } from '../surfaces/DeepDiveSurface.js';
import { RunTranscript } from '../surfaces/RunTranscript.js';
import { ErrorBoundary } from './ErrorBoundary.js';

const TITLE: Partial<Record<Surface['kind'], string>> = {
  plan: 'Plan',
  files: 'Files',
  memory: 'Memory',
  decision: 'Decisions',
  activity: 'Activity',
  run: 'How it got there',
  attention: 'Needs your attention',
};

function useWindowWidth() {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}

/** The Workspace reshapes around the task: the conversation, plus at most two
 *  surfaces beside it, or a Deep Dive in its place. Anything else that is open
 *  waits as a chip on the right edge rather than taking a column. */
export function AdaptiveWorkspace(props: { children: React.ReactNode; attention: React.ReactNode }) {
  const ws = useWorkspace();
  const { layout } = ws.surfaces;
  const width = useWindowWidth();
  const shown = visibleSurfaces(layout, width);
  const waiting = layout.side.filter((surface) => !shown.includes(surface));
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(timer);
  }, [toast]);

  // Escape peels back one layer: a Deep Dive first, then the newest transient
  // surface. Pinned surfaces and the conversation are never closed by it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector('[data-modal-open="true"]')) return;
      if (layout.deepDive) { event.preventDefault(); ws.surfaces.closeDeepDive(); return; }
      const transient = [...shown].reverse().find((surface) => surface.persistence === 'transient');
      if (transient) { event.preventDefault(); close(transient); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const titleFor = (surface: Surface): { title: string; subtitle?: string } => {
    const root = surface.contextId ? ws.org.nodes.find((node) => node.id === surface.contextId) : null;
    if (surface.kind === 'artifact' && surface.contextId) {
      const path = displayPath(surface.contextId);
      return { title: path.split('/').at(-1) ?? path, subtitle: path };
    }
    return { title: TITLE[surface.kind] ?? surface.kind, subtitle: root ? titleOf(root.goal) : undefined };
  };

  const close = (surface: Surface) => {
    ws.surfaces.close(surface.id);
    setToast(`Closed ${titleFor(surface).title}`);
  };

  return (
    <div className="workspace-body" data-deep={layout.deepDive ? 'true' : 'false'}>
      <div className="primary-area">
        {layout.deepDive ? (
          <div className="deep-host">
            <div className="deep-bar">
              <button type="button" className="quiet-link back-link" onClick={ws.surfaces.closeDeepDive}>
                <Icon name="chevronLeft" size={14} /> Back to the conversation
              </button>
              {ws.detach && layout.deepDive.contextId && (
                <button type="button" className="quiet-link" onClick={() => ws.detach!(`${layout.deepDive!.contextId}`)}>
                  <Icon name="detach" size={14} /> Open in its own window
                </button>
              )}
            </div>
            <div className="deep-scroll">
              <ErrorBoundary what="This view" key={layout.deepDive.id}>
                <DeepDive target={layout.deepDive.contextId ?? ''} />
              </ErrorBoundary>
            </div>
          </div>
        ) : props.children}
      </div>

      {shown.map((surface) => {
        const { title, subtitle } = titleFor(surface);
        return (
          <ResizableSurface
            key={surface.id}
            surface={surface}
            title={title}
            subtitle={subtitle}
            onClose={() => close(surface)}
            onPin={(pinned) => ws.surfaces.pin(surface.id, pinned)}
            onCollapse={() => ws.surfaces.collapse(surface.id, true)}
            onResize={(w) => ws.surfaces.resize(surface.id, w)}
          >
            <ErrorBoundary what={title} key={surface.id}>
              <SurfaceContent surface={surface} attention={props.attention} />
            </ErrorBoundary>
          </ResizableSurface>
        );
      })}

      {waiting.length > 0 && (
        <nav className="surface-chips" aria-label="Collapsed surfaces">
          {waiting.map((surface) => (
            <button
              key={surface.id}
              type="button"
              className="surface-chip"
              data-pinned={surface.persistence === 'pinned'}
              onClick={() => ws.surfaces.open(surface.kind, surface.contextId)}
              title={titleFor(surface).subtitle ?? titleFor(surface).title}
            >
              {titleFor(surface).title}
            </button>
          ))}
        </nav>
      )}

      {toast && (
        <div className="toast" role="status">
          {toast}
          {ws.surfaces.canUndo() && (
            <button type="button" className="quiet-link" onClick={() => { ws.surfaces.undo(); setToast(null); }}>
              <Icon name="undo" size={13} /> Undo
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function SurfaceContent({ surface, attention }: { surface: Surface; attention: React.ReactNode }) {
  const ws = useWorkspace();
  const caseId = surface.contextId ?? ws.activeCase?.id ?? null;
  switch (surface.kind) {
    case 'files': return <FilesSurface />;
    case 'artifact': return surface.contextId ? <ArtifactSurface path={surface.contextId} /> : null;
    case 'memory': return <MemorySurface />;
    case 'attention': return <>{attention}</>;
    case 'plan':
    case 'decision':
    case 'activity':
    case 'run':
    case 'result':
      if (!caseId) return <p className="surface-empty">Start some work and it will show here.</p>;
      if (surface.kind === 'plan') return <PlanSurface caseId={caseId} />;
      if (surface.kind === 'decision') return <DecisionSurface caseId={caseId} />;
      if (surface.kind === 'activity') return <ActivitySurface caseId={caseId} />;
      return <RunTranscript caseId={caseId} />;
    default:
      return null;
  }
}
