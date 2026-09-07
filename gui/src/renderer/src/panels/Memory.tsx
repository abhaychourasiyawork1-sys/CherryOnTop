import { useState } from 'react';
import { daemon } from '../lib/client.js';
import { useDaemonQuery } from '../lib/useDaemonQuery.js';
import { money, duration, ago, clip } from '../lib/format.js';

interface Observation {
  id: string;
  nodeId: string | null;
  goal: string | null;
  outcome: { runtime: string; succeeded: boolean; costUsd: number; latencyMs: number; complexity: string; delegated: boolean };
  createdAt: string;
}

interface Claim {
  runtime: string;
  runs: number;
  successRate: number;
  avgCostUsd: number;
  avgLatencyMs: number;
  basis: Observation[];
  excluded: Observation[];
}

/**
 * What the organization has learned about itself — as claims with their
 * receipts, not as statistics.
 *
 * The distinction is the whole feature. Every competitor's agent knowledge is
 * authored: someone writes down a convention and the agent recalls it. This is
 * measured, from runs that actually happened, with the sample size stated and
 * every contributing run one click away — and a veto, because a person who knows
 * a run was anomalous should be able to say so and have the next decision change.
 */
export function Memory({ onChanged, revision = 0 }: { onChanged?: () => void; revision?: number }) {
  // What the organization has learned changes as runs finish, so this is live
  // too — otherwise a run that completes while you are reading this page never
  // shows up in it.
  const claims = useDaemonQuery<Claim[]>(() => daemon().memory.claims.query() as Promise<Claim[]>, [revision]);
  const [openRuntime, setOpenRuntime] = useState<string | null>(null);

  if (claims.error) return <div className="sheet"><p className="inbox-error">{claims.error}</p></div>;
  if (!claims.data) return <div className="sheet" />;

  const stats = claims.data;

  if (stats.length === 0) {
    return (
      <div className="sheet">
        <div className="graph-empty">
          <h1>Nothing learned yet.</h1>
          <p>
            Every finished run records what it cost, how long it took and whether it worked.
            Once a runtime has a few runs behind it, the organization starts choosing on its
            own evidence instead of a default — and this page shows you that evidence, not a
            summary of it.
          </p>
        </div>
      </div>
    );
  }

  const cheapest = Math.min(...stats.map((s) => s.avgCostUsd));
  const fastest = Math.min(...stats.map((s) => s.avgLatencyMs));
  const best = Math.max(...stats.map((s) => s.successRate));

  const veto = async (id: string, vetoed: boolean) => {
    await daemon().memory.veto.mutate({ id, vetoed });
    claims.reload();
    onChanged?.();
  };

  return (
    <div className="sheet">
      <h1 className="sheet-title">What the organization has learned</h1>
      <p className="sheet-lead">
        Measured from its own finished runs, not from a benchmark. These are the numbers the
        runtime picks with — so excluding a run here changes what it does next.
      </p>

      <div className="memory-grid">
        {stats.map((stat) => (
          <section key={stat.runtime} className="memory-card">
            <h2>{stat.runtime}</h2>
            <p className="memory-runs figure">
              {stat.runs} run{stat.runs === 1 ? '' : 's'}
              {stat.excluded.length > 0 && <span className="ink-faint"> · {stat.excluded.length} excluded</span>}
            </p>

            {/* Sample size is the honest confidence signal. Anything smaller than
                a handful of runs is an anecdote, and saying so is better than
                printing a percentage that looks authoritative. */}
            {stat.runs < 5 && (
              <p className="memory-thin">Too few runs to lean on. Treat as an early signal.</p>
            )}

            <dl className="memory-stats">
              <div data-best={stat.successRate === best}>
                <dt>Succeeded</dt>
                <dd className="figure">{Math.round(stat.successRate * 100)}%</dd>
              </div>
              <div data-best={stat.avgCostUsd === cheapest}>
                <dt>Average cost</dt>
                <dd className="figure">{money(stat.avgCostUsd)}</dd>
              </div>
              <div data-best={stat.avgLatencyMs === fastest}>
                <dt>Average time</dt>
                <dd className="figure">{duration(stat.avgLatencyMs)}</dd>
              </div>
            </dl>

            <button
              type="button"
              className="linkish"
              aria-expanded={openRuntime === stat.runtime}
              onClick={() => setOpenRuntime(openRuntime === stat.runtime ? null : stat.runtime)}
            >
              {openRuntime === stat.runtime ? 'hide the runs behind this' : 'see the runs behind this'}
            </button>

            {openRuntime === stat.runtime && (
              <ul className="memory-basis">
                {[...stat.basis.map((o) => ({ o, excluded: false })),
                  ...stat.excluded.map((o) => ({ o, excluded: true }))]
                  .map(({ o, excluded }) => (
                    <li key={o.id} data-excluded={excluded}>
                      <span className="memory-basis-goal">{clip(o.goal ?? o.nodeId ?? 'a run', 44)}</span>
                      <span className="figure">
                        {o.outcome.succeeded ? '✓' : '✕'} {money(o.outcome.costUsd, 4)} · {duration(o.outcome.latencyMs)}
                      </span>
                      <span className="figure ink-faint">{ago(o.createdAt)}</span>
                      <button
                        type="button"
                        className="linkish"
                        onClick={() => void veto(o.id, !excluded)}
                        title={excluded ? 'Count this run again' : 'Stop this run counting towards what the organization believes'}
                      >
                        {excluded ? 'restore' : 'exclude'}
                      </button>
                    </li>
                  ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
