import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalize,fingerprint,operations,envelope,BASELINE } from '../../packages/contracts/src/index.ts';
import { draft,publication,purchase } from '../../packages/db/src/fixtures.ts';

test('one strict baseline rejects client authority/funding and unsafe money or units',() => {
  for (const field of ['actorId','organizationId','role','funded','approved'])
    assert.throws(() => normalize('publishRequirement',{ ...publication('r','s'),[field]: true }));
  for (const value of [-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])
    assert.throws(() => normalize('publishRequirement',publication('r','s',value)));
  const missingUnit = draft('draft'); delete (missingUnit.lines[0]!.quantity as Partial<{ unit: string }>).unit;
  assert.throws(() => normalize('createRequirementDraft',missingUnit));
  assert.throws(() => normalize('purchaseSlot',{ ...purchase('s'),requirementRevision: undefined }));
});
test('normalized request fingerprint is stable across transport field order and published slot order',() => {
  const a = publication('r','a'); a.slots.push({ ...a.slots[0]!,slotId: 'b' });
  const b = { slots: [...a.slots].reverse(),requirementRevision: a.requirementRevision,
    requirementId: a.requirementId,expectedRecordVersion: a.expectedRecordVersion,idempotencyKey: a.idempotencyKey };
  assert.equal(fingerprint(normalize('publishRequirement',a)),fingerprint(normalize('publishRequirement',b)));
  const timestamp=publication('r','timestamp',1,'2026-10-10T00:00:00Z');
  const milliseconds=publication('r','timestamp',1,'2026-10-10T00:00:00.000Z');
  assert.equal(fingerprint(normalize('publishRequirement',timestamp)),fingerprint(normalize('publishRequirement',milliseconds)));
  assert.notEqual(fingerprint(purchase('a')),fingerprint(purchase('b')));
  for (const operation of ['getWorkspace','createRequirementDraft','getRequirement','publishRequirement',
    'listAvailableSlots','purchaseSlot','getCommitment','withdrawUnpurchasedSlot','processExpiredSlot','getScopedAudit'])
    assert.ok(operation in operations, `Foundation operation ${operation} must remain available.`);
});
test('failure envelope is versioned, disclosure-safe and does not pretend to be a success',() => {
  assert.equal(envelope.parse({ schemaVersion: BASELINE,ok: false,code: 'FORBIDDEN',message: 'FORBIDDEN',retryable: false,fieldIssues: [] }).ok,false);
  assert.throws(() => envelope.parse({ schemaVersion: BASELINE,ok: true,state: 'purchased' }));
});
