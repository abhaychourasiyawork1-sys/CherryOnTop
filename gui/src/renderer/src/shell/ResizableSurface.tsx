import { useRef } from 'react';
import { Icon } from './Icon.js';
import { MIN_WIDTH, MAX_WIDTH, type Surface } from '../lib/surfaces.js';

interface Props {
  surface: Surface;
  title: string;
  subtitle?: string;
  onClose: () => void;
  onPin: (pinned: boolean) => void;
  onCollapse: () => void;
  onResize: (width: number) => void;
  onDetach?: () => void;
  children: React.ReactNode;
}

/** One side surface: a title, a few quiet controls, and a resize edge that
 *  works with a pointer or the keyboard (arrow keys on the focused edge). */
export function ResizableSurface(props: Props) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const pinned = props.surface.persistence === 'pinned';

  return (
    <section
      className="surface"
      data-kind={props.surface.kind}
      style={{ width: props.surface.width }}
      aria-label={props.title}
    >
      <div
        className="surface-edge"
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${props.title}`}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        aria-valuenow={props.surface.width}
        tabIndex={0}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          start.current = { x: event.clientX, width: props.surface.width };
        }}
        onPointerMove={(event) => {
          if (!start.current) return;
          props.onResize(start.current.width + (start.current.x - event.clientX));
        }}
        onPointerUp={() => { start.current = null; }}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 96 : 24;
          if (event.key === 'ArrowLeft') { event.preventDefault(); props.onResize(props.surface.width + step); }
          if (event.key === 'ArrowRight') { event.preventDefault(); props.onResize(props.surface.width - step); }
          if (event.key === 'Home') { event.preventDefault(); props.onResize(MAX_WIDTH); }
          if (event.key === 'End') { event.preventDefault(); props.onResize(MIN_WIDTH); }
        }}
      />
      <header className="surface-head">
        <div className="surface-titles">
          <h2 className="surface-title">{props.title}</h2>
          {props.subtitle && <p className="surface-subtitle">{props.subtitle}</p>}
        </div>
        <div className="surface-tools">
          {props.onDetach && (
            <button type="button" className="icon-button" onClick={props.onDetach} aria-label="Open in its own window" title="Open in its own window">
              <Icon name="detach" />
            </button>
          )}
          <button
            type="button"
            className="icon-button"
            aria-pressed={pinned}
            onClick={() => props.onPin(!pinned)}
            aria-label={pinned ? 'Unpin' : 'Pin to keep it open'}
            title={pinned ? 'Pinned — stays open' : 'Pin to keep it open'}
          >
            <Icon name="pin" />
          </button>
          <button type="button" className="icon-button" onClick={props.onCollapse} aria-label="Collapse" title="Collapse">
            <Icon name="chevronRight" />
          </button>
          <button type="button" className="icon-button" onClick={props.onClose} aria-label={`Close ${props.title}`} title="Close (Esc)">
            <Icon name="close" />
          </button>
        </div>
      </header>
      <div className="surface-body">{props.children}</div>
    </section>
  );
}
