import { useState } from 'react';
import { daemon } from '../lib/client.js';
import { useDaemonQuery } from '../lib/useDaemonQuery.js';
import { money, duration, ago, basename, clip } from '../lib/format.js';

type Outcome = 'running' | 'waiting' | 'interrupted' | 'complete' | 'failed' | 'cancelled';

interface CaseSummary {
  id: string;
  goal: string;
  outcome: Outcome;
  mandateName: string | null;
  mandateId: string | null;
  runtime: string | null;
  repoPath: string | null;
  agents: number;
  costUsd: number;
  budgetUsd: number;
  budgetHealth: number;
  durationMs: number;
  dod: { met: number; unmet: number; unverified: number; total: number };
  pendingApprovals: number;
  humanDecisions: number;
  denials: number;
  createdAt: string;
}

interface Facets {
  runtimes: string[];
  repoPaths: string[];
  mandates: { id: string; name: string }[];
}

const OUTCOMES: { id: Outcome; label: string; tone: string }[] = [
  { id: 'running', label: 'Running', tone: 'executing' },
  { id: 'waiting', label: 'Waiting on you', tone: 'at-risk' },
  { id: 'interrupted', label: 'Interrupted', tone: 'planning' },
  { id: 'complete', label: 'Done', tone: 'settled' },
  { id: 'failed', label: 'Failed', tone: 'failed' },
  { id: 'cancelled', label: 'Stopped', tone: 'settled' },
];

const toneOfOutcome = (outcome: Outcome) => OUTCOMES.find((o) => o.id === outcome)?.tone ?? 'settled';
const labelOfOutcome = (outcome: Outcome) => OUTCOMES.find((o) => o.id === outcome)?.label ?? outcome;

interface Filters {
  search: string;
  outcomes: Outcome[];
  mandateIds: string[];
  runtimes: string[];
  repoPaths: string[];
  dod?: 'met' | 'outstanding';
  intervened?: boolean;
}

const EMPTY: Filters = { search: '', outcomes: [], mandateIds: [], runtimes: [], repoPaths: [] };

/** Every run ever, searchable. The single largest gap against every competitor:
 *  the old window could show you the task you were looking at and the ones in a
 *  rail beside it, and nothing else — there was no way to ask "what did the
 *  read-only mandate cost us last week". */
