import { useState, type JSX } from 'react';
import { SITE_CONTENT } from '../content';
import { MandatePanel } from '../components/MandatePanel';
import { DepthIndicator } from '../components/DepthIndicator';
import { track } from '../analytics/tracker';

export function MandateSection(): JSX.Element {
  const { mandate } = SITE_CONTENT;
  const [reviewed, setReviewed] = useState(false);

  return (
    <div className="mandate-section">
      <MandatePanel
        action={mandate.blockedAction}
        currentAuthority={mandate.currentAuthority}
        requiredAuthority={mandate.requiredAuthority}
        approved={false}
        onReview={() => {
          if (!reviewed) track('mandate_explored');
          setReviewed(true);
        }}
      />
      {reviewed ? (
        <div className="mandate-section__explanation" data-testid="mandate-explanation">
          <DepthIndicator level="technical" />
          <p className="mandate-section__explanation-text">{mandate.body}</p>
        </div>
      ) : null}
      <p className="mandate-section__followup">{mandate.followUp}</p>
    </div>
  );
}
