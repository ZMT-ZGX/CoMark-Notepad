'use strict';

// Create a transactionally consistent snapshot of the SQLite database.
//
// Runs INSIDE the app container (copied to /tmp by scripts/backup.sh) so it can
// reuse the app's own better-sqlite3 build. Snapshotting through SQLite's
// backup API (rather than copying store.db with `cp`) is what makes the result
// safe to take while the server is live: SQLite keeps a -wal file beside the
// database, so a plain file copy can capture a half-checkpointed page set that
// fails to open exactly when you need the backup.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const stamp = process.env.STAMP;
if (!stamp) {
  console.error('STAMP env var is required');
  process.exit(1);
}

const dataDir = process.env.DATA_DIR || '/app/data';
const src = path.join(dataDir, 'store.db');
const dest = path.join(dataDir, 'backups', `${stamp}.db`);

fs.mkdirSync(path.dirname(dest), { recursive: true });

// Opened read-write on purpose: in WAL mode a read-only connection can fail if
// it needs to create the -shm file. Multiple concurrent connections are safe
// here — the app already runs with WAL and busy_timeout.
const db = new Database(src);
db.backup(dest)
  .then(() => {
    console.log(`  sqlite snapshot ok -> ${dest}`);
  })
  .catch((err) => {
    console.error('  sqlite snapshot FAILED:', err);
    process.exit(1);
  })
  .finally(() => {
    db.close();
  });
