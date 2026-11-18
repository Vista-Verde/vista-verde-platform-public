import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { operations } from '../../contracts/src/index.ts';
import type { Context, Input } from '../../contracts/src/index.ts';
import { demand } from '../../domain/src/index.ts';
import { isMarketOperation, marketQueryNames, marketCommandNames } from './market.ts';
import { seedMarketRecords } from './market-fixtures.ts';

type SeedOptions = { tokens?: Record<string,string>; expiresAt?: Date };
export async function seedRecords(client: pg.PoolClient, options: SeedOptions = {}): Promise<Record<string, { token: string; context: Context }>> {
  const credentials: Record<string, { token: string; context: Context }> = {};
    await client.query('LOCK TABLE memberships IN EXCLUSIVE MODE');
    demand(Number((await client.query('SELECT count(*) AS n FROM memberships')).rows[0].n) === 0,'FORBIDDEN');
    for (const [id,org,balance] of [['buyer-funds','buyer-org',1000000],['producer-a-funds','producer-a-org',100000],
      ['producer-b-funds','producer-b-org',100000],['other-buyer-funds','other-buyer-org',1000000],['slot-price-suspense','fixture-suspense',0]] as const) {
      await client.query("INSERT INTO accounts(id,organization_id,currency,balance) VALUES($1,$2,'USD',$3)",[id,org,balance]);
    }
    for (const [actor,org,account,role] of [
      ['buyer-agent','buyer-org','buyer-funds','buyer_agent'],['buyer','buyer-org','buyer-funds','buyer_human'],
      ['buyer-second','buyer-org','buyer-funds','buyer_human'],['other-buyer','other-buyer-org','other-buyer-funds','buyer_human'],
      ['other-agent','other-buyer-org','other-buyer-funds','buyer_agent'],
      ['producer-a','producer-a-org','producer-a-funds','producer'],['producer-b','producer-b-org','producer-b-funds','producer'],
      ['operator','fixture-operator',null,'operator']
    ] as const) {
      await client.query('INSERT INTO memberships(actor_id,organization_id,account_id,role) VALUES($1,$2,$3,$4)',[actor,org,account,role]);
      const token = options.tokens?.[actor] ?? randomBytes(32).toString('base64url'); const grantId = randomUUID();
      await client.query(`INSERT INTO grants(id,actor_id,token_hash,operations,requirement_scopes,market_scopes,expires_at,max_per_command,budget_limit)
        VALUES($1,$2,$3,$4,ARRAY['*'],$6,COALESCE($5,clock_timestamp()+interval '1 hour'),1000000,9000000)`,
        [grantId,actor,createHash('sha256').update(token).digest('hex'),[...Object.keys(operations).filter(op => !isMarketOperation(op)),...(role==='operator' ? [] : marketQueryNames),...(role==='operator' ? [] : role==='buyer_agent' ? ['createMarketOrder','proposeMarketAllocation','postWorkOrder','postMaterialListing','respondToWorkOrder','linkMaterialSource','linkWorkStages'] : marketCommandNames)],options.expiresAt ?? null,role==='operator' ? [] : ['*']]);
      credentials[actor] = { token,context: { actorId: actor,organizationId: org,grantId,credentialMode: 'local_fixture',requestId: randomUUID() } };
    }
    for (const [id,process] of [['housing-panel','panel_cut'],['robotics-frame','frame_cut']] as const) {
      await client.query("INSERT INTO specifications VALUES($1,1,'component',$2,true)",
        [id,{ process,material: 'synthetic_composite',dimensions: { width: 100,unit: 'mm' },acceptance: 'fixture inspection only' }]);
    }
    await client.query("INSERT INTO fixture_terms VALUES('synthetic-v1',1,'slot-price-suspense','accepted_full_slot','unpurchased_release_only',true)");
    for (const org of ['producer-a-org','producer-b-org']) await client.query("INSERT INTO capabilities VALUES($1,ARRAY['panel_cut','frame_cut'],'reviewed_fixture',clock_timestamp())",[org]);
    // Explicit historical alias mapping, not an import of old databases or identity credentials.
    for (const id of ['buyer','producer-a','producer-b','buyer-funds','producer-a-funds','producer-b-funds','slot-price-suspense'])
      await client.query("INSERT INTO fixture_aliases VALUES('sqlite-fixture-names',$1,$1)",[id]);
    await seedMarketRecords(client);
    return credentials;
}
export async function seed(pool: pg.Pool): Promise<Record<string, { token: string; context: Context }>> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); const credentials=await seedRecords(client);
    await client.query('COMMIT'); return credentials;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
export function draft(key: string, specificationId = 'housing-panel'): Input<'createRequirementDraft'> {
  return { idempotencyKey: key,intendedUse: 'Synthetic counted components; not an engineering release.',
    lines: [{ lineId: 'components',quantity: { value: 1,unit: 'component' },specificationId,specificationRevision: 1 }],
    destination: 'Synthetic receiving site',deliveryWindow: { from: '2026-10-01T00:00:00Z',to: '2027-01-01T00:00:00Z' },
    acceptanceCriteria: ['Synthetic full-slot inspection'] };
}
export function publication(requirementId: string, slotId: string, compensation = 6000, expiresAt = new Date(Date.now()+60000).toISOString()): Input<'publishRequirement'> {
  return { idempotencyKey: `publish-${slotId}`,expectedRecordVersion: 1,requirementId,requirementRevision: 1,
    slots: [{ slotId,lineId: 'components',quantity: { value: 1,unit: 'component' },specificationId: 'housing-panel',specificationRevision: 1,
      termsId: 'synthetic-v1',termsRevision: 1,slotPrice: { minorUnits: 100,currency: 'USD' },compensation: { minorUnits: compensation,currency: 'USD' },expiresAt }] };
}
export function purchase(slotId: string, key = `purchase-${slotId}`): Input<'purchaseSlot'> {
  return { slotId,idempotencyKey: key,expectedRecordVersion: 1,requirementRevision: 1,specificationRevision: 1,termsRevision: 1 };
}

export { MARKET_FIXTURE, marketOrder, marketProposal, marketConfirmation, marketReport, marketAcknowledgement } from './market-fixtures.ts';
