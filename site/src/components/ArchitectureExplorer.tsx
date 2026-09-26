import { useState, type JSX } from 'react';

export interface ArchitectureLayer {
  id: string;
  title: string;
  summary: string;
  children: { title: string; details: string }[];
}

export function ArchitectureExplorer(props: { layers: ArchitectureLayer[] }): JSX.Element {
  const { layers } = props;
  const [openLayerId, setOpenLayerId] = useState<string | null>(null);

  function toggleLayer(layerId: string) {
    setOpenLayerId((current) => (current === layerId ? null : layerId));
  }

  return (
    <ol className="architecture-explorer">
      {layers.map((layer, index) => {
        const expandable = layer.children.length > 0;
        const isOpen = openLayerId === layer.id;

        return (
          <li key={layer.id} className="architecture-explorer__layer">
            {index > 0 ? <span className="architecture-explorer__connector" aria-hidden="true">↓</span> : null}

            {expandable ? (
              <button
                type="button"
                className="architecture-explorer__title architecture-explorer__title--button"
                aria-expanded={isOpen}
                onClick={() => toggleLayer(layer.id)}
              >
                {layer.title}
              </button>
            ) : (
              <p className="architecture-explorer__title">{layer.title}</p>
            )}
            <p className="architecture-explorer__summary">{layer.summary}</p>

            {expandable && isOpen ? (
              <ul className="architecture-explorer__children" data-testid={`architecture-children-${layer.id}`}>
                {layer.children.map((child) => (
                  <li key={child.title} className="architecture-explorer__child">
                    <p className="architecture-explorer__child-title">{child.title}</p>
                    <p className="architecture-explorer__child-details">{child.details}</p>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
