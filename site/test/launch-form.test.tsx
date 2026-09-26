import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { LaunchForm } from '../src/components/LaunchForm';
import { SITE_CONTENT } from '../src/content';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('LaunchForm', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it('blocks submission locally for an empty or invalid email', () => {
    render(<LaunchForm />);
    fireEvent.click(screen.getByRole('button', { name: SITE_CONTENT.launch.submitLabel }));
    expect(fetch).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(SITE_CONTENT.launch.emailLabel), {
      target: { value: 'not-an-email' },
    });
    fireEvent.click(screen.getByRole('button', { name: SITE_CONTENT.launch.submitLabel }));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('disables the submit button while the request is pending', async () => {
    let resolveFetch: (value: Response) => void = () => {};
    (fetch as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );

    render(<LaunchForm />);
    fireEvent.change(screen.getByLabelText(SITE_CONTENT.launch.emailLabel), {
      target: { value: 'pending@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: SITE_CONTENT.launch.submitLabel }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: SITE_CONTENT.launch.submitLabel })).toBeDisabled();
    });

    resolveFetch(jsonResponse(202, { accepted: true }));
    await waitFor(() => {
      expect(screen.getByTestId('launch-form-success')).toBeInTheDocument();
    });
  });

  it('shows the exact success copy on a successful response', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(jsonResponse(202, { accepted: true }));

    render(<LaunchForm />);
    fireEvent.change(screen.getByLabelText(SITE_CONTENT.launch.emailLabel), {
      target: { value: 'success@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: SITE_CONTENT.launch.submitLabel }));

    await waitFor(() => {
      expect(screen.getByText(SITE_CONTENT.launch.successHeadline)).toBeInTheDocument();
      expect(screen.getByText(SITE_CONTENT.launch.successBody)).toBeInTheDocument();
    });

    expect(fetch).toHaveBeenCalledWith(
      '/api/waitlist',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });

  it('treats a duplicate-email response as success', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(jsonResponse(202, { accepted: true }));

    render(<LaunchForm />);
    fireEvent.change(screen.getByLabelText(SITE_CONTENT.launch.emailLabel), {
      target: { value: 'dup@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: SITE_CONTENT.launch.submitLabel }));

    await waitFor(() => {
      expect(screen.getByTestId('launch-form-success')).toBeInTheDocument();
    });
  });

  it('shows a retry-safe message on 429 without exposing server details', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(jsonResponse(429, { error: 'rate_limited' }));

    render(<LaunchForm />);
    fireEvent.change(screen.getByLabelText(SITE_CONTENT.launch.emailLabel), {
      target: { value: 'ratelimited@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: SITE_CONTENT.launch.submitLabel }));

    await waitFor(() => {
      const alert = screen.getByRole('alert');
      expect(alert.textContent).not.toMatch(/rate_limited|sql|stack/i);
      expect(alert.textContent?.length).toBeGreaterThan(0);
    });
  });

  it('preserves the entered email and shows a generic error on network failure', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network down'));

    render(<LaunchForm />);
    const input = screen.getByLabelText(SITE_CONTENT.launch.emailLabel) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'keepme@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: SITE_CONTENT.launch.submitLabel }));

    await waitFor(() => {
      const alert = screen.getByRole('alert');
      expect(alert.textContent).not.toMatch(/network down/i);
    });
    expect(input.value).toBe('keepme@example.com');
  });

  it('renders a consent checkbox only when a consent version is configured', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_MARKETING_CONSENT_VERSION', '2026-01-01');
    const { LaunchForm: WithConsent } = await import('../src/components/LaunchForm');
    const { unmount } = render(<WithConsent />);
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
    unmount();

    vi.resetModules();
    vi.stubEnv('VITE_MARKETING_CONSENT_VERSION', '');
    const { LaunchForm: WithoutConsent } = await import('../src/components/LaunchForm');
    render(<WithoutConsent />);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
});
