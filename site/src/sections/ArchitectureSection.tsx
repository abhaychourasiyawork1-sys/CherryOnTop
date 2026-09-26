import type { JSX } from 'react';
import { SITE_CONTENT } from '../content';
import { ArchitectureExplorer, type ArchitectureLayer } from '../components/ArchitectureExplorer';
import { BranchStem } from '../components/BranchStem';
import { useOptionalDemoController } from '../demo/controller';
import type { DemoState } from '../demo/types';

const PROOF_STATES = new Set<DemoState>(['verified', 'receipt', 'memory']);

function slugify(title: string): string {
  return title.toLowerCase().replace(/\s+/g, '-');
}

const LAYERS: ArchitectureLayer[] = SITE_CONTENT.architecture.layers.map((layer) => ({
  id: slugify(layer.title),
  ...layer,
}));

export function ArchitectureSection(): JSX.Element {
  const controller = useOptionalDemoController();
  // The cherry-mark reveal is a motion reward, so it stays absent under reduced motion.
  const formsMark = Boolean(controller && !controller.reducedMotion && PROOF_STATES.has(controller.snapshot.state));

  return (
    <div className="architecture-section">
      <BranchStem variant="architecture" formsMark={formsMark} />
      <ArchitectureExplorer layers={LAYERS} />
    </div>
  );
}
