import type { JSX } from 'react';
import { SITE_CONTENT } from '../content';
import { track } from '../analytics/tracker';
import { DEMO_NODES, DEMO_PROJECT } from '../demo/data';
import { useDemoController } from '../demo/controller';
import { StatusIndicator } from '../components/StatusIndicator';
import type { DemoState } from '../demo/types';
import type { Status } from '../types';

/** Decorative, looping console rows — illustrative only (content policy §3). */
const CONSOLE_LOG = [
  { t: '00:01', label: 'goal received', cost: '$0.00' },
  { t: '00:04', label: 'org formed · 4 roles', cost: '$0.12' },
  { t: '00:09', label: 'mandate checked', cost: '$0.03' },
  { t: '00:31', label: 'check failed → investigating', cost: '$0.41' },
  { t: '00:48', label: 'correction re-validated', cost: '$0.36' },
  { t: '01:02', label: 'receipt written', cost: '$0.05' },
];


const HERO_STATE_LABEL: Record<DemoState, string> = {
  goal: 'Goal received',
  organization: 'Organizing into responsibilities',
  mandate: 'Mandate set',
  executing: 'Executing',
  failure: 'Verification failed',
  recovering: 'Recovering',
  validating: 'Validating',
  verified: 'Verified',
  receipt: 'Receipt ready',
  memory: 'Remembered',
};

const HERO_STATE_STATUS: Record<DemoState, Status> = {
  goal: 'working',
  organization: 'working',
  mandate: 'waiting',
  executing: 'working',
  failure: 'attention',
  recovering: 'recovering',
  validating: 'validating',
  verified: 'verified',
  receipt: 'verified',
  memory: 'verified',
};

export function HeroSection(): JSX.Element {
  const { hero } = SITE_CONTENT;
  const { snapshot } = useDemoController();
  const [lineOne, lineTwo] = splitHeadline(hero.headline);

  return (
    <div className="hero">
      <div className="hero__copy">
        <p className="hero__eyebrow">
          <span className="hero__eyebrow-dot" aria-hidden="true" />
          {hero.eyebrow}
        </p>
        <h1 className="hero__headline">
          <span className="hero__line">
            <span className="hero__line-inner">{lineOne}</span>
          </span>{' '}
          <span className="hero__line">
            <span className="hero__line-inner hero__line-inner--accent">{lineTwo}</span>
          </span>
        </h1>
        <p className="hero__body">{hero.body}</p>
        <div className="hero__ctas">
          <a className="hero__cta hero__cta--primary" href="#launch" onClick={() => track('hero_cta_clicked')}>
            {hero.primaryCta}
          </a>
          <a className="hero__cta hero__cta--secondary" href="#how-it-works">
            {hero.secondaryCta}
          </a>
        </div>
        <p className="hero__support">{hero.supportLine}</p>
      </div>

      <div className="hero__console" data-spotlight>
        <div className="hero__console-bar" aria-hidden="true">
          <span className="hero__console-lights">
            <i />
            <i />
            <i />
          </span>
          <span className="hero__console-title">run · illustrative</span>
          <span className="hero__console-live">live</span>
        </div>

        <div className="hero__demo" data-testid="hero-demo" data-demo-state={snapshot.state} aria-live="polite">
          <p className="hero__demo-goal">{DEMO_PROJECT}</p>
          <StatusIndicator
            status={HERO_STATE_STATUS[snapshot.state]}
            label={HERO_STATE_LABEL[snapshot.state]}
          />
        </div>

        <ul className="hero__tree" aria-hidden="true">
          <li className="hero__tree-root">
            <span>org/root</span>
            <span className="hero__tree-cost">$5.00 cap</span>
          </li>
          {DEMO_NODES.map((node, index) => (
            <li key={node.id} className="hero__tree-node" style={{ '--i': index } as React.CSSProperties}>
              <span>└ {node.id}</span>
              <span className="hero__tree-bar">
                <span style={{ '--w': `${40 + index * 14}%` } as React.CSSProperties} />
              </span>
              <span className="hero__tree-cost">{node.budget}</span>
            </li>
          ))}
        </ul>

        <ol className="hero__log" aria-hidden="true">
          {CONSOLE_LOG.map((row, index) => (
            <li
              key={row.t}
              className={`hero__log-row${row.label.startsWith('check failed') ? ' hero__log-row--alert' : ''}`}
              style={{ '--i': index } as React.CSSProperties}
            >
              <span className="hero__log-time">{row.t}</span>
              <span className="hero__log-label">{row.label}</span>
              <span className="hero__log-cost">{row.cost}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/** Split the locked headline into two display lines without changing its text. */
function splitHeadline(headline: string): [string, string] {
  const marker = ' hold ';
  const at = headline.indexOf(marker);
  if (at === -1) return [headline, ''];
  return [headline.slice(0, at), headline.slice(at + 1)];
}
