import { useState, type FormEvent, type JSX } from 'react';
import { SITE_CONTENT } from '../content';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type FormState = 'idle' | 'submitting' | 'success' | 'error';

export function LaunchForm(props: { onSuccess?: () => void }): JSX.Element {
  const { onSuccess } = props;
  const { launch } = SITE_CONTENT;
  const [email, setEmail] = useState('');
  const [state, setState] = useState<FormState>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  if (state === 'success') {
    return (
      <div className="launch-form launch-form--success" data-testid="launch-form-success">
        <p className="launch-form__success-headline">{launch.successHeadline}</p>
        <p className="launch-form__success-body">{launch.successBody}</p>
      </div>
    );
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!EMAIL_PATTERN.test(email)) {
      setErrorMessage('Enter a valid email address.');
      setState('error');
      return;
    }

    // Local-only stub: wiring to the /api/waitlist backend is a later task.
    setState('success');
    onSuccess?.();
  }

  return (
    <form className="launch-form" onSubmit={handleSubmit} noValidate>
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
          onChange={(event) => {
            setEmail(event.target.value);
            if (state === 'error') {
              setState('idle');
            }
          }}
        />
        <button type="submit" className="launch-form__submit" disabled={state === 'submitting'}>
          {launch.submitLabel}
        </button>
      </div>
      {state === 'error' ? (
        <p className="launch-form__error" role="alert">
          {errorMessage}
        </p>
      ) : null}
    </form>
  );
}
