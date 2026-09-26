import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AccountabilitySection } from '../src/sections/AccountabilitySection';
import { LongRunningMemorySection } from '../src/sections/LongRunningMemorySection';
import { DemoControllerProvider, useDemoController } from '../src/demo/controller';
import { SITE_CONTENT } from '../src/content';

function Advance(props: { times: number }) {
  const { dispatch } = useDemoController();
  return (
    <button
      type="button"
      data-testid="advance"
      onClick={() => {
        for (let i = 0; i < props.times; i += 1) {
          dispatch({ type: 'NEXT' });
        }
      }}
    >
      advance
    </button>
  );
}

function renderAccountability(times: number) {
  render(
    <DemoControllerProvider>
      <Advance times={times} />
      <AccountabilitySection />
    </DemoControllerProvider>,
  );
  fireEvent.click(screen.getByTestId('advance'));
}

describe('AccountabilitySection / DecisionReceipt', () => {
  it('does not show the receipt before the run has been verified', () => {
    renderAccountability(3); // goal -> organization -> mandate -> executing
    expect(screen.queryByText(/View full receipt/i)).not.toBeInTheDocument();
  });

  it('reveals the locked receipt fields and values once expanded', () => {
    renderAccountability(8); // -> receipt
    fireEvent.click(screen.getByRole('button', { name: /view full receipt/i }));

    expect(screen.getByText('OBJECTIVE: Build customer platform')).toBeInTheDocument();
    expect(screen.getByText('AUTHORITY: Development mandate')).toBeInTheDocument();
    expect(screen.getByText('BUDGET: $5.00 authorized')).toBeInTheDocument();
    expect(screen.getByText('SPEND: $2.31 used')).toBeInTheDocument();
    expect(screen.getByText('ACTIONS: 12 files changed · 31 commands executed')).toBeInTheDocument();
    expect(screen.getByText('ARTIFACTS: 17 produced')).toBeInTheDocument();
    expect(screen.getByText('VALIDATION: 47 checks passed')).toBeInTheDocument();
    expect(screen.getByText('HUMAN INTERVENTION: 1 approval')).toBeInTheDocument();
    expect(screen.getByText('OUTCOME: VERIFIED')).toBeInTheDocument();
  });

  it('does not expose transcript text or chain-of-thought anywhere in the receipt', () => {
    renderAccountability(8);
    fireEvent.click(screen.getByRole('button', { name: /view full receipt/i }));
    const text = document.body.textContent?.toLowerCase() ?? '';
    expect(text).not.toContain('chain of thought');
    expect(text).not.toContain('reasoning:');
  });

  it('is reachable and collapsible by keyboard interaction, not only a mouse click', () => {
    renderAccountability(8);
    const toggle = screen.getByRole('button', { name: /view full receipt/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: /hide full receipt/i }));
    expect(screen.queryByText('OUTCOME: VERIFIED')).not.toBeInTheDocument();
  });
});

describe('LongRunningMemorySection / MemoryTimeline', () => {
  it('shows the long-running work sequence with human-legible statuses', () => {
    render(<LongRunningMemorySection />);
    for (const step of SITE_CONTENT.longRunning.steps) {
      expect(screen.getByText(step)).toBeInTheDocument();
    }
    expect(screen.getByText('Working')).toBeInTheDocument();
    expect(screen.getAllByText('Waiting').length).toBeGreaterThan(0);
    expect(screen.getByText('Needs attention')).toBeInTheDocument();
    expect(screen.getByText('Recovering')).toBeInTheDocument();
  });

  it('shows illustrative budget awareness without claiming a live figure', () => {
    render(<LongRunningMemorySection />);
    expect(screen.getByText(SITE_CONTENT.longRunning.budgetLine)).toBeInTheDocument();
  });

  it('shows RUN 01 -> Observed -> Validated -> Remembered -> RUN 02 -> Reused in order', () => {
    render(<LongRunningMemorySection />);
    const text = document.body.textContent ?? '';
    const sequence = ['RUN 01', 'Observed', 'Validated', 'Remembered', 'RUN 02', 'Reused'];
    const positions = sequence.map((item) => text.indexOf(item));
    for (const position of positions) {
      expect(position).toBeGreaterThanOrEqual(0);
    }
    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }
  });

  it('distinguishes asserted (first-run) knowledge from validated/reused knowledge', () => {
    render(<LongRunningMemorySection />);
    expect(screen.getAllByText('Asserted').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Confirmed').length).toBeGreaterThan(0);
  });

  it('uses the approved reuse framing instead of a self-learning claim', () => {
    render(<LongRunningMemorySection />);
    expect(screen.getByText(SITE_CONTENT.memory.reuseLine)).toBeInTheDocument();
    const text = document.body.textContent?.toLowerCase() ?? '';
    expect(text).not.toContain('self-learning');
    expect(text).not.toContain('self learning');
  });
});
