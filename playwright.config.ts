import { defineConfig, devices } from '@playwright/test';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';

/**
 * Playwright E2E test configuration for CoMark-Notepad.
 *
 * The dev server is started automatically on port 8111 before tests run
 * and stopped afterwards.  Tests never touch the development port 8000.
 *
 * A dedicated, isolated data directory (`tests/e2e/.e2e-data-dir`) is used and
 * injected via `DATA_DIR`.  This ensures E2E runs NEVER touch the developer's
 * real `data/` directory (which may contain live pads/files) — the previous
 * config deleted `data/store.db` from the repo, causing real data loss.
 *
 * A `globalSetup` registers a test user and saves the session cookie to
 * `.auth/state.json`.  All tests then share this authenticated state,
 * keeping registrations under the rate-limiter cap.
 */

// Use an isolated E2E data dir so we never delete the developer's real data/.
// Clear any prior run's state, then recreate the (empty) directory so the
// server can persist its dev SESSION_SECRET and SQLite DB into it on startup.
const E2E_DATA_DIR = join(__dirname, 'tests', 'e2e', '.e2e-data-dir');
rmSync(E2E_DATA_DIR, { recursive: true, force: true });
mkdirSync(E2E_DATA_DIR, { recursive: true });

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false, // collaboration tests share server state
  workers: 1, // sequential: all tests share one server + database
  retries: 1,
  reporter: 'list',

  globalSetup: './tests/e2e/global-setup.ts',

  use: {
    baseURL: 'http://localhost:8111',
    trace: 'on-first-retry',
    storageState: './tests/e2e/.auth/state.json',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: 'npx tsx src/server.ts',
    port: 8111,
    env: {
      PORT: '8111',
      NODE_ENV: 'development',
      DATA_DIR: E2E_DATA_DIR,
      // The suite drives many browser contexts sequentially from 127.0.0.1;
      // frontend auto-reconnect can briefly stack connections. Raise the per-IP
      // WS cap so later tests aren't rejected by the default limit (10).
      MAX_WS_CONNECTIONS_PER_IP: '100',
    },
    reuseExistingServer: false,
    timeout: 15_000,
  },
});
