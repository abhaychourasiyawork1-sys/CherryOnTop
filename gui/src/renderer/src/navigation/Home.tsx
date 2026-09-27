import { ago } from '../lib/format.js';
import { titleOf } from '../lib/run.js';
import type { HomeModel } from '../lib/home.js';

/** Home asks "what should I continue?". No counts of agents or events: the
 *  things you were doing, what finished while you were away, and — only if
 *  something needs you — one line saying so. */
export function Home(props: {
  model: HomeModel;
  attention: number;
  composer: React.ReactNode;
  repoName: string | null;
  onOpenWorkspace: (key: string, caseId?: string) => void;
  onAttention: () => void;
}) {
  const { model } = props;
  return (
    <div className="home">
      <div className="home-column">
        <h1 className="home-title">{model.empty ? 'What should CherryOnTop work on?' : 'What next?'}</h1>
        {props.repoName && <p className="home-where">New work starts in {props.repoName}</p>}
        {props.composer}

        {props.attention > 0 && (
          <button type="button" className="home-attention" onClick={props.onAttention}>
            <span className="attention-pip" aria-hidden="true" />
            <span>{props.attention === 1 ? 'One thing needs your attention' : `${props.attention} things need your attention`}</span>
          </button>
        )}

        {model.continueWith.length > 0 && (
          <section className="home-section" aria-labelledby="home-continue">
            <h2 id="home-continue" className="section-label">Continue</h2>
            <ul className="home-list">
              {model.continueWith.map((ws) => {
                const latest = ws.cases[0];
                const status = ws.needsYou > 0 ? 'Needs you' : ws.running > 0 ? (ws.running === 1 ? 'Working' : `${ws.running} runs working`) : ago(ws.lastActivity);
                return (
                  <li key={ws.key}>
                    <button type="button" className="home-row" onClick={() => props.onOpenWorkspace(ws.key)}>
                      <span className="home-mark" aria-hidden="true">{ws.name.slice(0, 1).toUpperCase()}</span>
                      <span className="home-row-main">
                        <span className="home-row-name">{ws.name}</span>
                        {latest && <span className="home-row-sub">{titleOf(latest.goal)}</span>}
                      </span>
                      <span className="home-row-status" data-live={ws.running > 0} data-attention={ws.needsYou > 0}>{status}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {model.away.length > 0 && (
          <section className="home-section" aria-labelledby="home-away">
            <h2 id="home-away" className="section-label">While you were away</h2>
            <ul className="home-list">
              {model.away.map((entry) => {
                const parts = [];
                if (entry.finished.length) parts.push(`${entry.finished.length} finished`);
                if (entry.failed.length) parts.push(`${entry.failed.length} did not finish`);
                const newest = [...entry.finished, ...entry.failed].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
                return (
                  <li key={entry.workspaceKey}>
                    <button type="button" className="home-away" onClick={() => props.onOpenWorkspace(entry.workspaceKey, newest?.id)}>
                      <span className="home-row-name">{entry.workspaceName}</span>
                      <span className="home-away-what">{parts.join(', ')}</span>
                      {newest && <span className="home-row-sub">Latest: {titleOf(newest.goal)}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {!model.empty && model.quiet && <p className="home-quiet">Everything is up to date.</p>}
      </div>
    </div>
  );
}
