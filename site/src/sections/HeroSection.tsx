import type { JSX } from 'react';
import { SITE_CONTENT } from '../content';
import { DEMO_PROJECT } from '../demo/data';
import { useDemoController } from '../demo/controller';
import { StatusIndicator } from '../components/StatusIndicator';
import type { DemoState } from '../demo/types';
import type { Status } from '../types';

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

  return (
    <div className="hero">
      <div className="hero__copy">
        <p className="hero__eyebrow">{hero.eyebrow}</p>
        <h1 className="hero__headline">{hero.headline}</h1>
        <p className="hero__body">{hero.body}</p>
        <div className="hero__ctas">
          <a className="hero__cta hero__cta--primary" href="#launch">
            {hero.primaryCta}
          </a>
          <a className="hero__cta hero__cta--secondary" href="#how-it-works">
            {hero.secondaryCta}
          </a>
        </div>
        <p className="hero__support">{hero.supportLine}</p>
      </div>

      <div className="hero__demo" data-testid="hero-demo" aria-live="polite">
        <p className="hero__demo-goal">{DEMO_PROJECT}</p>
        <StatusIndicator
          status={HERO_STATE_STATUS[snapshot.state]}
          label={HERO_STATE_LABEL[snapshot.state]}
        />
      </div>
    </div>
  );
}
