import { localConfiguration } from './config.ts';
import { legacyBackupEntry } from './legacy-backup.ts';
import { exportSnapshot } from './export-snapshot.ts';
// Existing legacy tools dump vista_verde_local; never inherit the new store.
const { pool }=localConfiguration('legacy');
const marker=(await pool.query("SELECT to_regclass('public.market_schema') AS marker")).rows[0].marker;
if (marker) await exportSnapshot(pool);
else { await pool.end();await legacyBackupEntry('snapshot'); }
