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

  test('concurrent edits from two users are both preserved (rebase, no overwrite)', async ({ browser }) => {
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
      await expect(page2.locator(`.pad-btn:has-text("${padId}")`)).toBeVisible({ timeout: 10000 });
      await page2.click(`.pad-btn:has-text("${padId}")`);

      const editor1 = page1.locator('[data-testid="editor"]');
      const editor2 = page2.locator('[data-testid="editor"]');

      // Establish a shared base line and wait for it to reach user 2.
      await editor1.fill('MIDDLE');
      await expect(editor2).toHaveValue('MIDDLE', { timeout: 15000 });
      await page1.waitForTimeout(500);

      // User 2 starts an unsent local edit (append at the end) while focused;
      // simultaneously user 1 edits the start. The remote patch arriving at
      // user 2 must be rebased onto its in-progress edit rather than clobbering
      // it — this is the P1 regression (remote patch overwrites local input).
      await editor2.focus();
      await page2.keyboard.press('End');
      await page2.keyboard.type('_END2');

      await editor1.focus();
      await page1.keyboard.press('Home');
      await page1.keyboard.type('START1_');

      // Neither edit may be lost: user 2 must retain its own in-progress edit
      // (_END2) AND absorb user 1's remote edit (START1_). The exact ordering of
      // the merged fragments is up to diff-match-patch — what matters for the
      // regression is that no edit is overwritten.
      await expect(editor2).toHaveValue(/START1_/, { timeout: 15000 });
      await expect(editor2).toHaveValue(/_END2/);
      await expect(editor2).toHaveValue(/MIDDLE/);

      // After user 2 flushes, both clients converge to identical text.
      await editor2.blur();
      const converged = await editor2.inputValue();
      await expect(editor1).toHaveValue(converged, { timeout: 15000 });
    } finally {
      await ctx1.close();
      await ctx2.close();
    }
  });

  test('pasted image is inserted and syncs to collaborators', async ({ browser }) => {
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
      await expect(page2.locator(`.pad-btn:has-text("${padId}")`)).toBeVisible({ timeout: 10000 });
      await page2.click(`.pad-btn:has-text("${padId}")`);
      await page1.waitForTimeout(500);

      const editor1 = page1.locator('[data-testid="editor"]');
      const editor2 = page2.locator('[data-testid="editor"]');

      // Simulate pasting a 1x1 PNG into user 1's editor.
      await editor1.focus();
      await page1.evaluate(() => {
        const ta = document.querySelector('#text-input') as HTMLTextAreaElement;
        const b64 =
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const file = new File([bytes], 'pasted.png', { type: 'image/png' });
        const dt = new DataTransfer();
        dt.items.add(file);
        ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      });

      // User 1 should get the Markdown image reference inserted locally.
      await expect(editor1).toHaveValue(/!\[pasted\.png\]\(data:image\/png/, { timeout: 5000 });

      // And it must actually sync to user 2 — the P1 regression was that the
      // paste advanced the shadow prematurely so the image was never pushed.
      await expect(editor2).toHaveValue(/!\[pasted\.png\]\(data:image\/png/, { timeout: 15000 });
    } finally {
      await ctx1.close();
      await ctx2.close();
    }
  });

  test('oversized pasted image is rejected before embedding (server limit)', async ({ browser }) => {
    const ctx1 = await browser.newContext({ storageState: AUTH_STATE });
    const page1 = await ctx1.newPage();

    try {
      await page1.goto('/');
      await expect(page1.locator('#status')).toHaveClass(/online/);

      const editor1 = page1.locator('[data-testid="editor"]');
      await editor1.fill('before image');

      // A ~60KB image/png blob inflates to ~80KB base64, exceeding the 75KB
      // embed cap. The client must reject it up front instead of sending a
      // patch the server would nack (P2 #6).
      await editor1.focus();
      await page1.evaluate(() => {
        const ta = document.querySelector('#text-input') as HTMLTextAreaElement;
        const bytes = new Uint8Array(60 * 1024);
        for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 0xff;
        const file = new File([bytes], 'big.png', { type: 'image/png' });
        const dt = new DataTransfer();
        dt.items.add(file);
        ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      });

      // Editor must be unchanged — no image reference was inserted.
      await expect(editor1).toHaveValue('before image', { timeout: 5000 });
      // And the rejection toast is shown.
      await expect(page1.locator('#toast')).toContainText('too large', { timeout: 5000 });
    } finally {
      await ctx1.close();
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
