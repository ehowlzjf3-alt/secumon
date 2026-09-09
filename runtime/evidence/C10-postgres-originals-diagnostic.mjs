import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { FileAgentProfileStore } from '../dist/infrastructure/file-agent-profile.js';
import { postgresAgentBinding } from '../dist/infrastructure/agent-postgres-storage.js';
import { exportPostgresAgent } from '../dist/infrastructure/postgres-transfer.js';
import { readPostgresTransferPage } from '../dist/infrastructure/postgres-transfer-files.js';
import { sameOriginalTransferRows } from './C10-postgres-real-pages.mjs';

const root = process.env.SECUMON_PG_PRIVATE_ROOT;
assert.ok(root);
const { Pool } = createRequire(join(root, 'host/package.json'))('pg');
const profiles = new FileAgentProfileStore(process.cwd());
for (const [name, database] of [['journal-run1', 'secumon405_journal_source'], ['sqlite-run3', 'secumon405_sqlite3_source']]) {
  const directory = join(root, 'cases', name, 'agent');
  const operation = JSON.parse(readFileSync(join(directory, '.secumon/postgres-migration.json'), 'utf8'));
  const ready = profiles.inspect(directory); assert.equal(ready.status, 'ready');
  const pool = new Pool({ host: join(root, 'socket'), port: 55405, user: 'secumon_acceptance', database,
    ssl: false, max: 1, connectionTimeoutMillis: 10000 });
  try {
    const pages = [];
    const bindings = operation.selection.purposes.map(purpose => postgresAgentBinding(ready, operation.selection, purpose));
    const manifest = await exportPostgresAgent(pool, bindings, async (id, page) => { pages.push({ id, page }); });
    const result = await sameOriginalTransferRows(operation.snapshot,
      id => readPostgresTransferPage(join(directory, '.secumon/postgres-transfer'), id), { manifest, pages });
    const changedPageHashes = operation.snapshot.pages.filter((entry, i) => entry.digest !== manifest.pages[i]?.digest).map(entry => entry.table);
    process.stdout.write(JSON.stringify({ kind: 'postgres_original_rows_diagnostic', status: 'passed', name,
      ...result, changedPageHashes, duplicatesPreserved: true, originalPageHashesValidated: true }) + '\n');
  } finally { await pool.end(); }
}
