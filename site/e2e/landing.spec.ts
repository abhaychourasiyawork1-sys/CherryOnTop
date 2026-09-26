import { expect, test, type Page } from '@playwright/test';

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(2);
}

test.describe('mobile product exploration', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test.beforeEach(async ({ page }) => {
    await page.route('**/api/**', (route) =>
      route.fulfill({ status: 202, contentType: 'application/json', body: '{"accepted":true}' }),
    );
    await page.goto('/');
  });

  test('mobile menu opens, focuses first item, and closes', async ({ page }) => {
    const trigger = page.getByRole('button', { name: /menu/i });
    await trigger.tap();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const firstLink = page.locator('.site-header__mobile-menu a').first();
    await expect(firstLink).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger).toBeFocused();
    await trigger.tap();
    await firstLink.tap();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  test('mobile organization can be inspected by tap', async ({ page }) => {
    const node = page.locator('#organization .execution-node').first();
    await node.scrollIntoViewIfNeeded();
    await node.tap();
    await expect(node).toHaveAttribute('aria-pressed', 'true');
  });

  test('mobile mandate panel fits without horizontal scroll', async ({ page }) => {
    const panel = page.locator('#mandate .mandate-panel');
    await panel.scrollIntoViewIfNeeded();
    const box = await panel.boundingBox();
    expect(box).not.toBeNull();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390 + 1);
    await expectNoHorizontalOverflow(page);
  });

  test('mobile execution timeline is vertical', async ({ page }) => {
    const timeline = page.locator('#execution .execution-timeline');
    await timeline.scrollIntoViewIfNeeded();
    await expect(timeline).toHaveCSS('flex-direction', 'column');
  });

  test('mobile receipt fields stack', async ({ page }) => {
    const toggle = page.locator('#proof .decision-receipt [aria-expanded]').first();
    await toggle.scrollIntoViewIfNeeded();
    await toggle.tap();
    const fields = page.locator('#proof .decision-receipt__field');
    const count = await fields.count();
    expect(count).toBeGreaterThan(1);
    const first = await fields.nth(0).boundingBox();
    const second = await fields.nth(1).boundingBox();
    expect((second?.y ?? 0)).toBeGreaterThan((first?.y ?? 0) + 1);
    expect(Math.abs((second?.x ?? 0) - (first?.x ?? 0))).toBeLessThanOrEqual(2);
  });

  test('mobile architecture layers expand', async ({ page }) => {
    const layer = page.locator('#architecture [aria-expanded]').first();
    await layer.scrollIntoViewIfNeeded();
    await layer.tap();
    await expect(layer).toHaveAttribute('aria-expanded', 'true');
  });

  test('mobile CTA form is reachable', async ({ page }) => {
    const email = page.locator('#launch-email');
    await email.scrollIntoViewIfNeeded();
    await expect(email).toBeInViewport();
    await email.tap();
    await expect(email).toBeFocused();
  });

  test('mobile document width never materially exceeds the viewport', async ({ page }) => {
    for (const id of ['product', 'organization', 'mandate', 'execution', 'proof', 'benchmarks', 'architecture', 'launch']) {
      await page.locator(`#${id}`).scrollIntoViewIfNeeded();
      await expectNoHorizontalOverflow(page);
    }
  });
});

/* ------------------------------------------------------------------------------------------
 * Full narrative verification (Task 22). Runs against the built site served by the real
 * marketing API fixture (e2e/fixtures/test-api.ts). Assertions use DOM state markers
 * (`data-demo-state`, aria attributes, test ids) and bounded retries — never pixel timing.
 * ---------------------------------------------------------------------------------------- */

const NARRATIVE_SECTION_ORDER = [
  'product', // Hero
  'organization',
  'mandate',
  'execution', // Execution → Failure → Recovery → Validation
  'proof', // Receipt
  'memory',
  'benchmarks',
  'architecture',
  'launch', // CTA
];

const DEMO_STATE_ORDER = [
  'goal',
  'organization',
  'mandate',
  'executing',
  'failure',
  'recovering',
  'validating',
  'verified',
  'receipt',
  'memory',
];

/** Records every value of the single demo state marker so order can be asserted afterwards. */
async function recordDemoStates(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __demoStates: string[] }).__demoStates = seen;
    const note = (value: string | null) => {
      if (value && seen[seen.length - 1] !== value) seen.push(value);
    };
    new MutationObserver(() => {
      note(document.querySelector('[data-demo-state]')?.getAttribute('data-demo-state') ?? null);
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-demo-state'] });
  });
}

async function demoStates(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __demoStates: string[] }).__demoStates);
}

