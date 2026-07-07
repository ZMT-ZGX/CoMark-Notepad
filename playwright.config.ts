import { defineConfig, devices } from '@playwright/test';
import { rmSync } from 'fs';
import { join } from 'path';

/**
 * Playwright E2E test configuration for CoMark-Notepad.
 *
 * The dev server is started automatically on port 8111 before tests run
 * and stopped afterwards.  Tests never touch the development port 8000.
 *
 * The project's own `data/` directory is used, but the SQLite database is
 * deleted before the server starts so each test run begins with a clean
 * state (only the seed pad).
 *
 * A `globalSetup` registers a test user and saves the session cookie to
 * `.auth/state.json`.  All tests then share this authenticated state,
 * keeping registrations under the rate-limiter cap.
 */

// Clean the SQLite database (and WAL/SHM files) before starting the test server
// so each run starts fresh with only the seed pad.
const DATA_DIR = join(__dirname, 'data');
rmSync(join(DATA_DIR, 'store.db'), { force: true });
rmSync(join(DATA_DIR, 'store.db-wal'), { force: true });
rmSync(join(DATA_DIR, 'store.db-shm'), { force: true });

// Also clean any leftover JSON store
rmSync(join(DATA_DIR, 'store.json'), { force: true });

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
    },
    reuseExistingServer: false,
    timeout: 15_000,
  },
});
