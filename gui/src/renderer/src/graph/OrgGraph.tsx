import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { layoutTree, edgePath, CARD_WIDTH, CARD_HEIGHT } from './layout.js';
import {
  fitView, zoomAround, zoomCentre, pan, panIntoView, wheelFactor,
  MIN_ZOOM, MAX_ZOOM, type View,
} from './viewport.js';
import { NodeCard } from './NodeCard.js';
import type { OrgNode, Approval } from '../lib/useOrg.js';

interface Props {
  nodes: OrgNode[];
  approvals: Approval[];
  freshNodeIds: Set<string>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
}

/** A child always gets a smaller budget than its parent — that is delegation
 *  working, not a boundary worth marking. The mark is for authority a child was
 *  actually denied: it cannot delegate onward, or it may use fewer tools. */
function narrowedAuthority(parent: OrgNode | undefined, node: OrgNode): boolean {
  if (!parent) return false;
  const from = parent.contract.authority;
  const to = node.contract.authority;
  return (from.spawn_children && !to.spawn_children) || to.tools.length < from.tools.length;
}

/** Pixels of movement before a press counts as a drag rather than a click. A
 *  card is a button, and a canvas you cannot drag from without opening
 *  something is not a canvas. */
const DRAG_SLOP = 4;

/**
 * The canvas: wheel to zoom about the pointer, drag to pan.
 *
 * The arithmetic lives in viewport.ts and is checked there. What is here is the
 * event plumbing, and its one subtlety is telling a drag from a click: every
 * node is a button, so a press that moves has to be swallowed rather than
 * delivered as a selection.
 */
