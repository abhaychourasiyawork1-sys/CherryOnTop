export type Screen =
  | { name: 'home' }
  | { name: 'tree' }
  | { name: 'node'; nodeId: string }
  | { name: 'decision-log'; nodeId: string }
  | { name: 'output'; nodeId: string }
  | { name: 'new-run' };

export function pushScreen(stack: Screen[], screen: Screen): Screen[] {
  return [...stack, screen];
}

export function popScreen(stack: Screen[]): Screen[] {
  return stack.length <= 1 ? stack : stack.slice(0, -1);
}

export function breadcrumb(stack: Screen[]): string {
  return stack.map((s) => {
    if (s.name === 'node') return `node:${s.nodeId.slice(0, 8)}`;
    if (s.name === 'decision-log' || s.name === 'output') return `${s.name}:${s.nodeId.slice(0, 8)}`;
    return s.name;
  }).join(' › ');
}
