import type { JSX } from 'react';
import { SITE_CONTENT } from '../content';
import { LaunchForm } from '../components/LaunchForm';

export function LaunchSection(): JSX.Element {
  const { launch } = SITE_CONTENT;

  return (
    <div className="launch-section">
      <p className="launch-section__subline">{launch.subline}</p>
      <LaunchForm />
    </div>
  );
}
