export function formatNodeLine(node: { id: string; state: string; goal: string }): string {
  const badge = node.state === 'COMPLETE' ? '✓' : node.state === 'FAILED' ? '✗' : '●';
  return `${badge} ${node.id.slice(0, 8)}  ${node.state.padEnd(20)} ${node.goal}`;
}
