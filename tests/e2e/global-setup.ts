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

  // Navigate to the test server — auto-registration happens on page load
  await page.goto('http://localhost:8111');
  await page.waitForSelector('#status.online', { timeout: 10000 });

  // Save the session cookie + localStorage
  await context.storageState({ path: join(stateDir, 'state.json') });

  await browser.close();
}
