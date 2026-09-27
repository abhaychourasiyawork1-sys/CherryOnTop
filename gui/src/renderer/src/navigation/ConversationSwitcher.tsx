import { useEffect, useRef, useState } from 'react';
import { Icon } from '../shell/Icon.js';
import { MAIN, type Conversations } from '../lib/conversations.js';

/** Main, plus any focused conversations branched from it. Branching is always
 *  the person's choice; a branch keeps its own thread but shares the
 *  Workspace's runs, decisions and memory. */
export function ConversationSwitcher(props: {
  state: Conversations;
  current: string;
  onSwitch: (branchId: string) => void;
  onBranch: (name: string) => void;
  onDelete: (branchId: string) => void;
  canBranchFrom: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const currentName = props.current === MAIN ? 'Main' : props.state.branches.find((b) => b.id === props.current)?.name ?? 'Main';

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div className="convo" ref={root}>
      <button type="button" className="convo-trigger" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name="branch" size={13} />
        <span>{currentName}</span>
        <Icon name="chevronDown" size={12} />
      </button>
      {open && (
        <div
          className="convo-pop"
          role="menu"
          data-modal-open="true"
          onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); setOpen(false); } }}
        >
          <button type="button" role="menuitemradio" aria-checked={props.current === MAIN} className="convo-item" onClick={() => { props.onSwitch(MAIN); setOpen(false); }}>
            Main
          </button>
          {props.state.branches.map((branch) => (
            <div key={branch.id} className="convo-row">
              <button type="button" role="menuitemradio" aria-checked={props.current === branch.id} className="convo-item" onClick={() => { props.onSwitch(branch.id); setOpen(false); }}>
                {branch.name}
              </button>
              <button type="button" className="icon-button" aria-label={`Close conversation ${branch.name}; its runs return to Main`} title="Close — its runs return to Main" onClick={() => props.onDelete(branch.id)}>
                <Icon name="close" size={12} />
              </button>
            </div>
          ))}
          {naming ? (
            <form
              className="convo-new"
              onSubmit={(event) => { event.preventDefault(); props.onBranch(name); setName(''); setNaming(false); setOpen(false); }}
            >
              <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="What is it about?" aria-label="Name the new conversation" />
            </form>
          ) : (
            <button type="button" role="menuitem" className="convo-item convo-add" onClick={() => setNaming(true)}>
              <Icon name="plus" size={12} /> Focused conversation{props.canBranchFrom ? ' from this run' : ''}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
