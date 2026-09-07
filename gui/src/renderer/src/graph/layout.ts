export interface LayoutInput {
  id: string;
  parentId: string | null;
}

export interface PlacedNode {
  id: string;
  depth: number;
  x: number;
  y: number;
}

export interface Layout {
  nodes: PlacedNode[];
  width: number;
  height: number;
}

export const CARD_WIDTH = 208;
export const CARD_HEIGHT = 86;
const GAP_X = 28;
const GAP_Y = 76;
const MARGIN = 48;

/** Tidy tree, one pass down and one back up: leaves are packed left to right in
 *  sibling order, and every parent centres over the block its children occupy.
 *  x/y are the card's top-left corner in canvas pixels.
 *
 *  Deliberately not a layout library — an organization is tens of nodes, and a
 *  generic engine would cost a dependency plus the fight to make its output
 *  look like anything but a generic engine's output. */
export function layoutTree(input: LayoutInput[]): Layout {
  const known = new Set(input.map((n) => n.id));
  const childrenOf = new Map<string, string[]>();
  const roots: string[] = [];
  for (const node of input) {
    // A node whose parent is missing from the input is treated as a root rather
    // than dropped — an orphan you can see is debuggable, one you cannot is not.
    if (node.parentId && known.has(node.parentId)) {
      childrenOf.set(node.parentId, [...(childrenOf.get(node.parentId) ?? []), node.id]);
    } else {
      roots.push(node.id);
    }
  }

  const placed = new Map<string, PlacedNode>();
  let cursor = MARGIN;

  const place = (id: string, depth: number, seen: Set<string>): number => {
    if (seen.has(id)) return cursor;
    seen.add(id);
    const y = MARGIN + depth * (CARD_HEIGHT + GAP_Y);
    const children = childrenOf.get(id) ?? [];

    if (children.length === 0) {
      const x = cursor;
      cursor += CARD_WIDTH + GAP_X;
      placed.set(id, { id, depth, x, y });
      return x;
    }

    const childCentres = children.map((child) => place(child, depth + 1, seen) + CARD_WIDTH / 2);
    const centre = (Math.min(...childCentres) + Math.max(...childCentres)) / 2;
    const x = centre - CARD_WIDTH / 2;
    placed.set(id, { id, depth, x, y });
    return x;
  };

  const seen = new Set<string>();
  for (const root of roots) place(root, 0, seen);
  // Anything unreached (a cycle, which the runtime cannot produce today) still
  // gets a position rather than vanishing from the view.
  for (const node of input) if (!placed.has(node.id)) place(node.id, 0, seen);

  const nodes = [...placed.values()];
  return {
    nodes,
    width: Math.max(...nodes.map((n) => n.x + CARD_WIDTH), 0) + MARGIN,
    height: Math.max(...nodes.map((n) => n.y + CARD_HEIGHT), 0) + MARGIN,
  };
}

/** The accountability spine: down out of the parent, across, down into the
 *  child. Orthogonal rather than curved — a delegation line is a chain of
 *  command, and it should read as structure, not as flow. */
export function edgePath(parent: PlacedNode, child: PlacedNode): string {
  const x1 = parent.x + CARD_WIDTH / 2;
  const y1 = parent.y + CARD_HEIGHT;
  const x2 = child.x + CARD_WIDTH / 2;
  const y2 = child.y;
  const mid = y1 + (y2 - y1) / 2;
  return `M ${x1} ${y1} L ${x1} ${mid} L ${x2} ${mid} L ${x2} ${y2}`;
}
