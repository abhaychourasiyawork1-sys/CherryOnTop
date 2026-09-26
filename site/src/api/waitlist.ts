export interface WaitlistSubmission {
  email: string;
  intent?: string;
  honeypot?: string;
  consentVersion?: string | null;
}

export interface WaitlistResult {
  accepted: true;
}

export class WaitlistApiError extends Error {
  readonly kind: 'invalid' | 'rate_limited' | 'network';

  constructor(kind: 'invalid' | 'rate_limited' | 'network') {
    super(kind);
    this.kind = kind;
  }
}

export async function submitWaitlist(input: WaitlistSubmission): Promise<WaitlistResult> {
  let response: Response;
  try {
    response = await fetch('/api/waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  } catch {
    throw new WaitlistApiError('network');
  }

  if (response.status === 429) {
    throw new WaitlistApiError('rate_limited');
  }

  if (!response.ok) {
    throw new WaitlistApiError('invalid');
  }

  return (await response.json()) as WaitlistResult;
}
