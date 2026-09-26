export interface NavLink {
  label: string;
  href: string;
}

export interface ReceiptField {
  label: string;
  value: string;
}

export interface ArchitectureLayerContent {
  title: string;
  summary: string;
  children: { title: string; details: string }[];
}

export interface FooterGroup {
  title: string;
  links: NavLink[];
}

export interface SiteContent {
  nav: {
    links: NavLink[];
    cta: string;
  };
  footer: {
    groups: FooterGroup[];
  };
  hero: {
    eyebrow: string;
    headline: string;
    body: string;
    primaryCta: string;
    secondaryCta: string;
    supportLine: string;
  };
  problem: {
    headline: string;
    questions: string[];
  };
  organization: {
    headline: string;
    body: string;
    roles: string[];
    project: string;
  };
  mandate: {
    headline: string;
    body: string;
    blockedAction: string;
    currentAuthority: string;
    requiredAuthority: string;
    approvalRequired: string;
    followUp: string;
  };
  execution: {
    headline: string;
    signals: string[];
    failureLabel: string;
    failureBody: string;
    recoverySteps: string[];
    validationHeadline: string;
    validationPassed: number;
    validationTotal: number;
    verifiedLabel: string;
  };
  receipt: {
    headline: string;
    decision: string;
    fields: ReceiptField[];
  };
  longRunning: {
    headline: string;
    steps: string[];
    budgetLine: string;
  };
  memory: {
    headline: string;
    sequence: string[];
    reuseLine: string;
  };
  benchmarks: {
    headline: string;
    resolved: string;
    costDelta: string;
    tokenDelta: string;
    methodology: string;
    limitations: string;
    methodologyLink: string;
  };
  architecture: {
    headline: string;
    layers: ArchitectureLayerContent[];
  };
  trust: {
    headline: string;
    links: NavLink[];
  };
  launch: {
    headline: string;
    subline: string;
    emailLabel: string;
    submitLabel: string;
    successHeadline: string;
    successBody: string;
  };
}

