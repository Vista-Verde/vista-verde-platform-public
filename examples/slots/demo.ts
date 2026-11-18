import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SlotService } from './service.ts';
import { FIXTURE_NOW, seedSyntheticFixture, publication, purchase } from './fixtures.ts';

const dir = mkdtempSync(join(tmpdir(), 'vista-verde-demo-'));
const path = join(dir, 'synthetic.sqlite');
seedSyntheticFixture(path);
const service = new SlotService(path, () => FIXTURE_NOW);
try {
  console.log('SYNTHETIC ONLY — integer USD minor units; no external services or real payments.');
  console.log('Publish housing:', service.publish('buyer', 'publish-housing', publication()));
  assert.throws(() => service.publish('buyer', 'publish-robotics', publication('robotics')), { code: 'FUNDING_UNAVAILABLE' });
  console.log('Publish robotics: FUNDING_UNAVAILABLE (the same buyer funds are already held).');
  const result = service.purchase('producer-a', 'buy-housing', purchase());
  console.log('Purchase housing:', result);
  assert.deepEqual(service.purchase('producer-a', 'buy-housing', purchase()), result);
  console.log('Retry purchase: the original commitment; no second debit or reservation.');
  assert.throws(() => service.purchase('producer-b', 'buy-housing', purchase()), { code: 'SLOT_UNAVAILABLE' });
  console.log('Second producer: SLOT_UNAVAILABLE. Run npm test for simultaneous independent-connection races.');
} finally { service.close(); rmSync(dir, { recursive: true, force: true }); }
