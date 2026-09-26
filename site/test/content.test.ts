import { describe, expect, it } from 'vitest';
import { SITE_CONTENT } from '../src/content';

function flattenStrings(value: unknown, acc: string[] = []): string[] {
  if (typeof value === 'string') {
    acc.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) flattenStrings(item, acc);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) flattenStrings(item, acc);
  }
  return acc;
}

const allStrings = flattenStrings(SITE_CONTENT).join('\n');

describe('SITE_CONTENT locked hero strings', () => {
  it('contains the exact hero copy', () => {
    expect(SITE_CONTENT.hero.eyebrow).toBe('THE ACCOUNTABLE AI RUNTIME');
    expect(SITE_CONTENT.hero.headline).toBe('AI teams you can hold accountable.');
    expect(SITE_CONTENT.hero.body).toBe(
      'Give autonomous AI work a goal, a mandate, a budget, and a way to prove the result.',
    );
    expect(SITE_CONTENT.hero.primaryCta).toBe('Get CherryOnTop');
    expect(SITE_CONTENT.hero.secondaryCta).toBe('See how it works ↓');
    expect(SITE_CONTENT.hero.supportLine).toBe(
      'Built for autonomous work that needs to get done—and checked.',
    );
  });
});

describe('SITE_CONTENT problem, organization, mandate copy', () => {
  it('contains the exact problem headline and three questions', () => {
    expect(SITE_CONTENT.problem.headline).toBe('AI can do the work. But who controls it?');
    expect(SITE_CONTENT.problem.questions).toEqual([
      'WHAT DID IT KNOW?',
      'WHAT WAS IT ALLOWED TO DO?',
      'DID IT ACTUALLY WORK?',
    ]);
  });

  it('contains the exact organization headline and role vocabulary', () => {
    expect(SITE_CONTENT.organization.headline).toBe(
      'One goal. An accountable AI organization.',
    );
    expect(SITE_CONTENT.organization.roles).toEqual([
      'Frontend',
      'Backend',
      'Data',
      'Verification',
    ]);
  });

  it('contains the exact mandate copy', () => {
    expect(SITE_CONTENT.mandate.headline).toBe('Autonomy without a blank cheque.');
    expect(SITE_CONTENT.mandate.blockedAction).toBe('Deploy database migration');
    expect(SITE_CONTENT.mandate.currentAuthority).toBe('Development');
    expect(SITE_CONTENT.mandate.requiredAuthority).toBe('Deployment');
    expect(SITE_CONTENT.mandate.approvalRequired).toBe('Human approval required');
  });
});

describe('SITE_CONTENT execution, receipt, memory copy', () => {
  it('contains the recurring customer-support-platform demo scenario', () => {
    expect(allStrings).toContain('Build a customer support platform');
  });

  it('contains the exact execution headline and illustrative signals', () => {
    expect(SITE_CONTENT.execution.headline).toBe("Real work doesn't always go perfectly.");
    expect(SITE_CONTENT.execution.signals).toEqual(
      expect.arrayContaining(['18 files read', '12 files changed', '31 commands']),
    );
  });

  it('contains the exact locked receipt fields and values', () => {
    const receiptText = SITE_CONTENT.receipt.fields.map((f) => `${f.label}: ${f.value}`);
    expect(receiptText).toContain('OBJECTIVE: Build customer platform');
    expect(receiptText).toContain('AUTHORITY: Development mandate');
    expect(receiptText).toContain('BUDGET: $5.00 authorized');
    expect(receiptText).toContain('SPEND: $2.31 used');
    expect(receiptText).toContain('ACTIONS: 12 files changed · 31 commands executed');
    expect(receiptText).toContain('ARTIFACTS: 17 produced');
    expect(receiptText).toContain('VALIDATION: 47 checks passed');
    expect(receiptText).toContain('HUMAN INTERVENTION: 1 approval');
    expect(receiptText).toContain('OUTCOME: VERIFIED');
  });

  it('does not expose transcript text or chain-of-thought in the receipt', () => {
    const receiptText = JSON.stringify(SITE_CONTENT.receipt).toLowerCase();
    expect(receiptText).not.toContain('chain of thought');
    expect(receiptText).not.toContain('reasoning:');
  });

  it('contains the exact memory sequence copy', () => {
    expect(SITE_CONTENT.memory.headline).toBe('The organization remembers what it learned.');
    expect(allStrings).toContain('Reuse what the organization has already verified.');
  });
});

describe('SITE_CONTENT navigation, benchmarks, architecture, trust, launch', () => {
  it('contains the exact nav labels', () => {
    const labels = SITE_CONTENT.nav.links.map((l) => l.label);
    expect(labels).toEqual([
      'Product',
      'How it works',
      'Architecture',
      'Benchmarks',
      'Documentation',
    ]);
    expect(SITE_CONTENT.nav.cta).toBe('Get CherryOnTop');
  });

  it('contains scope-qualified benchmark methodology copy', () => {
    expect(SITE_CONTENT.benchmarks.headline).toBe('Spend intelligence where it matters.');
    expect(SITE_CONTENT.benchmarks.methodology).toContain('SWE-bench Verified');
    expect(SITE_CONTENT.benchmarks.methodology).toContain('6 tasks');
    expect(SITE_CONTENT.benchmarks.methodology).toContain('3 repetitions');
    expect(SITE_CONTENT.benchmarks.limitations.length).toBeGreaterThan(0);
  });

  it('contains the exact architecture headline and layer sequence', () => {
    expect(SITE_CONTENT.architecture.headline).toBe(
      'Under the interface is a real execution system.',
    );
    expect(SITE_CONTENT.architecture.layers.map((l) => l.title)).toEqual([
      'YOUR GOAL',
      'CONTROL PLANE',
      'EXECUTION',
      'VALIDATION',
      'PROOF',
    ]);
  });

  it('contains the exact trust headline', () => {
    expect(SITE_CONTENT.trust.headline).toBe('Built to be inspected.');
  });

  it('contains the exact launch/waitlist copy', () => {
    expect(SITE_CONTENT.launch.headline).toBe('CherryOnTop is launching soon.');
    expect(SITE_CONTENT.launch.subline).toBe('Be among the first to get access.');
    expect(SITE_CONTENT.launch.submitLabel).toBe('Join the launch');
    expect(SITE_CONTENT.launch.successHeadline).toBe("You're on the list.");
  });
});

describe('SITE_CONTENT forbidden marketing strings', () => {
  it('does not name competitor/model-provider/model names', () => {
    const forbidden = [
      'OpenAI',
      'Anthropic',
      'GPT',
      'ChatGPT',
      'Claude',
      'Gemini',
      'Llama',
      'Mistral',
      'Copilot',
    ];
    for (const term of forbidden) {
      expect(allStrings).not.toContain(term);
    }
  });

  it('does not claim to be open source', () => {
    expect(allStrings.toLowerCase()).not.toContain('open source');
    expect(allStrings.toLowerCase()).not.toContain('open-source');
  });

  it('does not use unsupported performance multiplier language', () => {
    expect(allStrings.toLowerCase()).not.toMatch(/\d+x (faster|cheaper|better)/);
  });
});
