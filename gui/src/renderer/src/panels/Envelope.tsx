import type { Envelope as EnvelopeData } from '../lib/mandates.js';

/** What a mandate permits, what stops it, and what it was merely told.
 *
 *  The three are kept visually distinct on purpose. Rendering an advisory
 *  constraint in the same weight as an enforced boundary is how an authority
 *  model starts overstating itself — and an overstated boundary is worse than
 *  no boundary, because someone will rely on it. */
export function Envelope({ envelope, compact }: { envelope: EnvelopeData; compact?: boolean }) {
  return (
    <div className="envelope" data-compact={compact}>
      <section>
        <h4 className="envelope-head">It may</h4>
        <ul className="envelope-list">
          {envelope.permits.map((line) => <li key={line}>{line}</li>)}
        </ul>
      </section>

      <section>
        <h4 className="envelope-head envelope-head-stop">It stops and asks you before</h4>
        <ul className="envelope-list envelope-list-stop">
          {envelope.stops.map((line) => <li key={line}>{line}</li>)}
        </ul>
      </section>

      {envelope.advisory.length > 0 && (
        <section>
          <h4 className="envelope-head envelope-head-soft">Told, but not enforced</h4>
          <ul className="envelope-list envelope-list-soft">
            {envelope.advisory.map((line) => <li key={line}>{line}</li>)}
          </ul>
          <p className="envelope-caveat">
            These are instructions to the agent, not boundaries the platform holds it to.
          </p>
        </section>
      )}
    </div>
  );
}