export function Cases({ onOpenCase, revision }: { onOpenCase: (id: string) => void; revision: number }) {
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const active = countActive(filters);

  const cases = useDaemonQuery<CaseSummary[]>(
    () => daemon().case.list.query({
      search: filters.search || undefined,
      outcomes: filters.outcomes.length ? filters.outcomes : undefined,
      mandateIds: filters.mandateIds.length ? filters.mandateIds : undefined,
      runtimes: filters.runtimes.length ? filters.runtimes : undefined,
      repoPaths: filters.repoPaths.length ? filters.repoPaths : undefined,
      dod: filters.dod,
      intervened: filters.intervened,
    }) as Promise<CaseSummary[]>,
    // `revision` is what makes this list live. Without it the page showed
    // whatever existed when it mounted and never changed again — a case you
    // started while looking at it simply never appeared.
    [JSON.stringify(filters), revision],
  );

  const facets = useDaemonQuery<Facets>(() => daemon().case.facets.query() as Promise<Facets>, [revision]);

  const rows = cases.data ?? [];
  const spend = rows.reduce((sum, row) => sum + row.costUsd, 0);

  return (
    <div className="cases">
      <header className="cases-head">
        <div className="cases-title">
          <h1>Cases</h1>
          <p className="figure cases-tally">
            {rows.length} {rows.length === 1 ? 'case' : 'cases'} · {money(spend)}
          </p>
        </div>

        <input
          className="cases-search"
          type="search"
          value={filters.search}
          placeholder="Search what you asked for"
          aria-label="Search cases"
          onChange={(event) => setFilters({ ...filters, search: event.target.value })}
        />
      </header>

      <div className="cases-filters">
        <ChipGroup
          label="Outcome"
          options={OUTCOMES.map((o) => ({ id: o.id, label: o.label }))}
          selected={filters.outcomes}
          onToggle={(id) => setFilters({ ...filters, outcomes: toggle(filters.outcomes, id as Outcome) })}
        />
        {facets.data && facets.data.mandates.length > 0 && (
          <ChipGroup
            label="Mandate"
            options={facets.data.mandates.map((m) => ({ id: m.id, label: m.name }))}
            selected={filters.mandateIds}
            onToggle={(id) => setFilters({ ...filters, mandateIds: toggle(filters.mandateIds, id) })}
          />
        )}
        {facets.data && facets.data.runtimes.length > 1 && (
          <ChipGroup
            label="Runtime"
            options={facets.data.runtimes.map((r) => ({ id: r, label: r }))}
            selected={filters.runtimes}
            onToggle={(id) => setFilters({ ...filters, runtimes: toggle(filters.runtimes, id) })}
          />
        )}
        {facets.data && facets.data.repoPaths.length > 1 && (
          <ChipGroup
            label="Repository"
            options={facets.data.repoPaths.map((p) => ({ id: p, label: basename(p) }))}
            selected={filters.repoPaths}
            onToggle={(id) => setFilters({ ...filters, repoPaths: toggle(filters.repoPaths, id) })}
          />
        )}
        <ChipGroup
          label="Checks"
          options={[{ id: 'met', label: 'All met' }, { id: 'outstanding', label: 'Outstanding' }]}
          selected={filters.dod ? [filters.dod] : []}
          onToggle={(id) => setFilters({ ...filters, dod: filters.dod === id ? undefined : (id as 'met' | 'outstanding') })}
        />
        <ChipGroup
          label="Human"
          options={[{ id: 'yes', label: 'A person decided' }, { id: 'no', label: 'Ran untouched' }]}
          selected={filters.intervened === undefined ? [] : [filters.intervened ? 'yes' : 'no']}
          onToggle={(id) => {
            const next = id === 'yes';
            setFilters({ ...filters, intervened: filters.intervened === next ? undefined : next });
          }}
        />
        {active > 0 && (
          <button type="button" className="chip chip-clear" onClick={() => setFilters(EMPTY)}>
            Clear {active}
          </button>
        )}
      </div>

      {cases.error && <p className="inbox-error">{cases.error}</p>}

      {rows.length === 0 ? (
        <div className="graph-empty">
          <h1>{active > 0 ? 'Nothing matches that.' : 'No cases yet.'}</h1>
          <p>
            {active > 0
              ? 'Loosen a filter, or clear them all.'
              : 'Every task you give becomes a case here — what it cost, what it produced, and who decided what along the way.'}
          </p>
        </div>
      ) : (
        <ul className="case-list">
          {rows.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                className="case-row"
                style={{ ['--state' as string]: `var(--${toneOfOutcome(row.outcome)})` }}
                onClick={() => onOpenCase(row.id)}
              >
                <span className="case-main">
                  <span className="case-goal">{clip(row.goal, 96)}</span>
                  <span className="case-sub">
                    <span className="pill">{labelOfOutcome(row.outcome)}</span>
                    {row.mandateName && <span className="tag">{row.mandateName}</span>}
                    {row.runtime && <span className="tag tag-quiet">{row.runtime}</span>}
                    {row.humanDecisions > 0 && (
                      <span className="tag tag-quiet">{row.humanDecisions} human decision{row.humanDecisions === 1 ? '' : 's'}</span>
                    )}
                    {row.denials > 0 && <span className="tag tag-warn">{row.denials} refused</span>}
                  </span>
                </span>

                <span className="case-figures">
                  <span className="figure" title="Agents in this organization">{row.agents}▪</span>
                  <span className="figure" data-over={row.budgetHealth > 1} title="Spent against its ceiling">
                    {money(row.costUsd)}<span className="ink-faint">/{money(row.budgetUsd)}</span>
                  </span>
                  <DodBadge dod={row.dod} />
                  <span className="figure ink-faint">{duration(row.durationMs)}</span>
                  <span className="figure ink-faint case-when">{ago(row.createdAt)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Checks met, out of checks promised. Unverified is shown as its own number
 *  rather than folded into "not met" — "we did not check" and "we checked and it
 *  is not done" are different answers, and a badge that merges them is a badge
 *  that lies. */
export function DodBadge({ dod }: { dod: { met: number; unmet: number; unverified: number; total: number } }) {
  if (dod.total === 0) return <span className="figure ink-faint" title="No checks recorded">—</span>;
  const tone = dod.unmet > 0 ? 'failed' : dod.met === dod.total ? 'executing' : 'at-risk';
  return (
    <span
      className="dod-badge figure"
      style={{ ['--state' as string]: `var(--${tone})` }}
      title={`${dod.met} met, ${dod.unmet} unmet, ${dod.unverified} unverified`}
    >
      ✓{dod.met}/{dod.total}
    </span>
  );
}

function ChipGroup(props: {
  label: string;
  options: { id: string; label: string }[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  return (
    <div className="chip-group" role="group" aria-label={props.label}>
      <span className="chip-label">{props.label}</span>
      {props.options.map((option) => (
        <button
          key={option.id}
          type="button"
          className="chip"
          aria-pressed={props.selected.includes(option.id)}
          onClick={() => props.onToggle(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

function countActive(filters: Filters): number {
  return filters.outcomes.length + filters.mandateIds.length + filters.runtimes.length
    + filters.repoPaths.length + (filters.dod ? 1 : 0) + (filters.intervened === undefined ? 0 : 1)
    + (filters.search ? 1 : 0);
}
