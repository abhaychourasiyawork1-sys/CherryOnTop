import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { search, KIND_LABEL, type SearchItem } from '../lib/search.js';
import { Icon } from '../shell/Icon.js';

/** Ctrl/Cmd+K: the whole organization, one keystroke away, without adding a
 *  single permanent navigation item. Results keep their Workspace so opening
 *  one lands in context. Actions are only listed when they are allowed. */
export function CommandPalette(props: {
  open: boolean;
  onClose: () => void;
  items: SearchItem[];
  onChoose: (item: SearchItem) => void;
}) {
  const [query, setQuery] = useState('');
  const deferred = useDeferredValue(query);
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    if (props.open) {
      opener.current = document.activeElement;
      setQuery('');
      setIndex(0);
      requestAnimationFrame(() => input.current?.focus());
    } else if (opener.current instanceof HTMLElement) {
      opener.current.focus();
    }
  }, [props.open]);

  const results = useMemo(() => search(props.items, deferred, 40), [props.items, deferred]);

  if (!props.open) return null;

  const choose = (item: SearchItem | undefined) => {
    if (!item) return;
    props.onClose();
    props.onChoose(item);
  };

  return (
    <div className="palette-scrim" data-modal-open="true" onMouseDown={props.onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Search and commands"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="palette-input">
          <Icon name="search" />
          <input
            ref={input}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-results"
            aria-activedescendant={results[index] ? `pal-${index}` : undefined}
            placeholder="Search runs, files, decisions, Workspaces — or type a command"
            value={query}
            onChange={(event) => { setQuery(event.target.value); setIndex(0); }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') { event.preventDefault(); setIndex((i) => Math.min(i + 1, results.length - 1)); }
              if (event.key === 'ArrowUp') { event.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); }
              if (event.key === 'Enter') { event.preventDefault(); choose(results[index]); }
              if (event.key === 'Escape') { event.preventDefault(); props.onClose(); }
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <ul className="palette-results" id="palette-results" role="listbox" aria-label="Results">
          {results.length === 0 && <li className="palette-empty">Nothing matches “{query}”.</li>}
          {results.map((item, i) => (
            <li
              key={`${item.kind}:${item.id}`}
              id={`pal-${i}`}
              role="option"
              aria-selected={i === index}
              className="palette-item"
              onMouseMove={() => setIndex(i)}
              onClick={() => choose(item)}
            >
              <span className="palette-kind">{KIND_LABEL[item.kind]}</span>
              <span className="palette-title">{item.title}</span>
              {item.subtitle && <span className="palette-sub">{item.subtitle}</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
