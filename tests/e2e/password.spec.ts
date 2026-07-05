import { test, expect } from '@playwright/test';
import { join } from 'path';

const AUTH_STATE = join(__dirname, '.auth/state.json');

test.describe('Pad password protection', () => {
  test('set password locks the pad', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#status')).toHaveClass(/online/);

    // Create a new pad (user becomes owner → can set password)
    const beforeCount = await page.locator('.pad-btn').count();
    await page.click('[data-testid="new-pad"]');
    await expect(page.locator('.pad-btn')).toHaveCount(beforeCount + 1, { timeout: 5000 });

    // Wait for the lock button to be visible (pad fully loaded)
    await expect(page.locator('#pad-lock-btn')).toBeVisible();

    // Click lock button to set password
    await page.click('#pad-lock-btn');
    await expect(page.locator('#password-modal')).not.toBeHidden();

    // Fill in password
    await page.locator('[data-testid="password-input"]').fill('secret123');
    await page.locator('#password-confirm').fill('secret123');
    await page.click('[data-testid="password-confirm-btn"]');

    // Modal should close
    await expect(page.locator('#password-modal')).toBeHidden({ timeout: 5000 });
    // Lock button title should indicate password is set
    await expect(page.locator('#pad-lock-btn')).toHaveAttribute('title', 'Change/remove password');
  });

  test('password mismatch shows error', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#status')).toHaveClass(/online/);

    // Create a new pad first
    const beforeCount = await page.locator('.pad-btn').count();
    await page.click('[data-testid="new-pad"]');
    await expect(page.locator('.pad-btn')).toHaveCount(beforeCount + 1, { timeout: 5000 });
    await expect(page.locator('#pad-lock-btn')).toBeVisible();

    // Open password modal
    await page.click('#pad-lock-btn');

    // Fill mismatched passwords
    await page.locator('[data-testid="password-input"]').fill('secret123');
    await page.locator('#password-confirm').fill('different');
    await page.click('[data-testid="password-confirm-btn"]');

    // Error should be visible
    await expect(page.locator('#password-error')).toBeVisible();
    await expect(page.locator('#password-error')).toContainText('do not match');
  });

  test('locked pad requires unlock from another user', async ({ browser }) => {
    // User 1 (owner) reuses auth; User 2 registers fresh
    const ctx1 = await browser.newContext({ storageState: AUTH_STATE });
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    try {
      // User 1 creates a pad and sets a password
      await page1.goto('/');
      await expect(page1.locator('#status')).toHaveClass(/online/);

      const beforeCount = await page1.locator('.pad-btn').count();
      await page1.click('[data-testid="new-pad"]');
      await expect(page1.locator('.pad-btn')).toHaveCount(beforeCount + 1, { timeout: 5000 });
      await expect(page1.locator('#pad-lock-btn')).toBeVisible();
      const padId = await page1.locator('.pad-btn').nth(beforeCount).textContent();

      // Set password
      await page1.click('#pad-lock-btn');
      await expect(page1.locator('#password-modal')).not.toBeHidden();
      await page1.locator('[data-testid="password-input"]').fill('testpass');
      await page1.locator('#password-confirm').fill('testpass');
      await page1.click('[data-testid="password-confirm-btn"]');
      await expect(page1.locator('#password-modal')).toBeHidden({ timeout: 5000 });

      // User 2 opens the app and switches to the locked pad
      await page2.goto('/');
      await expect(page2.locator('#status')).toHaveClass(/online/);
      await expect(page2.locator(`.pad-btn:has-text("${padId}")`)).toBeVisible({ timeout: 10000 });
      await page2.click(`.pad-btn:has-text("${padId}")`);

      // User 2 should see the unlock modal
      await expect(page2.locator('#unlock-modal')).toBeVisible({ timeout: 10000 });

      // Wrong password → error
      await page2.locator('[data-testid="unlock-input"]').fill('wrongpass');
      await page2.click('[data-testid="unlock-confirm-btn"]');
      await expect(page2.locator('#unlock-error')).toBeVisible();

      // Correct password → unlock
      await page2.locator('[data-testid="unlock-input"]').fill('testpass');
      await page2.click('[data-testid="unlock-confirm-btn"]');
      await expect(page2.locator('#unlock-modal')).toBeHidden({ timeout: 10000 });

      // User 2 should now see the editor
      await expect(page2.locator('[data-testid="editor"]')).toBeVisible();
    } finally {
      await ctx1.close();
      await ctx2.close();
    }
  });
});