test.describe('landing narrative', () => {
  test('sections appear in the story order', async ({ page }) => {
    await page.goto('/');
    const tops: number[] = [];
    for (const id of NARRATIVE_SECTION_ORDER) {
      const section = page.locator(`#${id}`);
      await expect(section).toHaveCount(1);
      const top = await section.evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
      tops.push(top);
    }
    expect([...tops].sort((a, b) => a - b)).toEqual(tops);
    await expect(page.locator('h1')).toHaveText('AI teams you can hold accountable.');
  });

  test('one demo state drives the story from goal to memory, in order', async ({ page }) => {
    test.setTimeout(90_000);
    await recordDemoStates(page);
    await page.goto('/');
    const marker = page.getByTestId('hero-demo');

    // 1. Goal becomes organization: the four responsibilities appear under the goal.
    await expect(marker).toHaveAttribute('data-demo-state', /organization|mandate|executing/, { timeout: 15_000 });
    await expect(page.locator('#organization .execution-node')).toHaveCount(4);

    // 2. Mandate shows the approval boundary.
    await page.locator('#mandate').scrollIntoViewIfNeeded();
    await expect(page.locator('#mandate')).toContainText('Human approval required');

    // 3. Failure is visible before recovery.
    await page.locator('#execution').scrollIntoViewIfNeeded();
    await expect(page.locator('#execution .execution-section__failure')).toBeVisible({ timeout: 20_000 });
    await expect(marker).toHaveAttribute('data-demo-state', /failure|recovering/);

    // 4. Receipt appears only after the verified state.
    await expect(page.getByTestId('accountability-pending')).toBeVisible();
    await expect(page.locator('#proof .decision-receipt')).toBeVisible({ timeout: 30_000 });
    const statesAtReceipt = await demoStates(page);
    expect(statesAtReceipt).toContain('verified');
    await expect(page.locator('#execution')).toContainText('VERIFIED');

    await expect(marker).toHaveAttribute('data-demo-state', 'memory', { timeout: 20_000 });
    const states = await demoStates(page);
    const positions = DEMO_STATE_ORDER.map((state) => states.indexOf(state));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(states.indexOf('failure')).toBeLessThan(states.indexOf('recovering'));
    expect(states.indexOf('verified')).toBeLessThan(states.indexOf('receipt'));
  });

  test('curious path: inspect a node, open the receipt, expand architecture', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/');
    await expect(page.getByTestId('hero-demo')).toHaveAttribute('data-demo-state', 'memory', { timeout: 60_000 });

    const node = page.locator('#organization .execution-node').first();
    await node.scrollIntoViewIfNeeded();
    await node.hover();
    await node.click();
    await expect(node).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('organization-inspector')).toBeVisible();
    await expect(page.getByTestId('organization-inspector')).toContainText('Authority');
    await node.click();

    const receiptToggle = page.locator('#proof .decision-receipt [aria-expanded]').first();
    await receiptToggle.scrollIntoViewIfNeeded();
    await expect(receiptToggle).toHaveAttribute('aria-expanded', 'false');
    await receiptToggle.click();
    await expect(receiptToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('decision-receipt-fields')).toBeVisible();

    // 5. Architecture expands deeper layers.
    const layer = page.locator('#architecture [aria-expanded]').first();
    await layer.scrollIntoViewIfNeeded();
    await layer.click();
    await expect(layer).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#architecture [data-testid^="architecture-children-"]').first()).toBeVisible();
  });

  test('keyboard toggles an architecture layer with Enter and Space', async ({ page }) => {
    await page.goto('/');
    const layer = page.locator('#architecture [aria-expanded]').first();
    await layer.focus();
    await page.keyboard.press('Enter');
    await expect(layer).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Space');
    await expect(layer).toHaveAttribute('aria-expanded', 'false');
  });

  test('keyboard opens the receipt and the transcript, with a visible focus ring', async ({ page }) => {
    await page.goto('/');
    const receiptToggle = page.locator('#proof .decision-receipt [aria-expanded]').first();
    await receiptToggle.focus();
    const outline = await receiptToggle.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).not.toBe('none');
    await page.keyboard.press('Enter');
    await expect(receiptToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('decision-receipt-fields')).toBeVisible();

    const transcriptToggle = page.getByRole('button', { name: /show transcript/i });
    await transcriptToggle.focus();
    await page.keyboard.press('Space');
    await expect(page.getByTestId('promo-video-transcript')).toBeVisible();
  });
});

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('all meaningful content is reachable without cinematic pauses', async ({ page }) => {
    await page.goto('/');
    // The demo must settle almost immediately rather than after ~18s of choreography.
    await expect(page.getByTestId('hero-demo')).toHaveAttribute('data-demo-state', 'memory', { timeout: 3_000 });
    await expect(page.locator('#organization .execution-node')).toHaveCount(4);
    await expect(page.locator('#mandate')).toContainText('Human approval required');
    await expect(page.locator('#proof .decision-receipt')).toBeAttached();
    for (const id of NARRATIVE_SECTION_ORDER) {
      await page.locator(`#${id}`).scrollIntoViewIfNeeded();
      await expect(page.locator(`#${id}`)).toBeVisible();
    }
  });
});

test.describe('media failure', () => {
  test('a failed promo video keeps the page usable via poster and transcript', async ({ page }) => {
    await page.route('**/*.mp4', (route) => route.abort('failed'));
    await page.goto('/');
    const video = page.locator('#how-it-works video');
    await video.scrollIntoViewIfNeeded();
    await expect(video).toHaveAttribute('poster', /cherryontop-promo-poster/);
    await video.evaluate((element: HTMLVideoElement) => element.play().catch(() => undefined));
    await expect(page.locator('.promo-video__fallback')).toBeVisible({ timeout: 10_000 });

    // On failure the poster image and transcript are exposed without any extra step.
    await expect(page.locator('.promo-video__fallback-poster')).toBeVisible();
    await expect(page.getByTestId('promo-video-transcript')).toContainText('VERIFIED');

    // The narrative continues below the broken media.
    await page.locator('#launch').scrollIntoViewIfNeeded();
    await expect(page.locator('#launch-email')).toBeVisible();
  });
});

test.describe('launch submission', () => {
  test('the waitlist form reaches the real API and shows the exact success state', async ({ page }) => {
    await page.goto('/#launch');
    await page.locator('#launch-email').fill(`e2e-${Date.now()}@example.com`);
    const consent = page.locator('.launch-form__consent input[type="checkbox"]');
    if (await consent.count()) await consent.check();

    const responsePromise = page.waitForResponse(
      (response) => response.url().endsWith('/api/waitlist') && response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Join the launch' }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });

    const success = page.getByTestId('launch-form-success');
    await expect(success).toBeVisible();
    await expect(success).toContainText("You're on the list.");
    await expect(success).toContainText("We'll let you know when CherryOnTop is ready.");
  });
});
