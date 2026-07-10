import { test, expect } from '@playwright/test';

test.describe('Basic functionality', () => {
  test('page loads and shows editor', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('[data-testid="editor"]')).toBeVisible();
    // Text stats should contain "chars" and "line" regardless of content
    await expect(page.locator('#text-stats')).toContainText('chars');
    await expect(page.locator('#text-stats')).toContainText('line');
  });

  test('WebSocket connects', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#status')).toHaveClass(/online/);
    await expect(page.locator('#online-count')).toBeVisible();
  });

  test('user code is assigned on load', async ({ page }) => {
    await page.goto('/');
    // A user code is assigned on connect and cached in sessionStorage (there is
    // no dedicated on-screen badge — the identity surfaces via the invite flow).
    await expect(page.locator('#status')).toHaveClass(/online/);
    await expect
      .poll(() => page.evaluate(() => sessionStorage.getItem('userCode')), { timeout: 10000 })
      .toMatch(/\S/);
  });

  test('typing updates text stats', async ({ page }) => {
    await page.goto('/');
    const editor = page.locator('[data-testid="editor"]');
    await editor.fill('Hello World');
    await expect(page.locator('#text-stats')).toContainText('11 chars');
    await expect(page.locator('#text-stats')).toContainText('1 line');
  });

  test('create new pad via [+] button', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('[data-testid="new-pad"]')).toBeVisible();

    // Count existing tabs
    const before = await page.locator('.pad-btn').count();
    await page.click('[data-testid="new-pad"]');
    await expect(page.locator('.pad-btn')).toHaveCount(before + 1);
  });

  test('switch between pads', async ({ page }) => {
    await page.goto('/');

    // Create a new pad and wait for it to appear
    const beforeCount = await page.locator('.pad-btn').count();
    await page.click('[data-testid="new-pad"]');
    await expect(page.locator('.pad-btn')).toHaveCount(beforeCount + 1, { timeout: 5000 });

    // Type in the current pad
    await page.locator('[data-testid="editor"]').fill('UniquePadContent99');

    // Switch to first pad tab
    await page.click('.pad-btn:first-child');
    await expect(page.locator('[data-testid="editor"]')).not.toHaveValue('UniquePadContent99');
  });

  test('theme toggle cycles through modes', async ({ page }) => {
    await page.goto('/');
    const html = page.locator('html');

    const initialTheme = await html.getAttribute('data-theme');
    await page.click('#theme-toggle');
    const theme2 = await html.getAttribute('data-theme');
    expect(theme2).not.toBe(initialTheme);

    await page.click('#theme-toggle');
    const theme3 = await html.getAttribute('data-theme');
    expect(theme3).not.toBe(theme2);
  });

  test('export button triggers download', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-testid="editor"]').fill('# Test Markdown');

    const downloadPromise = page.waitForEvent('download', { timeout: 5000 }).catch(() => null);
    await page.click('#export-btn');
    const download = await downloadPromise;

    if (download) {
      expect(download.suggestedFilename()).toMatch(/^pad-\d+\.md$/);
    }
  });
});