function useCanvas(content: { width: number; height: number }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [panning, setPanning] = useState(false);
  // Set while a drag is in flight so the click it ends with can be swallowed.
  const dragged = useRef(false);
  // null means the view is still the automatic fit, so it re-fits as the
  // organization grows; any interaction pins it to what the person chose.
  const touched = useRef(false);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const fit = useCallback(() => {
    touched.current = false;
    setView(fitView(content, size));
  }, [content.width, content.height, size.width, size.height]);

  // Re-fit while nobody has taken control, so an organization that grows a
  // level stays wholly on screen instead of walking off the edge.
  useEffect(() => {
    if (touched.current) return;
    setView(fitView(content, size));
  }, [content.width, content.height, size.width, size.height]);

  // Non-passive, because zooming has to preventDefault to stop the window
  // scrolling underneath. React's onWheel is passive, so this is attached by
  // hand rather than as a prop.
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const box = element.getBoundingClientRect();
      const point = { x: event.clientX - box.left, y: event.clientY - box.top };
      touched.current = true;
      setView((current) => zoomAround(current, point, wheelFactor(event.deltaY, event.deltaMode)));
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, []);

  const onPointerDown = (event: React.PointerEvent) => {
    // Left button only: right-click belongs to the context menu, and a middle
    // click is a paste on Linux.
    if (event.button !== 0) return;
    const origin = { x: event.clientX, y: event.clientY };
    let moved = false;
    dragged.current = false;

    const onMove = (move: PointerEvent) => {
      const dx = move.clientX - origin.x;
      const dy = move.clientY - origin.y;
      if (!moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
      if (!moved) { moved = true; setPanning(true); touched.current = true; }
      // origin advances every move, so dx/dy is this step's distance. Not
      // movementX/Y: those are unreliable across display scaling, and this is
      // the one place a wrong number is felt immediately.
      origin.x = move.clientX;
      origin.y = move.clientY;
      setView((current) => pan(current, dx, dy));
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      dragged.current = moved;
      setPanning(false);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // A card's click fires after the drag that passed over it. Swallow it once.
  const onClickCapture = (event: React.MouseEvent) => {
    if (!dragged.current) return;
    dragged.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  const zoomBy = (factor: number) => {
    touched.current = true;
    setView((current) => zoomCentre(current, size, factor));
  };

  /** Keyboard focus has to move the view itself now that the container no
   *  longer scrolls. Called by the card that received focus, with its place on
   *  the canvas — the component knows the layout, this hook does not. */
  const revealRect = useCallback((rect: { x: number; y: number; width: number; height: number }) => {
    setView((current) => panIntoView(current, rect, size));
  }, [size.width, size.height]);

  return {
    viewport, view, panning, fit, onPointerDown, onClickCapture, revealRect,
    isFit: !touched.current,
    zoomIn: () => zoomBy(1.3),
    zoomOut: () => zoomBy(1 / 1.3),
  };
}

export function OrgGraph(props: Props) {
  const { nodes } = props;
  const layout = useMemo(
    () => layoutTree(nodes.map((n) => ({ id: n.id, parentId: n.parentId }))),
    [nodes],
  );
  const placeById = useMemo(
    () => new Map(layout.nodes.map((p) => [p.id, p])),
    [layout],
  );
  const awaiting = useMemo(() => new Set(props.approvals.map((a) => a.nodeId)), [props.approvals]);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const content = useMemo(
    () => ({ width: layout.width, height: layout.height }),
    [layout.width, layout.height],
  );
  const canvas = useCanvas(content);
  const { viewport, view } = canvas;

  if (nodes.length === 0) {
    return (
      <div className="graph-viewport" ref={viewport}>
        <div className="graph-empty">
          <h1>Nothing is running yet.</h1>
          <p>
            Describe what you want done. A root agent takes the goal, decides whether to do
            the work or delegate it, and the organization it builds appears here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="graph-viewport"
      ref={viewport}
      data-panning={canvas.panning}
      onPointerDown={canvas.onPointerDown}
      onClickCapture={canvas.onClickCapture}
    >
      <div className="zoom" role="group" aria-label="Zoom" onPointerDown={(event) => event.stopPropagation()}>
        <button type="button" onClick={canvas.zoomOut} aria-label="Zoom out" disabled={view.k <= MIN_ZOOM + 0.001}>−</button>
        <button
          type="button"
          className="zoom-level figure"
          onClick={canvas.fit}
          aria-label="Fit the whole organization"
          title="Fit the whole organization"
        >
          {canvas.isFit ? 'Fit' : `${Math.round(view.k * 100)}%`}
        </button>
        <button type="button" onClick={canvas.zoomIn} aria-label="Zoom in" disabled={view.k >= MAX_ZOOM - 0.001}>+</button>
      </div>

      <div
        className="graph-canvas"
        style={{
          width: layout.width,
          height: layout.height,
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
          transformOrigin: '0 0',
        }}
      >
        <svg className="graph-edges" width={layout.width} height={layout.height}>
          {nodes.map((node) => {
            if (!node.parentId) return null;
            const parent = placeById.get(node.parentId);
            const child = placeById.get(node.id);
            if (!parent || !child) return null;
            const budget = byId.get(node.id)?.contract.authority.budget_usd ?? 0;
            // Edge weight is the money delegated along it, so the shape of the
            // tree shows where the organization committed its resources.
            const weight = Math.min(1 + budget, 3.5);
            const length = Math.abs(child.y - parent.y) + Math.abs(child.x - parent.x) + CARD_WIDTH;
            return (
              <path
                key={node.id}
                className="edge"
                d={edgePath(parent, child)}
                strokeWidth={weight}
                data-fresh={props.freshNodeIds.has(node.id)}
                style={{ ['--len' as string]: length }}
              />
            );
          })}
        </svg>

        {layout.nodes.map((place) => {
          const node = byId.get(place.id);
          if (!node) return null;
          const parent = node.parentId ? byId.get(node.parentId) : undefined;
          return (
            <NodeCard
              key={node.id}
              node={node}
              place={place}
              childCount={node.childCount}
              costUsd={node.costUsd}
              needsApproval={awaiting.has(node.id)}
              delegatedAuthority={narrowedAuthority(parent, node)}
              selected={props.selectedId === node.id}
              fresh={props.freshNodeIds.has(node.id)}
              onSelect={() => props.onSelect(node.id)}
              onOpen={() => props.onOpen(node.id)}
              onReveal={() => canvas.revealRect({
                x: place.x, y: place.y, width: CARD_WIDTH, height: CARD_HEIGHT,
              })}
            />
          );
        })}
      </div>
    </div>
  );
}
