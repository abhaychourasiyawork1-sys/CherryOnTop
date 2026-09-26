import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MandateSection } from '../src/sections/MandateSection';
import { DepthIndicator } from '../src/components/DepthIndicator';
import { SITE_CONTENT } from '../src/content';

describe('MandateSection', () => {
  it('shows the blocked action, current/required authority, and human approval required', () => {
    render(<MandateSection />);
    expect(screen.getByText(SITE_CONTENT.mandate.blockedAction)).toBeInTheDocument();
    expect(screen.getByText(/Current authority/i)).toBeInTheDocument();
    expect(screen.getByText('Development')).toBeInTheDocument();
    expect(screen.getByText(/Required authority/i)).toBeInTheDocument();
    expect(screen.getByText('Deployment')).toBeInTheDocument();
    expect(screen.getByText(/Human approval required/i)).toBeInTheDocument();
  });

  it('keeps the refusal calm: no attention-grabbing role or aggressive markup on the panel', () => {
    render(<MandateSection />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reveals the authority explanation on review without making a real backend request', () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(() => {
      throw new Error('no network calls expected from the demo');
    });

    render(<MandateSection />);
    expect(screen.queryByTestId('mandate-explanation')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /review/i }));

    expect(screen.getByTestId('mandate-explanation')).toBeInTheDocument();
    expect(screen.getByText(SITE_CONTENT.mandate.body)).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it('bridges to the next proof section with the approved follow-up copy', () => {
    render(<MandateSection />);
    expect(screen.getByText(SITE_CONTENT.mandate.followUp)).toBeInTheDocument();
  });
});

describe('DepthIndicator', () => {
  it('renders all three depth levels', () => {
    render(<DepthIndicator level="story" />);
    expect(screen.getByText('Story')).toBeInTheDocument();
    expect(screen.getByText('Product')).toBeInTheDocument();
    expect(screen.getByText('Technical')).toBeInTheDocument();
  });

  it('marks the current level as current, not by color alone', () => {
    render(<DepthIndicator level="technical" />);
    expect(screen.getByText('Technical').closest('[aria-current]')).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(screen.getByText('Story').closest('[aria-current]')).toHaveAttribute(
      'aria-current',
      'false',
    );
  });
});
