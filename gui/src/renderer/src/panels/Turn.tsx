import { useState } from 'react';
import type { RenderedLine } from '../../../../../src/tui/stream-renderer.js';
import { toneOf, labelOf } from '../lib/state.js';
import { activityOf, describeActivity, type Turn as TurnData } from '../lib/transcript.js';
import { Markdown } from './Markdown.js';
import { plainExcerpt } from '../lib/markdown.js';
import { agentName } from '../lib/agentName.js';
import { money } from '../lib/format.js';
import type { OrgNode } from '../lib/useOrg.js';

const GUTTER_STEP = 26;

interface Props {
  turn: TurnData;
  node: OrgNode | undefined;
  /** Where this agent sits in the numbered set, so a reader can refer to it. */
  index: number;
  /** True for the first turn this agent takes, which is the one that carries
   *  its name. A speaker re-announced on every turn is how a transcript starts
   *  reading as a log. */
  introduces: boolean;
  onOpenNode: (nodeId: string) => void;
}

export function Turn({ turn, node, index, introduces, onOpenNode }: Props) {
  const tone = node ? toneOf(node.state) : 'planning';

  return (
    <article
      className="turn"
      data-top={turn.depth === 0}
      data-phase={turn.phase}
      style={{
        ['--state' as string]: `var(--${tone})`,
        ['--indent' as string]: `${turn.depth * GUTTER_STEP}px`,
      }}
    >
      <span className="turn-spine" aria-hidden="true">
        <span className="turn-marker">{index}</span>
      </span>

      <div className="turn-body">
        {introduces && (
          <header className="turn-head">
            <button type="button" className="turn-name" onClick={() => onOpenNode(turn.nodeId)}>
              {node ? (node.parentId ? agentName(node.goal) : 'Root agent') : 'Agent'}
            </button>
            {node && <span className="turn-state">{labelOf(node.state)}</span>}
            {node && node.costUsd > 0 && <span className="turn-cost figure">{money(node.costUsd)}</span>}
          </header>
        )}

        {/* What the organization did, kept deliberately quiet: it is context for
            the speech, never the point of it. */}
        {turn.notes.length > 0 && (
          <ul className="turn-notes">
            {turn.notes.map((note, noteIndex) => (
              <li key={`${note.text}-${noteIndex}`} data-tone={note.tone}>
                {note.text}
                {note.count > 1 && <span className="figure"> ×{note.count}</span>}
              </li>
            ))}
          </ul>
        )}

        {turn.answer
          ? <Answer text={turn.answer} isRoot={turn.depth === 0} onOpen={() => onOpenNode(turn.nodeId)} />
          : <Said turn={turn} onOpen={() => onOpenNode(turn.nodeId)} />}
      </div>
    </article>
  );
}

/** What the agent actually said, with everything it did folded into one line
 *  beneath. Reversing the old order on purpose: the words come first, and the
 *  eighty tool calls that produced them are a count you can open. */
function Said({ turn, onOpen }: { turn: TurnData; onOpen: () => void }) {
  const [open, setOpen] = useState(false);
  const activity = activityOf(turn.lines);
  const spoken = turn.lines.filter((line) => line.kind === 'text' || line.kind === 'thinking');
  const rest = turn.lines.filter((line) => !spoken.includes(line));

  return (
    <>
      {spoken.map((line) => <Line key={line.key} line={line} />)}

      {activity.total > 0 && (
        <div className="did-strip">
          <button
            type="button"
            className="did-toggle"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            <span className="did-count figure">{describeActivity(activity)}</span>
            <span className="did-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
          </button>
          <button type="button" className="did-open" onClick={onOpen}>Open agent</button>
        </div>
      )}

      {open && <div className="did-detail">{rest.map((line) => <Line key={line.key} line={line} />)}</div>}
    </>
  );
}

/** The finished answer. A child's is collapsed to its opening — reading three
 *  of them in full is the work that was delegated in the first place. */
function Answer({ text, isRoot, onOpen }: { text: string; isRoot: boolean; onOpen: () => void }) {
  const [open, setOpen] = useState(isRoot);
  if (isRoot) return <div className="answer-block" data-root="true"><Markdown source={text} /></div>;

  return (
    <div className="answer-block">
      {open ? <Markdown source={text} /> : <p className="said">{plainExcerpt(text)}</p>}
      <div className="did-strip">
        <button type="button" className="did-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Show less' : 'Read what it reported'}
        </button>
        <button type="button" className="did-open" onClick={onOpen}>Open agent</button>
      </div>
    </div>
  );
}

function Line({ line }: { line: RenderedLine }) {
  const [open, setOpen] = useState(false);

  // Agent prose is Markdown — tables, code, headings, sometimes a diagram.
  if (line.kind === 'text') return <div className="said"><Markdown source={line.content} /></div>;

  if (line.kind === 'thinking') {
    const long = line.content.length > 280;
    if (!long) return <p className="thought">{line.content}</p>;
    return (
      <div className="thought">
        <button type="button" className="fold" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Hide thinking' : 'Show thinking'}
        </button>
        {open && <p>{line.content}</p>}
      </div>
    );
  }

  if (line.kind === 'summary') return <p className="run-summary figure">{line.content}</p>;

  const expandable = Boolean(line.diffLines?.length);
  return (
    <>
      <div className="did" data-kind={line.kind}>
        <button
          type="button"
          className="fold did-line"
          aria-expanded={expandable ? open : undefined}
          disabled={!expandable}
          onClick={() => expandable && setOpen(!open)}
        >
          <span className="figure">{line.content}</span>
        </button>
      </div>
      {expandable && open && (
        <pre className="diff">
          {line.diffLines!.map((diff, index) => (
            <span key={index} data-sign={diff[0] === '+' ? 'add' : diff[0] === '-' ? 'remove' : 'context'}>
              {diff}
              {'\n'}
            </span>
          ))}
        </pre>
      )}
    </>
  );
}
