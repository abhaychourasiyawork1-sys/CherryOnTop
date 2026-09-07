import { counterfactual } from '../../../../../src/engines/economics.js';

interface Decision {
  id: string;
  type: string;
  outcome: string;
  breakdown: Record<string, number>;
  createdAt: string;
}

// The economics formula from src/engines/economics.ts, in the order it is
// applied. Anything the engine adds that isn't listed here still renders — it
// falls through to the tail — so a new term can never be silently hidden.
const TERMS: { key: string; label: string; sign: 1 | -1 }[] = [
  { key: 'estimatedValue', label: 'Expected value', sign: 1 },
  { key: 'modelCost', label: 'Model cost', sign: -1 },
  { key: 'latencyCost', label: 'Latency', sign: -1 },
  { key: 'coordinationCost', label: 'Coordination', sign: -1 },
  { key: 'verificationCost', label: 'Verification', sign: -1 },
  { key: 'riskPenalty', label: 'Risk', sign: -1 },
];

// What happened, and how it should read. Escalating is not a success — colouring
// it by whether the score cleared the threshold would paint "it stopped and
// asked you" in the same green as "it went ahead".
const OUTCOMES: Record<string, { text: string; tone: 'executing' | 'at-risk' | 'settled' }> = {
  DELEGATE: { text: 'Delegated', tone: 'executing' },
  SELF_EXECUTE: { text: 'Did the work itself', tone: 'executing' },
  ESCALATE: { text: 'Stopped and asked you', tone: 'at-risk' },
};

export function WhyPanel({ decision }: { decision: Decision }) {
  const { breakdown } = decision;
  const listed = new Set([...TERMS.map((t) => t.key), 'score', 'threshold']);
  const extra = Object.entries(breakdown).filter(([key]) => !listed.has(key));
  const score = breakdown.score ?? 0;
  const threshold = breakdown.threshold ?? 0;
  // A runtime_selection's outcome is an adapter name, not one of the delegation
  // outcomes — it reads as itself, and settles rather than shouting.
  const verdict = OUTCOMES[decision.outcome] ?? { text: `Chose ${decision.outcome}`, tone: 'settled' as const };

  return (
    <div className="why">
      <ol className="ledger">
        {TERMS.filter((term) => breakdown[term.key] !== undefined).map((term) => {
          const value = breakdown[term.key] * term.sign;
          return (
            <li key={term.key}>
              <span>{term.label}</span>
              <span className="figure" data-negative={value < 0}>{signed(value)}</span>
            </li>
          );
        })}
        <li data-total="true">
          <span>Net score</span>
          <span className="figure" data-negative={score < 0}>{signed(score)}</span>
        </li>
        <li data-threshold="true">
          <span>Delegation threshold</span>
          <span className="figure">{signed(threshold)}</span>
        </li>
      </ol>

      <p
        className="why-verdict"
        style={{ ['--state' as string]: `var(--${verdict.tone})` }}
      >
        {verdict.text}
      </p>

      <WhyNot breakdown={breakdown} />

      {extra.length > 0 && (
        <ol className="ledger ledger-extra">
          {extra.map(([key, value]) => (
            <li key={key}>
              <span>{humanize(key)}</span>
              <span className="figure">{formatExtra(key, value)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** The single change that would have flipped this decision.
 *
 *  Only possible because the decision is arithmetic rather than a paragraph a
 *  model wrote about itself. It is the strongest available evidence that the
 *  reasoning shown above is the reasoning that actually ran. */
function WhyNot({ breakdown }: { breakdown: Record<string, number> }) {
  const flip = counterfactual(breakdown);
  if (!flip) return null;
  return (
    <p className="why-counterfactual">
      Had <span className="figure">{humanize(flip.term).toLowerCase()}</span> been{' '}
      <span className="figure">${flip.margin.toFixed(2)}</span> {flip.direction}, it would have{' '}
      {flip.wouldHave}.
    </p>
  );
}

function signed(value: number): string {
  return `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(2)}`;
}

function humanize(key: string): string {
  const spaced = key.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function formatExtra(key: string, value: number): string {
  return /budget|cost|usd/i.test(key) ? `$${value.toFixed(2)}` : value.toFixed(2);
}
