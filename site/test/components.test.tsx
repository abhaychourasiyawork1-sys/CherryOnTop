import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import App from '../src/App';
import { StatusIndicator } from '../src/components/StatusIndicator';
import { ProductMetric } from '../src/components/ProductMetric';
import { ExecutionNode } from '../src/components/ExecutionNode';
import { MandatePanel } from '../src/components/MandatePanel';
import { ValidationState } from '../src/components/ValidationState';

describe('semantic app shell', () => {
  it('renders exactly one h1', () => {
    render(<App />);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('renders header, main, and footer landmark regions', () => {
    render(<App />);
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
  });

  it('does not set body overflow to hidden', () => {
    render(<App />);
    const bodyOverflow = window.getComputedStyle(document.body).overflow;
    expect(bodyOverflow).not.toBe('hidden');
  });

  it('renders the locked section anchors in order', () => {
    render(<App />);
    const anchors = [
      'product',
      'how-it-works',
      'organization',
      'mandate',
      'execution',
      'proof',
      'memory',
      'benchmarks',
      'architecture',
      'trust',
      'launch',
    ];
    for (const id of anchors) {
      expect(document.getElementById(id)).not.toBeNull();
    }
  });
});

describe('StatusIndicator', () => {
  it('renders the exact status label as visible text for each status', () => {
    const cases: Array<[Parameters<typeof StatusIndicator>[0]['status'], string]> = [
      ['working', 'Working'],
      ['waiting', 'Waiting'],
      ['attention', 'Needs attention'],
      ['recovering', 'Recovering'],
      ['validating', 'Validating'],
      ['verified', 'Verified'],
    ];
    for (const [status, label] of cases) {
      const { unmount } = render(<StatusIndicator status={status} />);
      expect(screen.getByText(label)).toBeInTheDocument();
      unmount();
    }
  });

  it('conveys status with an icon in addition to text, not color alone', () => {
    render(<StatusIndicator status="verified" />);
    const icon = screen.getByTestId('status-icon');
    expect(icon).toHaveAttribute('aria-hidden', 'true');
    expect(icon.textContent).not.toBe('');
    expect(screen.getByText('Verified')).toBeInTheDocument();
  });

  it('accepts an optional label override while keeping the status semantics', () => {
    render(<StatusIndicator status="working" label="Deploying" />);
    expect(screen.getByText('Deploying')).toBeInTheDocument();
  });
});

describe('ProductMetric', () => {
  it('renders the label and value', () => {
    render(<ProductMetric label="Budget" value="$5.00" />);
    expect(screen.getByText('Budget')).toBeInTheDocument();
    expect(screen.getByText('$5.00')).toBeInTheDocument();
  });

  it('applies a monospace treatment for figures when requested', () => {
    render(<ProductMetric label="Spend" value="$2.31" mono />);
    expect(screen.getByText('$2.31')).toHaveClass('product-metric__value--mono');
  });
});

describe('ExecutionNode', () => {
  it('exposes an accessible interactive button with role, status, and budget', () => {
    const onInspect = vi.fn();
    render(
      <ExecutionNode
        id="frontend"
        title="Frontend"
        role="Interface"
        status="working"
        budget="$1.20"
        onInspect={onInspect}
      />,
    );
    const button = screen.getByRole('button', { name: /frontend/i });
    expect(button).toBeInTheDocument();
    expect(screen.getByText('Working')).toBeInTheDocument();
    fireEvent.click(button);
    expect(onInspect).toHaveBeenCalledTimes(1);
  });

  it('marks the node as selected via an accessible attribute, not color alone', () => {
    render(
      <ExecutionNode
        id="backend"
        title="Backend"
        role="Services"
        status="waiting"
        budget="$0.80"
        selected
        onInspect={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /backend/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

describe('MandatePanel', () => {
  it('shows the requested action, current authority, and required authority', () => {
    render(
      <MandatePanel
        action="Deploy database migration"
        currentAuthority="Development"
        requiredAuthority="Deployment"
        approved={false}
        onReview={() => {}}
      />,
    );
    expect(screen.getByText('Deploy database migration')).toBeInTheDocument();
    expect(screen.getByText(/Development/)).toBeInTheDocument();
    expect(screen.getByText(/Deployment/)).toBeInTheDocument();
    expect(screen.getByText(/Human approval required/i)).toBeInTheDocument();
  });

  it('calls onReview when the review control is activated', () => {
    const onReview = vi.fn();
    render(
      <MandatePanel
        action="Deploy database migration"
        currentAuthority="Development"
        requiredAuthority="Deployment"
        approved={false}
        onReview={onReview}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /review/i }));
    expect(onReview).toHaveBeenCalledTimes(1);
  });

  it('does not show the blocked message once approved', () => {
    render(
      <MandatePanel
        action="Deploy database migration"
        currentAuthority="Deployment"
        requiredAuthority="Deployment"
        approved
        onReview={() => {}}
      />,
    );
    expect(screen.queryByText(/Human approval required/i)).not.toBeInTheDocument();
  });
});

describe('ValidationState', () => {
  it('shows the passed/total count and the Validating label while running', () => {
    render(<ValidationState passed={38} total={47} state="running" />);
    expect(screen.getByText('38 / 47')).toBeInTheDocument();
    expect(screen.getByText('Validating')).toBeInTheDocument();
  });

  it('shows the Needs attention label when failed', () => {
    render(<ValidationState passed={38} total={47} state="failed" />);
    expect(screen.getByText('Needs attention')).toBeInTheDocument();
  });

  it('shows the Verified label and the full illustrative count when verified', () => {
    render(<ValidationState passed={47} total={47} state="verified" />);
    expect(screen.getByText('47 / 47')).toBeInTheDocument();
    expect(screen.getByText('Verified')).toBeInTheDocument();
  });
});

describe('full page composition', () => {
  it('renders the main headings in the approved narrative order', () => {
    render(<App />);
    const headings = screen
      .getAllByRole('heading')
      .filter((heading) => heading.tagName === 'H1' || heading.tagName === 'H2')
      .map((heading) => heading.textContent ?? '');
    const expected = [
      'AI teams you can hold accountable.',
      'See how it works',
      'AI can do the work. But who controls it?',
      'One goal. An accountable AI organization.',
      'Autonomy without a blank cheque.',
      "Real work doesn't always go perfectly.",
      'Every important decision leaves a receipt.',
      'Work that keeps going.',
      'Spend intelligence where it matters.',
      'Under the interface is a real execution system.',
      'Built to be inspected.',
      'CherryOnTop is launching soon.',
    ];
    const positions = expected.map((text) => headings.findIndex((heading) => heading.includes(text)));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('marks sections with Story → Product → Technical depth without a progress bar', () => {
    const { container } = render(<App />);
    const depths = Array.from(container.querySelectorAll('[data-depth]')).map((node) =>
      node.getAttribute('data-depth'),
    );
    const rank = { story: 0, product: 1, technical: 2 } as Record<string, number>;
    const ranks = depths.map((depth) => rank[depth ?? ''] ?? -1);
    expect(ranks.length).toBeGreaterThan(5);
    expect(ranks.every((value, index) => value >= 0 && (index === 0 || value >= (ranks[index - 1] ?? 0)))).toBe(true);
    expect(new Set(depths)).toEqual(new Set(['story', 'product', 'technical']));
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    expect(screen.getByTestId('page-depth-indicator')).toBeInTheDocument();
  });

  it('gives each section a density rhythm', () => {
    const { container } = render(<App />);
    expect(container.querySelector('#organization')).toHaveAttribute('data-rhythm', 'dense');
    expect(container.querySelector('#launch')).toHaveAttribute('data-rhythm', 'quiet');
  });

  it('reuses the branch stem motif across organization, recovery, and architecture', () => {
    const { container } = render(<App />);
    for (const id of ['organization', 'execution', 'architecture']) {
      expect(container.querySelector(`#${id} [data-motif="branch-stem"]`)).not.toBeNull();
    }
  });

  it('mounts exactly one demo lifecycle for the whole story', () => {
    const { container } = render(<App />);
    expect(container.querySelectorAll('[data-demo-root]')).toHaveLength(1);
  });
});
