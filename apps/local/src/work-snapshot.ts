import { localConfiguration } from './config.ts';
import { exportSnapshot } from './export-snapshot.ts';
await exportSnapshot(localConfiguration('work').pool,true);
