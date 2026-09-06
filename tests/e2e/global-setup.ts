/**
 * Playwright global setup — starts the test server and registers a user,
 * saving the session cookie to `.auth/state.json` so all tests share one
 * authenticated identity.  This keeps the number of registrations well
 * under the `registerLimiter` cap of 10 per 15 minutes.
 */
import { chromium } from '@playwright/test';
import { rmSync, mkdirSync } from 'fs';
import { join } from 'path';

export default async function globalSetup() {
  const stateDir = join(__dirname, '.auth');
  rmSync(stateDir, { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  // Navigate to the test server — auto-registration happens on page load.
  // A fresh install has zero pads, and the client deliberately stays offline
  // until one exists (a connect attempt is closed 4404 "Pad not found").
  await page.goto('http://localhost:8111');
  await page.waitForLoadState('networkidle');

  // Mirror the real first-user flow: create the first pad (same-origin fetch
  // carries the freshly registered session cookie and the Origin header the
  // CSRF check requires), then reload — the WebSocket only connects once a
  // loadable pad exists.
  await page.evaluate(async () => {
    const res = await fetch('/api/pads', { method: 'POST' });
    if (!res.ok) throw new Error(`bootstrap pad failed: ${res.status}`);
  });
  await page.reload();
  await page.waitForSelector('#status.online', { timeout: 10000 });

  // Save the session cookie + localStorage
  await context.storageState({ path: join(stateDir, 'state.json') });

  await browser.close();
}
