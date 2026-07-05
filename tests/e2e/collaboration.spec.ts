import { test, expect } from '@playwright/test';
import { join } from 'path';

const AUTH_STATE = join(__dirname, '.auth/state.json');

test.describe('Real-time collaboration', () => {
  test('two users see each other edits on the same pad', async ({ browser }) => {
    // User 1 reuses the pre-registered session; User 2 registers fresh
    const ctx1 = await browser.newContext({ storageState: AUTH_STATE });
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    try {
      await page1.goto('/');
      await expect(page1.locator('#status')).toHaveClass(/online/);

      const beforeCount = await page1.locator('.pad-btn').count();
      await page1.click('[data-testid="new-pad"]');
      await expect(page1.locator('.pad-btn')).toHaveCount(beforeCount + 1, { timeout: 5000 });
      const padId = await page1.locator('.pad-btn').nth(beforeCount).textContent();

      await page2.goto('/');
      await expect(page2.locator('#status')).toHaveClass(/online/);

      // Wait for the pad tab to appear on User 2's page (via WS broadcast)
      await expect(page2.locator(`.pad-btn:has-text("${padId}")`)).toBeVisible({ timeout: 10000 });
      await page2.click(`.pad-btn:has-text("${padId}")`);

      // Small delay to ensure WS subscriptions are ready
      await page1.waitForTimeout(500);

      // User 1 types in the editor
      const editor1 = page1.locator('[data-testid="editor"]');
      await editor1.fill('Hello from User 1');

      // User 2 should see the text appear (via WebSocket broadcast)
      const editor2 = page2.locator('[data-testid="editor"]');
      await expect(editor2).toHaveValue('Hello from User 1', { timeout: 15000 });
    } finally {
      await ctx1.close();
      await ctx2.close();
    }
  });

  test('online count reflects connected users', async ({ browser }) => {
    const ctx1 = await browser.newContext({ storageState: AUTH_STATE });
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    try {
      await page1.goto('/');
      await expect(page1.locator('#status')).toHaveClass(/online/);

      const beforeCount = await page1.locator('.pad-btn').count();
      await page1.click('[data-testid="new-pad"]');
      await expect(page1.locator('.pad-btn')).toHaveCount(beforeCount + 1, { timeout: 5000 });
      const padId = await page1.locator('.pad-btn').nth(beforeCount).textContent();

      // User 1 alone on this pad → count = 1
      await expect(page1.locator('#online-count')).toHaveText('1');

      // User 2 joins the same pad
      await page2.goto('/');
      await expect(page2.locator('#status')).toHaveClass(/online/);
      await expect(page2.locator(`.pad-btn:has-text("${padId}")`)).toBeVisible({ timeout: 10000 });
      await page2.click(`.pad-btn:has-text("${padId}")`);
      await expect(page2.locator('#status')).toHaveClass(/online/);
      // Wait for User 2's online count to reflect the connection before asserting
      await expect(page2.locator('#online-count')).toHaveText('2', { timeout: 10000 });

      // Both should see count = 2
      await expect(page1.locator('#online-count')).toHaveText('2', { timeout: 10000 });
      await expect(page2.locator('#online-count')).toHaveText('2', { timeout: 10000 });
    } finally {
      await ctx1.close();
      await ctx2.close();
    }
  });

  test('new pad created by one user is visible to others', async ({ browser }) => {
    const ctx1 = await browser.newContext({ storageState: AUTH_STATE });
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    try {
      await page1.goto('/');
      await page2.goto('/');

      const beforeCount = await page2.locator('.pad-btn').count();

      await page1.click('[data-testid="new-pad"]');
      await expect(page1.locator('.pad-btn')).toHaveCount(beforeCount + 1, { timeout: 5000 });

      // User 2 should see the new pad tab appear (via WebSocket broadcast)
      await expect(page2.locator('.pad-btn')).toHaveCount(beforeCount + 1, { timeout: 10000 });
    } finally {
      await ctx1.close();
      await ctx2.close();
    }
  });

});