export const SITE_CONTENT: SiteContent = {
  nav: {
    links: [
      { label: 'Product', href: '#product' },
      { label: 'How it works', href: '#how-it-works' },
      { label: 'Architecture', href: '#architecture' },
      { label: 'Benchmarks', href: '#benchmarks' },
      { label: 'Documentation', href: '/docs' },
    ],
    cta: 'Get CherryOnTop',
  },
  footer: {
    groups: [
      {
        title: 'Product',
        links: [
          { label: 'Product', href: '#product' },
          { label: 'Architecture', href: '#architecture' },
          { label: 'Benchmarks', href: '#benchmarks' },
        ],
      },
      {
        title: 'Resources',
        links: [
          { label: 'Documentation', href: '/docs' },
          { label: 'Benchmark methodology', href: '/docs/marketing/benchmarks.md' },
        ],
      },
      {
        title: 'Company',
        links: [
          { label: 'Trust', href: '#trust' },
          { label: 'Security', href: '/security' },
        ],
      },
      {
        title: 'Legal',
        links: [
          { label: 'Privacy', href: '/privacy' },
          { label: 'Terms', href: '/terms' },
        ],
      },
    ],
  },
  hero: {
    eyebrow: 'THE ACCOUNTABLE AI RUNTIME',
    headline: 'AI teams you can hold accountable.',
    body: 'Give autonomous AI work a goal, a mandate, a budget, and a way to prove the result.',
    primaryCta: 'Get CherryOnTop',
    secondaryCta: 'See how it works ↓',
    supportLine: 'Built for autonomous work that needs to get done—and checked.',
  },
  problem: {
    headline: 'AI can do the work. But who controls it?',
    questions: ['WHAT DID IT KNOW?', 'WHAT WAS IT ALLOWED TO DO?', 'DID IT ACTUALLY WORK?'],
  },
  organization: {
    headline: 'One goal. An accountable AI organization.',
    body: 'A single goal is organized into specialized, accountable responsibilities instead of one unsupervised agent.',
    roles: ['Frontend', 'Backend', 'Data', 'Verification'],
    project: 'Build a customer support platform',
  },
  mandate: {
    headline: 'Autonomy without a blank cheque.',
    body: 'Every action is checked against an explicit mandate before it runs, not after.',
    blockedAction: 'Deploy database migration',
    currentAuthority: 'Development',
    requiredAuthority: 'Deployment',
    approvalRequired: 'Human approval required',
    followUp: 'Permission is only half the problem.',
  },
  execution: {
    headline: "Real work doesn't always go perfectly.",
    signals: ['18 files read', '12 files changed', '31 commands'],
    failureLabel: 'Verification failed',
    failureBody: "The system doesn't pretend it didn't.",
    recoverySteps: ['Investigating', 'Affected component', 'Correction', 'Re-validation'],
    validationHeadline: "Done isn't enough. Prove it.",
    validationPassed: 47,
    validationTotal: 47,
    verifiedLabel: 'VERIFIED',
  },
  receipt: {
    headline: 'Every important decision leaves a receipt.',
    decision: 'Ship the verified customer platform build.',
    fields: [
      { label: 'OBJECTIVE', value: 'Build customer platform' },
      { label: 'AUTHORITY', value: 'Development mandate' },
      { label: 'BUDGET', value: '$5.00 authorized' },
      { label: 'SPEND', value: '$2.31 used' },
      { label: 'ACTIONS', value: '12 files changed · 31 commands executed' },
      { label: 'ARTIFACTS', value: '17 produced' },
      { label: 'VALIDATION', value: '47 checks passed' },
      { label: 'HUMAN INTERVENTION', value: '1 approval' },
      { label: 'OUTCOME', value: 'VERIFIED' },
    ],
  },
  longRunning: {
    headline: 'Work that keeps going.',
    steps: [
      'Goal received',
      'Organization formed',
      'Execution',
      'Issue discovered',
      'Recovery',
      'Validation',
      'Verified',
    ],
    budgetLine: '$2.84 / $5',
  },
  memory: {
    headline: 'The organization remembers what it learned.',
    sequence: [
      'RUN 01',
      'Observed',
      'Validated',
      'Remembered',
      'RUN 02',
      'Reused',
    ],
    reuseLine: 'Reuse what the organization has already verified.',
  },
  benchmarks: {
    headline: 'Spend intelligence where it matters.',
    resolved: '18 / 18 resolved',
    costDelta: 'approximately 15% lower mean cost/run',
    tokenDelta: 'approximately 15% fewer mean tokens/run',
    methodology: 'SWE-bench Verified · 6 tasks · 3 repetitions · controlled paired comparison · 18 runs',
    limitations:
      'This is one controlled benchmark, not a universal performance guarantee. Results are scoped to the documented tasks, repetitions, and comparison methodology.',
    methodologyLink: '/docs/marketing/benchmarks.md',
  },
  architecture: {
    headline: 'Under the interface is a real execution system.',
    layers: [
      {
        title: 'YOUR GOAL',
        summary: 'The objective you give the organization.',
        children: [],
      },
      {
        title: 'CONTROL PLANE',
        summary: 'Coordinates context, decisions, policy, state, and budget.',
        children: [
          { title: 'Context', details: 'What the organization currently knows.' },
          { title: 'Decision', details: 'What action is being considered.' },
          { title: 'Policy', details: 'What the mandate allows.' },
          { title: 'State', details: 'Where the work currently stands.' },
          { title: 'Budget', details: 'What resources remain.' },
        ],
      },
      {
        title: 'EXECUTION',
        summary: 'Specialized responsibilities carry out the work.',
        children: [],
      },
      {
        title: 'VALIDATION',
        summary: 'Independent checks confirm the work actually holds up.',
        children: [],
      },
      {
        title: 'PROOF',
        summary: 'Evidence of what happened and why it is trustworthy.',
        children: [
          { title: 'Evidence', details: 'What was observed during execution.' },
          { title: 'Artifacts', details: 'What was produced.' },
          { title: 'Validation', details: 'What was checked.' },
          { title: 'Decision Receipt', details: 'What was decided and by whose authority.' },
        ],
      },
    ],
  },
  trust: {
    headline: 'Built to be inspected.',
    links: [
      { label: 'Product', href: '#product' },
      { label: 'Benchmarks', href: '#benchmarks' },
      { label: 'Architecture', href: '#architecture' },
      { label: 'Documentation', href: '/docs' },
      { label: 'Security', href: '/security' },
    ],
  },
  launch: {
    headline: 'CherryOnTop is launching soon.',
    subline: 'Be among the first to get access.',
    emailLabel: 'Email address',
    submitLabel: 'Join the launch',
    successHeadline: "You're on the list.",
    successBody: "We'll let you know when CherryOnTop is ready.",
  },
};
