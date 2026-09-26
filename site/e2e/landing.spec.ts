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
