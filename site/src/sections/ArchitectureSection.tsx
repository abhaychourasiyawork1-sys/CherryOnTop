import type { JSX } from 'react';
import { SITE_CONTENT } from '../content';
import { ArchitectureExplorer, type ArchitectureLayer } from '../components/ArchitectureExplorer';

function slugify(title: string): string {
  return title.toLowerCase().replace(/\s+/g, '-');
}

const LAYERS: ArchitectureLayer[] = SITE_CONTENT.architecture.layers.map((layer) => ({
  id: slugify(layer.title),
  ...layer,
}));

export function ArchitectureSection(): JSX.Element {
  return (
    <div className="architecture-section">
      <ArchitectureExplorer layers={LAYERS} />
    </div>
  );
}
