import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ProblemSection } from '../src/sections/ProblemSection';
import { OrganizationSection } from '../src/sections/OrganizationSection';
import { DemoControllerProvider, useDemoController } from '../src/demo/controller';
import { SITE_CONTENT } from '../src/content';

function Advance(props: { times: number }) {
  const { dispatch } = useDemoController();
  return (
    <button type="button" data-testid="advance" onClick={() => {
      for (let i = 0; i < props.times; i += 1) {
        dispatch({ type: 'NEXT' });
      }
    }}>
      advance
    </button>
  );
}

function State() {
  const { snapshot } = useDemoController();
  return <div data-testid="state">{snapshot.state}</div>;
}

function renderOrganization() {
  return render(
    <DemoControllerProvider>
      <State />
      <Advance times={1} />
      <OrganizationSection />
    </DemoControllerProvider>,
  );
}

describe('ProblemSection', () => {
  it('renders the approved headline and the three framing questions', () => {
    render(<ProblemSection />);
    expect(screen.getByText(SITE_CONTENT.problem.headline)).toBeInTheDocument();
    for (const question of SITE_CONTENT.problem.questions) {
      expect(screen.getByText(question)).toBeInTheDocument();
    }
  });

  it('keeps the explanatory copy in the DOM as semantic text', () => {
    render(<ProblemSection />);
    expect(
      screen.getByRole('heading', { name: SITE_CONTENT.problem.headline }),
    ).toBeInTheDocument();
  });
});

describe('OrganizationSection', () => {
  it('shows only the single goal before the organization state is reached', () => {
    render(
      <DemoControllerProvider>
        <OrganizationSection />
      </DemoControllerProvider>,
    );
    expect(screen.getByText(/Build a customer support platform/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /frontend/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /backend/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /verification/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^data/i })).not.toBeInTheDocument();
  });

  it('reveals Frontend, Backend, and Verification in deterministic order once organized, without Data', () => {
    renderOrganization();
    fireEvent.click(screen.getByTestId('advance'));
    expect(screen.getByTestId('state')).toHaveTextContent('organization');

    const buttons = screen.getAllByRole('button').filter((el) => el.hasAttribute('data-node-id'));
    expect(buttons.map((el) => el.getAttribute('data-node-id'))).toEqual([
      'frontend',
      'backend',
      'verification',
    ]);
    expect(screen.queryByRole('button', { name: /^data/i })).not.toBeInTheDocument();
  });

  it('reveals Data only once the demo reaches a deeper execution state', () => {
    render(
      <DemoControllerProvider>
        <State />
        <Advance times={3} />
        <OrganizationSection />
      </DemoControllerProvider>,
    );
    fireEvent.click(screen.getByTestId('advance'));
    expect(screen.getByTestId('state')).toHaveTextContent('executing');
    expect(screen.getByRole('button', { name: /^data/i })).toBeInTheDocument();
  });

  it('lets inspecting a node reveal role, authority, and budget without altering lifecycle state', () => {
    renderOrganization();
    fireEvent.click(screen.getByTestId('advance'));
    expect(screen.getByTestId('state')).toHaveTextContent('organization');

    fireEvent.click(screen.getByRole('button', { name: /frontend/i }));

    expect(screen.getByTestId('state')).toHaveTextContent('organization');
    const inspector = screen.getByTestId('organization-inspector');
    expect(within(inspector).getByText(/Builds the customer-facing support UI/i)).toBeInTheDocument();
    expect(within(inspector).getByText('Development')).toBeInTheDocument();
    expect(within(inspector).getByText('$1.25')).toBeInTheDocument();
  });

  it('marks neighboring nodes as quieter while one node is inspected', () => {
    renderOrganization();
    fireEvent.click(screen.getByTestId('advance'));

    const frontendButton = screen.getByRole('button', { name: /frontend/i });
    const backendButton = screen.getByRole('button', { name: /backend/i });
    fireEvent.click(frontendButton);

    expect(frontendButton).not.toHaveClass('execution-node--dimmed');
    expect(backendButton).toHaveClass('execution-node--dimmed');
  });
});
