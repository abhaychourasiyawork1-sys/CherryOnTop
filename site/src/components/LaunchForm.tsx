import { useState, type FormEvent, type JSX } from 'react';
import { SITE_CONTENT } from '../content';
import { MARKETING_CONSENT_VERSION } from '../marketingConfig';
import { submitWaitlist, WaitlistApiError } from '../api/waitlist';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type FormState = 'idle' | 'submitting' | 'success' | 'error';

export function LaunchForm(props: { onSuccess?: () => void }): JSX.Element {
  const { onSuccess } = props;
  const { launch } = SITE_CONTENT;
  const [email, setEmail] = useState('');
  const [intent, setIntent] = useState('');
  const [consentGiven, setConsentGiven] = useState(false);
  const [state, setState] = useState<FormState>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [hasStarted, setHasStarted] = useState(false);
  const requiresConsent = Boolean(MARKETING_CONSENT_VERSION);

  if (state === 'success') {
    return (
      <div className="launch-form launch-form--success" data-testid="launch-form-success">
        <p className="launch-form__success-headline">{launch.successHeadline}</p>
        <p className="launch-form__success-body">{launch.successBody}</p>
      </div>
    );
  }

  function markStarted() {
    if (!hasStarted) {
      setHasStarted(true);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!EMAIL_PATTERN.test(email)) {
      setErrorMessage(launch.invalidEmailMessage);
      setState('error');
      return;
    }

    if (requiresConsent && !consentGiven) {
      setErrorMessage(launch.invalidEmailMessage);
      setState('error');
      return;
    }

    setState('submitting');

    try {
      await submitWaitlist({
        email,
        intent: intent || undefined,
        consentVersion: requiresConsent ? MARKETING_CONSENT_VERSION : null,
      });
      setState('success');
      onSuccess?.();
    } catch (error) {
      if (error instanceof WaitlistApiError && error.kind === 'rate_limited') {
        setErrorMessage(launch.rateLimitedMessage);
      } else {
        setErrorMessage(launch.genericErrorMessage);
      }
      setState('error');
    }
  }

  return (
    <form className="launch-form" onSubmit={(event) => void handleSubmit(event)} noValidate>
      <label className="launch-form__label" htmlFor="launch-email">
        {launch.emailLabel}
      </label>
      <div className="launch-form__row">
        <input
          id="launch-email"
          name="email"
          type="email"
          className="launch-form__input"
          value={email}
          onFocus={markStarted}
          onChange={(event) => {
            setEmail(event.target.value);
            markStarted();
            if (state === 'error') {
              setState('idle');
            }
          }}
        />
        <button type="submit" className="launch-form__submit" disabled={state === 'submitting'}>
          {launch.submitLabel}
        </button>
      </div>

      <label className="launch-form__label launch-form__label--intent" htmlFor="launch-intent">
        {launch.intentLabel}
      </label>
      <select
        id="launch-intent"
        name="intent"
        className="launch-form__select"
        value={intent}
        onChange={(event) => setIntent(event.target.value)}
      >
        <option value="">—</option>
        {launch.intentOptions.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>

      {requiresConsent ? (
        <label className="launch-form__consent">
          <input
            type="checkbox"
            checked={consentGiven}
            onChange={(event) => setConsentGiven(event.target.checked)}
          />
          {launch.consentLabel}
        </label>
      ) : null}

      {state === 'error' ? (
        <p className="launch-form__error" role="alert">
          {errorMessage}
        </p>
      ) : null}
    </form>
  );
}
