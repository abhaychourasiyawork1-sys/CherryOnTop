import { describe, it, expect } from 'vitest';
import { layoutTree, edgePath, CARD_WIDTH, CARD_HEIGHT } from './layout.js';

const at = (layout: ReturnType<typeof layoutTree>, id: string) =>
  layout.nodes.find((n) => n.id === id)!;

describe('layoutTree', () => {
  it('places a lone root at the origin margin', () => {
    const layout = layoutTree([{ id: 'root', parentId: null }]);
    expect(at(layout, 'root')).toMatchObject({ depth: 0, x: 48, y: 48 });
  });

  it('puts depth on the vertical axis, so ownership reads top to bottom', () => {
    const layout = layoutTree([
      { id: 'root', parentId: null },
      { id: 'a', parentId: 'root' },
      { id: 'a1', parentId: 'a' },
    ]);
    expect(at(layout, 'root').y).toBeLessThan(at(layout, 'a').y);
    expect(at(layout, 'a').y).toBeLessThan(at(layout, 'a1').y);
    expect(at(layout, 'a1').depth).toBe(2);
  });

  it('centres a parent over the block its children occupy', () => {
    const layout = layoutTree([
      { id: 'root', parentId: null },
      { id: 'a', parentId: 'root' },
      { id: 'b', parentId: 'root' },
      { id: 'c', parentId: 'root' },
    ]);
    const centre = (id: string) => at(layout, id).x + CARD_WIDTH / 2;
    expect(centre('root')).toBeCloseTo((centre('a') + centre('c')) / 2);
    expect(centre('root')).toBeCloseTo(centre('b'));
  });

  it('never overlaps siblings', () => {
    const layout = layoutTree([
      { id: 'root', parentId: null },
      { id: 'a', parentId: 'root' },
      { id: 'b', parentId: 'root' },
      { id: 'a1', parentId: 'a' },
      { id: 'a2', parentId: 'a' },
      { id: 'b1', parentId: 'b' },
    ]);
    const row = layout.nodes.filter((n) => n.depth === 2).sort((p, q) => p.x - q.x);
    for (let i = 1; i < row.length; i++) {
      expect(row[i].x).toBeGreaterThanOrEqual(row[i - 1].x + CARD_WIDTH);
    }
  });

  it('sizes the canvas to contain every card', () => {
    const layout = layoutTree([
      { id: 'root', parentId: null },
      { id: 'a', parentId: 'root' },
      { id: 'b', parentId: 'root' },
    ]);
    for (const node of layout.nodes) {
      expect(node.x + CARD_WIDTH).toBeLessThanOrEqual(layout.width);
      expect(node.y + CARD_HEIGHT).toBeLessThanOrEqual(layout.height);
    }
  });

  it('treats a node with a missing parent as a root instead of losing it', () => {
    const layout = layoutTree([
      { id: 'root', parentId: null },
      { id: 'orphan', parentId: 'gone' },
    ]);
    expect(layout.nodes).toHaveLength(2);
    expect(at(layout, 'orphan').depth).toBe(0);
  });

  it('places every node even if the input contains a cycle', () => {
    const layout = layoutTree([
      { id: 'x', parentId: 'y' },
      { id: 'y', parentId: 'x' },
    ]);
    expect(layout.nodes.map((n) => n.id).sort()).toEqual(['x', 'y']);
  });

  it('handles an empty organization', () => {
    expect(layoutTree([]).nodes).toEqual([]);
  });
});

describe('edgePath', () => {
  it('leaves the parent’s bottom edge and enters the child’s top edge', () => {
    const parent = { id: 'p', depth: 0, x: 0, y: 0 };
    const child = { id: 'c', depth: 1, x: 300, y: 200 };
    const path = edgePath(parent, child);
    expect(path.startsWith(`M ${CARD_WIDTH / 2} ${CARD_HEIGHT}`)).toBe(true);
    expect(path.endsWith(`L ${300 + CARD_WIDTH / 2} 200`)).toBe(true);
  });
});
