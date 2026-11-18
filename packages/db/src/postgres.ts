import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import type { PoolClient } from 'pg';
import { BASELINE, event, fingerprint, success } from '../../contracts/src/index.ts';
import type { Context, Command, CommandInput, Operation, Input, Success } from '../../contracts/src/index.ts';
import { BusinessError, demand, safeTotal, result } from '../../domain/src/index.ts';
import type { Repository } from '../../domain/src/index.ts';
import { isMarketOperation, marketCommand, marketQuery } from './market.ts';

type Row = Record<string, unknown>;
type Authority = Row & { actor_id: string; organization_id: string; role: string; account_id: string;
  operations: string[]; requirement_scopes: string[]; expires_at: Date; max_per_command: string;
  budget_limit: string; used_minor: string };
const queryNames = ['getWorkspace', 'getRequirement', 'listAvailableSlots', 'getCommitment', 'getScopedAudit'];
const roleCommands: Record<string, string[]> = { buyer_agent: ['createRequirementDraft'],
  buyer_human: ['publishRequirement', 'withdrawUnpurchasedSlot', 'processExpiredSlot'], producer: ['purchaseSlot'], operator: [] };
export function localPool(connectionString: string,max=12): pg.Pool {
  let url: URL;
  try { url=new URL(connectionString); } catch { throw new Error('Invalid foundation database target.'); }
  // pg accepts URL parameters (including host) that override the URL authority.
  // Fixtures need no connection options; reject all overrides before the driver parses them.
  if (!['postgres:','postgresql:'].includes(url.protocol) || url.search || url.hash ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Foundation database must be loopback-local without connection overrides.');
  if (!Number.isInteger(max) || max<1 || max>12) throw new Error('Invalid bounded local pool size.');
  const pool=new pg.Pool({ connectionString, max, connectionTimeoutMillis: 3000, application_name: 'vista-verde-foundation' });
  // pg removes failed idle clients; readiness and command responses report outages.
  // An idle disconnect must not terminate the application during a database restart.
  pool.on('error',() => undefined); return pool;
}
export async function migrate(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('vista-verde-foundation-migration',0))");
    const tables = await client.query("SELECT 1 FROM information_schema.tables WHERE table_schema='public'");
    demand(tables.rowCount === 0, 'FORBIDDEN'); // Never overwrite an existing database.
    await client.query(readFileSync(new URL('../migrations/001-foundation.sql', import.meta.url), 'utf8'));
    await client.query(readFileSync(new URL('../migrations/002-market.sql', import.meta.url), 'utf8'));
    await client.query(readFileSync(new URL('../migrations/003-work-orders.sql', import.meta.url), 'utf8'));
    await client.query(readFileSync(new URL('../migrations/004-sourcing.sql', import.meta.url), 'utf8'));
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
const number = (value: unknown): number => {
  const n = Number(value); demand(Number.isSafeInteger(n), 'VALIDATION_FAILED'); return n;
};
async function row(client: PoolClient, sql: string, values: unknown[] = []): Promise<Row> {
  const found = (await client.query<Row>(sql, values)).rows[0]; demand(found, 'FORBIDDEN'); return found;
}
async function now(client: PoolClient): Promise<Date> {
  return (await row(client, 'SELECT clock_timestamp() AS instant')).instant as Date;
}
function scoped(a: Authority, requirementId: string): void {
  demand(a.requirement_scopes.includes('*') || a.requirement_scopes.includes(requirementId), 'FORBIDDEN');
}
function grantTime(a: Authority, instant: Date): void {
  demand(a.expires_at.getTime() > instant.getTime(), 'FORBIDDEN');
}
async function authority(client: PoolClient, context: Context, operation: Operation): Promise<Authority> {
  const a = await row(client, `SELECT g.*, m.organization_id, m.role, m.account_id, m.active
    FROM grants g JOIN memberships m ON m.actor_id=g.actor_id WHERE g.id=$1
    FOR UPDATE OF g FOR SHARE OF m`, [context.grantId]) as Authority;
  demand(a.actor_id === context.actorId && a.organization_id === context.organizationId && a.active && !a.revoked, 'FORBIDDEN');
  grantTime(a, await now(client));
  demand(a.operations.includes(operation) && (queryNames.includes(operation) || roleCommands[a.role]?.includes(operation)), 'FORBIDDEN');
  return a;
}
async function reviewedProcesses(client: PoolClient,a: Authority): Promise<string[] | null> {
  const capability = (await client.query<Row>('SELECT * FROM capabilities WHERE organization_id=$1 FOR SHARE', [a.organization_id])).rows[0];
  return capability?.evidence_status === 'reviewed_fixture' ? capability.processes as string[] : null;
}
async function eligible(client: PoolClient, a: Authority, req: Row): Promise<boolean> {
  const processes=await reviewedProcesses(client,a); if (!processes) return false;
  const specs = await client.query<Row>(`SELECT s.criteria FROM requirement_lines l JOIN specifications s
    ON s.id=l.specification_id AND s.revision=l.specification_revision WHERE l.requirement_id=$1`, [req.id]);
  return specs.rows.length > 0 && specs.rows.every(s => processes.includes((s.criteria as { process: string }).process));
}
async function visible(client: PoolClient, a: Authority, req: Row): Promise<void> {
  scoped(a, req.id as string);
  if (a.role === 'operator' || a.organization_id === req.buyer_organization) return;
  demand(a.role === 'producer' && req.state === 'published','FORBIDDEN');
  if (await eligible(client,a,req)) return;
  // Existing obligations remain readable when reviewed capability is withdrawn.
  // Purchase still unconditionally rechecks current eligibility in the command.
  demand((await client.query(`SELECT 1 FROM commitments c JOIN slots s ON s.id=c.slot_id
    WHERE s.requirement_id=$1 AND c.producer_organization=$2 LIMIT 1`,[req.id,a.organization_id])).rowCount,'FORBIDDEN');
}
function moneyBudget(a: Authority, cost: number, replay = false): void {
  demand(cost <= number(a.max_per_command) && cost <= number(a.budget_limit), 'FORBIDDEN');
  if (!replay) demand(safeTotal([number(a.used_minor), cost]) <= number(a.budget_limit), 'FORBIDDEN');
}
async function accountLocks(client: PoolClient, ids: string[]): Promise<Map<string, Row>> {
  const rows = await client.query<Row>('SELECT * FROM accounts WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE', [[...new Set(ids)].sort()]);
  demand(rows.rowCount === new Set(ids).size, 'FORBIDDEN'); return new Map(rows.rows.map(r => [r.id as string, r]));
}

export class PostgresRepository implements Repository {
  pool: pg.Pool;
  constructor(pool: pg.Pool) { this.pool = pool; }
  async authenticate(token: string, requestId = randomUUID()): Promise<Context> {
    const hash = createHash('sha256').update(token).digest('hex');
    const found = (await this.pool.query<Row>(`SELECT g.id, g.actor_id, m.organization_id FROM grants g
      JOIN memberships m ON m.actor_id=g.actor_id WHERE g.token_hash=$1 AND NOT g.revoked AND m.active
      AND g.expires_at>clock_timestamp()`, [hash])).rows[0];
    demand(found, 'UNAUTHENTICATED');
    return { actorId: found.actor_id as string, organizationId: found.organization_id as string,
      grantId: found.id as string, credentialMode: 'local_fixture', requestId };
  }
  async command(context: Context, operation: Command, input: CommandInput): Promise<Success> {
    if (isMarketOperation(operation)) return marketCommand(this.pool,context,operation,input);
    for (let attempt = 0; attempt < 3; attempt++) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        await client.query("SET LOCAL lock_timeout='250ms'");
        await client.query("SET LOCAL statement_timeout='3s'");
        // Operations takes the exclusive gate while exporting a coordinated backup.
        await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('vista-verde-local-backup',0))");
        const scope = JSON.stringify([context.actorId, context.organizationId, operation, input.idempotencyKey]);
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [scope]);
        const a = await authority(client, context, operation);
        const cached = (await client.query<Row>(`SELECT * FROM idempotency WHERE actor_id=$1 AND organization_id=$2
          AND operation=$3 AND key=$4`, [context.actorId, context.organizationId, operation, input.idempotencyKey])).rows[0];
        if (cached) {
          const req = await row(client, 'SELECT * FROM requirements WHERE id=$1', [cached.requirement_id]);
          await visible(client, a, req);
          if (operation === 'purchaseSlot') demand(await eligible(client,a,req),'FORBIDDEN');
          moneyBudget(a, number(cached.cost), true);
          demand(cached.fingerprint === fingerprint(input), 'IDEMPOTENCY_CONFLICT');
          grantTime(a,await now(client));
          const saved = success.parse(cached.result); await client.query('COMMIT'); return saved;
        }
        let receipt: Success; let requirementId: string; let cost = 0;
        if (operation === 'createRequirementDraft') {
          const draft = input as Input<'createRequirementDraft'>;
          demand(new Set(draft.lines.map(l => l.lineId)).size === draft.lines.length, 'VALIDATION_FAILED');
          demand(a.requirement_scopes.includes('*'), 'FORBIDDEN');
          requirementId = randomUUID();
          await client.query(`INSERT INTO requirements(id,buyer_organization,buyer_account,state,draft) VALUES($1,$2,$3,'draft',$4)`,
            [requirementId, a.organization_id, a.account_id, draft]);
          for (const l of draft.lines) await client.query('INSERT INTO requirement_lines VALUES($1,$2,$3,$4,$5,$6)',
            [requirementId, l.lineId, l.quantity.value, l.quantity.unit, l.specificationId, l.specificationRevision]);
          receipt = result('draft', { requirementId }, { missing: await this.#missing(client, draft) },
            { recordVersion: 1, requirementRevision: 1 }, 'buyer_human', 'review_and_publish');
        } else if (operation === 'publishRequirement') {
          const pub = input as Input<'publishRequirement'>; requirementId = pub.requirementId;
          const owned=await row(client,'SELECT * FROM requirements WHERE id=$1',[requirementId]);
          scoped(a,requirementId); demand(owned.buyer_organization === a.organization_id && owned.buyer_account === a.account_id,'FORBIDDEN');
          const accounts = await accountLocks(client, [a.account_id]); const account = accounts.get(a.account_id)!;
          const req = await row(client, 'SELECT * FROM requirements WHERE id=$1 FOR UPDATE', [requirementId]);
          scoped(a, requirementId); demand(req.buyer_organization === a.organization_id && req.buyer_account === a.account_id, 'FORBIDDEN');
          demand(number(req.record_version) === pub.expectedRecordVersion && number(req.revision) === pub.requirementRevision, 'REVISION_CONFLICT');
          demand(req.state === 'draft', 'REVISION_CONFLICT');
          demand((await this.#missing(client, req.draft as Input<'createRequirementDraft'>)).length === 0, 'VALIDATION_FAILED');
          const lines = (await client.query<Row>('SELECT * FROM requirement_lines WHERE requirement_id=$1 ORDER BY line_id FOR UPDATE', [requirementId])).rows;
          demand(new Set(pub.slots.map(s => s.slotId)).size === pub.slots.length, 'VALIDATION_FAILED');
          for (const l of lines) demand(safeTotal(pub.slots.filter(s => s.lineId === l.line_id).map(s => s.quantity.value)) <= number(l.quantity), 'VALIDATION_FAILED');
          cost = safeTotal(pub.slots.map(s => s.compensation.minorUnits)); moneyBudget(a, cost);
          demand(number(account.balance) - number(account.reserved) >= cost, 'INSUFFICIENT_FUNDS');
          for (const s of pub.slots) {
            const l = lines.find(l => l.line_id === s.lineId); demand(l, 'VALIDATION_FAILED');
            demand(l.unit === s.quantity.unit && l.specification_id === s.specificationId && number(l.specification_revision) === s.specificationRevision, 'REVISION_CONFLICT');
            const spec = await row(client, 'SELECT * FROM specifications WHERE id=$1 AND revision=$2', [s.specificationId, s.specificationRevision]);
            demand(spec.unit === s.quantity.unit && spec.reviewed_fixture, 'VALIDATION_FAILED');
            await row(client, 'SELECT * FROM fixture_terms WHERE id=$1 AND revision=$2', [s.termsId, s.termsRevision]);
            demand(s.compensation.currency === account.currency && s.slotPrice.currency === account.currency, 'VALIDATION_FAILED');
            await client.query(`INSERT INTO slots(id,requirement_id,line_id,requirement_revision,specification_id,specification_revision,
              terms_id,terms_revision,quantity,unit,compensation,price,currency,expires_at,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'available')`,
            [s.slotId, requirementId, s.lineId, pub.requirementRevision, s.specificationId, s.specificationRevision,
              s.termsId, s.termsRevision, s.quantity.value, s.quantity.unit, s.compensation.minorUnits, s.slotPrice.minorUnits, s.slotPrice.currency, s.expiresAt]);
            await client.query("INSERT INTO holds(slot_id,buyer_account,currency,amount,state) VALUES($1,$2,$3,$4,'held')", [s.slotId,a.account_id,s.compensation.currency,s.compensation.minorUnits]);
          }
          const timestamp=await now(client); grantTime(a,timestamp);
          demand(pub.slots.every(s => Date.parse(s.expiresAt)>timestamp.getTime()),'SLOT_EXPIRED');
          await client.query('UPDATE accounts SET reserved=reserved+$1 WHERE id=$2', [cost,a.account_id]);
          await client.query("UPDATE requirements SET state='published', record_version=record_version+1 WHERE id=$1", [requirementId]);
          receipt = result('published', { requirementId }, { slots: pub.slots.map(s => s.slotId), reservedMinorUnits: cost },
            { recordVersion: 2, requirementRevision: pub.requirementRevision }, 'producer', 'purchase_slot');
        } else {
          const cmd = input as Input<'purchaseSlot'> | Input<'withdrawUnpurchasedSlot'> | Input<'processExpiredSlot'>;
          // Read immutable references to determine lock IDs; all mutable decisions happen after locks.
          const ref = await row(client, `SELECT s.requirement_id,r.buyer_account,t.recipient_account FROM slots s
            JOIN requirements r ON r.id=s.requirement_id JOIN fixture_terms t ON t.id=s.terms_id AND t.revision=s.terms_revision WHERE s.id=$1`, [cmd.slotId]);
          requirementId = ref.requirement_id as string;
          const authorized=await row(client,'SELECT * FROM requirements WHERE id=$1',[requirementId]);
          // Deny invisible objects before financial contention/state/revision errors can disclose them.
          // Reviewed capability is held through commit, in Identity's lock phase before account locks.
          await visible(client,a,authorized);
          // Owning-org read visibility never substitutes for reviewed producer eligibility.
          if (operation === 'purchaseSlot') demand(await eligible(client,a,authorized),'FORBIDDEN');
          if (operation !== 'purchaseSlot') demand(authorized.buyer_organization === a.organization_id && authorized.buyer_account === a.account_id,'FORBIDDEN');
          const ids = operation === 'purchaseSlot' ? [ref.buyer_account as string,a.account_id,ref.recipient_account as string] : [ref.buyer_account as string];
          const accounts = await accountLocks(client, ids);
          const req = await row(client, 'SELECT * FROM requirements WHERE id=$1 FOR UPDATE', [requirementId]);
          scoped(a,requirementId); demand(req.state === 'published','FORBIDDEN');
          if (operation !== 'purchaseSlot') demand(req.buyer_organization === a.organization_id && req.buyer_account === a.account_id, 'FORBIDDEN');
          const s = await row(client, 'SELECT * FROM slots WHERE id=$1 FOR UPDATE', [cmd.slotId]);
          const h = await row(client, 'SELECT * FROM holds WHERE slot_id=$1 FOR UPDATE', [cmd.slotId]);
          const timestamp = await now(client); grantTime(a, timestamp);
          // Availability/commitment checks precede mutable version conflicts for the loser of a last-slot race.
          if (operation === 'purchaseSlot') demand(s.state === 'available', 'SLOT_UNAVAILABLE');
          else demand(s.state !== 'purchased', 'COMMITMENT_DISPOSITION_REQUIRED');
          demand(number(s.record_version) === cmd.expectedRecordVersion && number(s.requirement_revision) === cmd.requirementRevision
            && number(s.specification_revision) === cmd.specificationRevision && number(s.terms_revision) === cmd.termsRevision, 'REVISION_CONFLICT');
          const revisions = { requirementRevision: cmd.requirementRevision, specificationRevision: cmd.specificationRevision,
            termsRevision: cmd.termsRevision, recordVersion: number(s.record_version) + 1 };
          if (operation === 'purchaseSlot') {
            demand((s.expires_at as Date).getTime() > timestamp.getTime(), 'SLOT_EXPIRED');
            demand(h.state === 'held' && number(h.amount) === number(s.compensation) && h.buyer_account === req.buyer_account, 'INSUFFICIENT_FUNDS');
            const buyer = accounts.get(req.buyer_account as string)!; const producer = accounts.get(a.account_id)!;
            const recipient = accounts.get(ref.recipient_account as string)!;
            demand(number(buyer.reserved) >= number(h.amount), 'INSUFFICIENT_FUNDS');
            demand(producer.currency === s.currency && recipient.currency === s.currency, 'VALIDATION_FAILED');
            cost = number(s.price); moneyBudget(a, cost);
            demand(number(producer.balance) - number(producer.reserved) >= cost, 'INSUFFICIENT_FUNDS');
            safeTotal([number(recipient.balance),cost]);
            const commitmentId = randomUUID();
            receipt = result('purchased', { requirementId, slotId: cmd.slotId, commitmentId,
              specificationId: s.specification_id as string,termsId: s.terms_id as string,lineId: s.line_id as string },
              { quantity: { value: number(s.quantity), unit: s.unit as string }, compensation: { minorUnits: number(s.compensation), currency: s.currency as string },
                slotPrice: { minorUnits: cost, currency: s.currency as string }, fixtureTerms: { recipientAccount: ref.recipient_account as string,
                  compensationTrigger: 'accepted_full_slot', disposition: 'unpurchased_release_only' } }, revisions, 'producer', 'capacity_confirmation_pending');
            await client.query("INSERT INTO commitments VALUES($1,$2,$3,$4,$5,'purchased')", [commitmentId,cmd.slotId,a.organization_id,a.actor_id,receipt]);
            await client.query("UPDATE slots SET state='purchased',record_version=record_version+1 WHERE id=$1", [cmd.slotId]);
            await client.query("UPDATE holds SET state='committed',commitment_id=$1 WHERE slot_id=$2", [commitmentId,cmd.slotId]);
            await client.query('UPDATE accounts SET balance=balance-$1 WHERE id=$2', [cost,a.account_id]);
            await client.query('UPDATE accounts SET balance=balance+$1 WHERE id=$2', [cost,ref.recipient_account]);
            await client.query("INSERT INTO journal_entries VALUES($1,$2,$3,$4,'synthetic_slot_price'),($1,$5,$3,$6,'synthetic_slot_price')", [commitmentId,a.account_id,s.currency,-cost,ref.recipient_account,cost]);
          } else {
            if (operation === 'processExpiredSlot') demand((s.expires_at as Date).getTime() <= timestamp.getTime(), 'VALIDATION_FAILED');
            demand(s.state === 'available' && h.state === 'held', 'SLOT_UNAVAILABLE');
            const state = operation === 'processExpiredSlot' ? 'expired' : 'withdrawn';
            await client.query('UPDATE slots SET state=$1,record_version=record_version+1 WHERE id=$2', [state,cmd.slotId]);
            await client.query("UPDATE holds SET state='released' WHERE slot_id=$1", [cmd.slotId]);
            await client.query('UPDATE accounts SET reserved=reserved-$1 WHERE id=$2', [h.amount,h.buyer_account]);
            receipt = result(state, { requirementId, slotId: cmd.slotId }, { releasedMinorUnits: number(h.amount) }, revisions);
          }
        }
        await client.query('UPDATE grants SET used_minor=used_minor+$1 WHERE id=$2', [cost,context.grantId]);
        const happenedAt = await now(client); grantTime(a,happenedAt); const eventId = randomUUID();
        const audit = event.parse({ schemaVersion: BASELINE, eventId, actorId: context.actorId, organizationId: context.organizationId,
          operation, happenedAt: happenedAt.toISOString(), requirementId, recordIds: receipt.recordIds, revisions: receipt.revisions,
          reason: 'reason' in input ? input.reason : operation, synthetic: true });
        await client.query('INSERT INTO audit_events(id,requirement_id,actor_id,payload,happened_at) VALUES($1,$2,$3,$4,$5)', [eventId,requirementId,context.actorId,audit,happenedAt]);
        await client.query('INSERT INTO outbox(event_id) VALUES($1)', [eventId]);
        await client.query('INSERT INTO idempotency VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [context.actorId,context.organizationId,operation,input.idempotencyKey,fingerprint(input),requirementId,cost,receipt]);
        await client.query('COMMIT'); return receipt;
      } catch (error) {
        await client.query('ROLLBACK');
        const code = (error as { code?: string }).code;
        if (['40P01','40001','55P03','57014'].includes(code ?? '')) {
          if (attempt < 2) continue; throw new BusinessError('RETRYABLE_BUSY');
        }
        if (['23505','23514','23503'].includes(code ?? '')) throw new BusinessError('VALIDATION_FAILED');
        throw error;
      } finally { client.release(); }
    }
    throw new BusinessError('RETRYABLE_BUSY');
  }
  async #missing(client: PoolClient, draft: Input<'createRequirementDraft'>): Promise<string[]> {
    const missing = [];
    if (!draft.destination) missing.push('destination');
    if (!draft.deliveryWindow || Date.parse(draft.deliveryWindow.from) >= Date.parse(draft.deliveryWindow.to)) missing.push('deliveryWindow');
    if (!draft.acceptanceCriteria?.length) missing.push('acceptanceCriteria');
    for (const l of draft.lines) {
      const spec = (await client.query<Row>('SELECT * FROM specifications WHERE id=$1 AND revision=$2', [l.specificationId,l.specificationRevision])).rows[0];
      if (!spec || !spec.reviewed_fixture || spec.unit !== l.quantity.unit) missing.push(`lines.${l.lineId}.releasedSpecificationOrUnit`);
    }
    return missing;
  }
  async query<O extends Operation>(context: Context, operation: O, input: Input<O>): Promise<Success> {
    if (isMarketOperation(operation)) return marketQuery(this.pool,context,operation,input);
    const client = await this.pool.connect();
    try {
      // One coherent snapshot for projections assembled from multiple records.
      // Current grants/membership/capability are locked; a concurrent authority
      // update after the snapshot aborts rather than authorizing an old version.
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await client.query("SET LOCAL lock_timeout='250ms'");
      await client.query("SET LOCAL statement_timeout='3s'");
      const a = await authority(client, context, operation);
      const finish=async (receipt: Success) => { grantTime(a,await now(client)); await client.query('COMMIT'); return receipt; };
      if (operation === 'getWorkspace') {
        // Discovery of one's persisted work, including work created by another adapter.
        // No competing producer receipts or foreign financial account projections.
        demand(['buyer_agent','buyer_human','producer'].includes(a.role),'FORBIDDEN');
        const filter = input as Input<'getWorkspace'>;
        const producer = a.role === 'producer';
        const records = producer
          ? await client.query<Row>(`SELECT c.id,c.receipt,r.draft->>'intendedUse' AS title FROM commitments c
              JOIN slots s ON s.id=c.slot_id JOIN requirements r ON r.id=s.requirement_id
              WHERE c.producer_organization=$1 AND ('*'=ANY($2::text[]) OR r.id=ANY($2::text[]))
              AND ($3::text IS NULL OR c.id>$3) ORDER BY c.id LIMIT $4`,
            [a.organization_id,a.requirement_scopes,filter.cursor ?? null,filter.limit+1])
          : await client.query<Row>(`SELECT r.id,r.state,r.revision,r.record_version,r.draft,
              (SELECT count(*) FROM slots s WHERE s.requirement_id=r.id) AS slot_count
              FROM requirements r WHERE r.buyer_organization=$1
              AND ('*'=ANY($2::text[]) OR r.id=ANY($2::text[])) AND ($3::text IS NULL OR r.id>$3)
              ORDER BY r.id LIMIT $4`,[a.organization_id,a.requirement_scopes,filter.cursor ?? null,filter.limit+1]);
        const page=records.rows.slice(0,filter.limit);
        const account=await row(client,'SELECT currency,balance,reserved FROM accounts WHERE id=$1 AND organization_id=$2',[a.account_id,a.organization_id]);
        const terms=(await client.query<Row>('SELECT * FROM fixture_terms WHERE synthetic ORDER BY id,revision')).rows;
        const references=(await client.query<Row>('SELECT id,revision,unit,criteria FROM specifications WHERE reviewed_fixture ORDER BY id,revision')).rows;
        return await finish(result('audit',{}, { role: a.role,actorId: a.actor_id,organizationId: a.organization_id,
          funds: { currency: account.currency as string,balanceMinorUnits: number(account.balance),reservedMinorUnits: number(account.reserved),
            availableMinorUnits: number(account.balance)-number(account.reserved) },
          collection: producer ? 'commitments' : 'requirements',records: page.map((r): Success['data'] => producer
            ? { id: r.id as string,title: r.title as string,receipt: success.parse(r.receipt) }
            : { id: r.id as string,title: (r.draft as { intendedUse: string }).intendedUse,state: r.state as string,
              requirementRevision: number(r.revision),recordVersion: number(r.record_version),slotCount: number(r.slot_count) }),
          nextCursor: records.rows.length>filter.limit ? page.at(-1)!.id as string : null,
          terms: terms.map(t => ({ id:t.id as string,revision:number(t.revision),fixtureTerms:{ synthetic:true,recipientAccount:t.recipient_account as string,compensationTrigger:t.compensation_trigger as string,disposition:t.disposition as string } })),
          specifications: references.map(s => ({ id: s.id as string,revision: number(s.revision),unit: s.unit as string,
            criteria: s.criteria as Success['data'][string],reviewedFixture: true })) }));
      }
      if (operation === 'listAvailableSlots') {
        const filter = input as Input<'listAvailableSlots'>;
        const processes=a.role === 'producer' ? await reviewedProcesses(client,a) : null;
        const rows = await client.query<Row>(`SELECT s.*,t.recipient_account,t.compensation_trigger,t.disposition,sp.criteria
          FROM slots s JOIN requirements r ON r.id=s.requirement_id
          JOIN fixture_terms t ON t.id=s.terms_id AND t.revision=s.terms_revision
          JOIN specifications sp ON sp.id=s.specification_id AND sp.revision=s.specification_revision
          WHERE s.state='available' AND s.expires_at>clock_timestamp()
          AND ($1::text IS NULL OR s.requirement_id=$1) AND ($2::text IS NULL OR s.id>$2)
          AND ('*'=ANY($3::text[]) OR s.requirement_id=ANY($3::text[]))
          AND ($4='operator' OR r.buyer_organization=$5 OR ($4='producer' AND $6::text[] IS NOT NULL AND r.state='published'
            AND EXISTS(SELECT 1 FROM requirement_lines l WHERE l.requirement_id=r.id)
            AND NOT EXISTS(SELECT 1 FROM requirement_lines l LEFT JOIN specifications p
              ON p.id=l.specification_id AND p.revision=l.specification_revision WHERE l.requirement_id=r.id
              AND (p.criteria->>'process' IS NULL OR NOT (p.criteria->>'process'=ANY($6::text[]))))))
          ORDER BY s.id LIMIT $7`, [filter.requirementId ?? null,filter.cursor ?? null,a.requirement_scopes,
          a.role,a.organization_id,processes,filter.limit+1]);
        const slots=rows.rows.slice(0,filter.limit).map(s => this.#slotData(s));
        return await finish(result('available', {}, { slots,nextCursor: rows.rows.length>filter.limit ? slots.at(-1)!.slotId as string : null }));
      }
      if (operation === 'getCommitment') {
        const c = await row(client,'SELECT * FROM commitments WHERE id=$1',[(input as Input<'getCommitment'>).commitmentId]);
        const s = await row(client,'SELECT * FROM slots WHERE id=$1',[c.slot_id]);
        const req = await row(client,'SELECT * FROM requirements WHERE id=$1',[s.requirement_id]);
        scoped(a,req.id as string);
        demand(a.role === 'operator' || a.organization_id === req.buyer_organization || a.organization_id === c.producer_organization,'FORBIDDEN');
        return await finish(success.parse(c.receipt));
      }
      const requirementId = (input as Input<'getRequirement'>).requirementId;
      const req = await row(client,'SELECT * FROM requirements WHERE id=$1',[requirementId]); await visible(client,a,req);
      let receipt: Success;
      if (operation === 'getRequirement') {
        const slots = (await client.query<Row>('SELECT id FROM slots WHERE requirement_id=$1 ORDER BY id',[requirementId])).rows;
        const commitments=(await client.query<Row>(`SELECT c.id,c.slot_id FROM commitments c JOIN slots s ON s.id=c.slot_id
          WHERE s.requirement_id=$1 AND ($2 OR c.producer_organization=$3)`,[requirementId,a.role === 'operator' || a.organization_id === req.buyer_organization,a.organization_id])).rows;
        const views=await Promise.all(slots.map(s => this.#slotView(client,s.id as string)));
        receipt = result(req.state as string,{ requirementId },{ draft: req.draft as Success['data'][string],
          missing: await this.#missing(client,req.draft as Input<'createRequirementDraft'>),
          slots: views.map(s => { const c=commitments.find(c => c.slot_id === s.slotId); return { ...s,...(c ? { commitmentId:c.id as string } : {}) }; }) },
        { recordVersion: number(req.record_version),requirementRevision: number(req.revision) });
      } else {
        const filter = input as Input<'getScopedAudit'>;
        const own = a.role === 'operator' || a.organization_id === req.buyer_organization;
        const events = await client.query<Row>(`SELECT sequence,payload FROM audit_events WHERE requirement_id=$1 AND sequence>$2
          AND ($3 OR actor_id=$4) ORDER BY sequence LIMIT $5`,[requirementId,filter.cursor ?? '0',own,a.actor_id,filter.limit]);
        receipt = result('audit',{ requirementId },{ events: events.rows.map(e => e.payload as Success['data'][string]),
          nextCursor: events.rows.at(-1)?.sequence as string ?? null });
      }
      return await finish(receipt);
    } catch (error) {
      await client.query('ROLLBACK');
      if (['40P01','40001','55P03','57014'].includes((error as { code?: string }).code ?? '')) throw new BusinessError('RETRYABLE_BUSY');
      throw error;
    } finally { client.release(); }
  }
  async #slotView(client: PoolClient, slotId: string): Promise<Success['data']> {
    const s = await row(client,`SELECT s.*,t.recipient_account,t.compensation_trigger,t.disposition,sp.criteria FROM slots s
      JOIN fixture_terms t ON t.id=s.terms_id AND t.revision=s.terms_revision
      JOIN specifications sp ON sp.id=s.specification_id AND sp.revision=s.specification_revision WHERE s.id=$1`,[slotId]);
    return this.#slotData(s);
  }
  #slotData(s: Row): Success['data'] {
    return { slotId: s.id as string, requirementId: s.requirement_id as string, lineId: s.line_id as string, state: s.state as string, recordVersion: number(s.record_version),
      requirementRevision: number(s.requirement_revision), specificationId: s.specification_id as string,
      specificationRevision: number(s.specification_revision), termsId: s.terms_id as string, termsRevision: number(s.terms_revision),
      quantity: { value: number(s.quantity),unit: s.unit as string }, compensation: { minorUnits: number(s.compensation),currency: s.currency as string },
      slotPrice: { minorUnits: number(s.price),currency: s.currency as string },expiresAt: (s.expires_at as Date).toISOString(),
      releasedSpecification: { criteria: s.criteria as Success['data'][string],reviewedFixture: true },
      fixtureTerms: { synthetic: true,recipientAccount: s.recipient_account as string,compensationTrigger: s.compensation_trigger as string,disposition: s.disposition as string } };
  }
}
