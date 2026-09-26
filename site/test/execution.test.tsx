import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ExecutionSection } from '../src/sections/ExecutionSection';
import { DemoControllerProvider, useDemoController } from '../src/demo/controller';
import { SITE_CONTENT } from '../src/content';

function Advance() {
  const { dispatch } = useDemoController();
  return (
    <button type="button" data-testid="advance" onClick={() => dispatch({ type: 'NEXT' })}>
      advance
    </button>
  );
}

function renderExecution() {
  return render(
    <DemoControllerProvider>
      <Advance />
      <ExecutionSection />
    </DemoControllerProvider>,
  );
}

function advanceTimes(n: number) {
  const button = screen.getByTestId('advance');
  for (let i = 0; i < n; i += 1) {
    fireEvent.click(button);
  }
}

describe('ExecutionSection', () => {
  it('shows the approved concrete signals once execution begins', () => {
    renderExecution();
    advanceTimes(3); // goal -> organization -> mandate -> executing
    for (const signal of SITE_CONTENT.execution.signals) {
      expect(screen.getByText(signal)).toBeInTheDocument();
    }
  });

  it('shows a visible failure before recovery, without erasing the earlier signals', () => {
    renderExecution();
    advanceTimes(4); // -> failure
    expect(screen.getByText(SITE_CONTENT.execution.failureLabel)).toBeInTheDocument();
    expect(screen.getByText(SITE_CONTENT.execution.failureBody)).toBeInTheDocument();
    for (const signal of SITE_CONTENT.execution.signals) {
      expect(screen.getByText(signal)).toBeInTheDocument();
    }
    expect(screen.getByText('38 / 47')).toBeInTheDocument();
  });

  it('shows the recovery sequence while recovering', () => {
    renderExecution();
    advanceTimes(5); // -> recovering
    for (const step of SITE_CONTENT.execution.recoverySteps) {
      expect(screen.getByText(step)).toBeInTheDocument();
    }
  });

  it('shows 38 / 47 before 47 / 47 across one continuous lifecycle', () => {
    renderExecution();
    advanceTimes(4); // -> failure
    expect(screen.getByText('38 / 47')).toBeInTheDocument();
    expect(screen.queryByText('47 / 47')).not.toBeInTheDocument();

    advanceTimes(3); // recovering -> validating -> verified
    expect(screen.getByText('47 / 47')).toBeInTheDocument();
    expect(screen.getByText('VERIFIED')).toBeInTheDocument();
  });

  it('does not erase the earlier timeline signals once verified', () => {
    renderExecution();
    advanceTimes(7); // -> verified
    for (const signal of SITE_CONTENT.execution.signals) {
      expect(screen.getByText(signal)).toBeInTheDocument();
    }
  });
});
