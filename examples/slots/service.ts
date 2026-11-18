import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

type Row = Record<string, string | number | null>;
type Principal = Row & { id: string; organization: string; role: string; account_id: string };
type SlotTerms = {
  id: string; quantity: number; termsRevision: number; compensation: number;
  price: number; currency: string; expiresAt: number;
};
type Publication = { requirementId: string; expectedRevision: number; slots: SlotTerms[] };
type Purchase = { slotId: string; specRevision: number; termsRevision: number };
type Release = { slotId: string; specRevision: number; termsRevision: number; reason: 'withdrawn' | 'expired' };
export type Result = Record<string, string | number | string[]>;

export class SlotError extends Error {
  code: string;
  constructor(code: string) { super(code); this.code = code; }
}
function require(condition: unknown, code: string): asserts condition {
  if (!condition) throw new SlotError(code);
}
function object(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  require(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_INPUT');
  require(Object.keys(value).sort().join(',') === [...keys].sort().join(','), 'INVALID_INPUT');
}
function id(value: unknown): asserts value is string {
  require(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$/.test(value), 'INVALID_INPUT');
}
function integer(value: unknown, minimum = 0): asserts value is number {
  require(Number.isSafeInteger(value) && (value as number) >= minimum, 'INVALID_INPUT');
}
function total(values: number[]): number {
  return values.reduce((sum, value) => { integer(sum + value); return sum + value; }, 0);
}
function purchaseInput(raw: unknown): Purchase {
  object(raw, ['slotId', 'specRevision', 'termsRevision']);
  id(raw.slotId); integer(raw.specRevision, 1); integer(raw.termsRevision, 1);
  return { slotId: raw.slotId, specRevision: raw.specRevision, termsRevision: raw.termsRevision };
}
function publicationInput(raw: unknown): Publication {
  object(raw, ['requirementId', 'expectedRevision', 'slots']);
  id(raw.requirementId); integer(raw.expectedRevision, 1);
  require(Array.isArray(raw.slots) && raw.slots.length > 0 && raw.slots.length <= 100, 'INVALID_INPUT');
  const slots = raw.slots.map((value: unknown) => {
    object(value, ['id', 'quantity', 'termsRevision', 'compensation', 'price', 'currency', 'expiresAt']);
    id(value.id); integer(value.quantity, 1); integer(value.termsRevision, 1);
    integer(value.compensation); integer(value.price); integer(value.expiresAt, 1);
    require(typeof value.currency === 'string' && /^[A-Z]{3}$/.test(value.currency), 'INVALID_INPUT');
    return { id: value.id, quantity: value.quantity, termsRevision: value.termsRevision,
      compensation: value.compensation, price: value.price, currency: value.currency,
      expiresAt: value.expiresAt };
  }).sort((a, b) => a.id.localeCompare(b.id));
  require(new Set(slots.map(s => s.id)).size === slots.length, 'INVALID_INPUT');
  return { requirementId: raw.requirementId, expectedRevision: raw.expectedRevision, slots };
}

// A local application-service spike, with fixture identity supplied by a trusted caller.
// It exposes no HTTP/MCP listener and does not authenticate real users.
export class SlotService {
  #db: DatabaseSync;
  #clock: () => number;
  constructor(path: string, clock: () => number = Date.now, busyTimeoutMs = 100) {
    this.#db = new DatabaseSync(path, { timeout: busyTimeoutMs });
    this.#db.exec('PRAGMA foreign_keys = ON');
    this.#clock = clock;
  }
  close() { this.#db.close(); }
  #get(sql: string, ...args: (string | number)[]): Row {
    const row = this.#db.prepare(sql).get(...args);
    require(row, 'NOT_FOUND');
    return row as Row;
  }
  #run(sql: string, ...args: (string | number)[]) { return this.#db.prepare(sql).run(...args); }

  #command(actorId: string, key: string, operation: string, role: string, input: object,
    action: (principal: Principal, now: number) => Result): Result {
    id(actorId); id(key);
    const fingerprint = JSON.stringify(input);
    // BEGIN IMMEDIATE serializes writers across connections, including different requirements.
    // Only lock errors retry; all business errors roll back without caching a failed result.
    for (let attempt = 0; attempt < 3; attempt++) {
      let begun = false;
      try {
        this.#db.exec('BEGIN IMMEDIATE'); begun = true;
        const principal = this.#get('SELECT * FROM principals WHERE id = ?', actorId) as Principal;
        require(principal.active === 1 && principal.role === role, 'INSUFFICIENT_AUTHORITY');
        const cached = this.#db.prepare(`SELECT * FROM idempotency
          WHERE actor_id = ? AND organization = ? AND operation = ? AND key = ?`)
          .get(actorId, principal.organization, operation, key);
        if (cached) {
          require(cached.fingerprint === fingerprint, 'IDEMPOTENCY_CONFLICT');
          this.#db.exec('COMMIT');
          return JSON.parse(cached.result as string);
        }
        const now = this.#clock(); integer(now);
        const result = action(principal, now);
        const eventId = randomUUID();
        this.#run('INSERT INTO audit_events VALUES (?, ?, ?, ?, ?, ?, 1)',
          eventId, actorId, principal.organization, operation,
          JSON.stringify({ input, result, synthetic: true }), now);
        this.#run("INSERT INTO outbox VALUES (?, 'pending')", eventId);
        this.#run('INSERT INTO idempotency VALUES (?, ?, ?, ?, ?, ?)',
          actorId, principal.organization, operation, key, fingerprint, JSON.stringify(result));
        this.#db.exec('COMMIT');
        return result;
      } catch (error) {
        if (begun) this.#db.exec('ROLLBACK');
        const code = (error as { errcode?: number }).errcode;
        if (code !== undefined && [5, 6].includes(code & 255)) {
          if (attempt < 2) continue;
          throw new SlotError('RETRYABLE_BUSY');
        }
        throw error;
      }
    }
    throw new SlotError('RETRYABLE_BUSY');
  }

  publish(actorId: string, key: string, raw: unknown): Result {
    const input = publicationInput(raw);
    return this.#command(actorId, key, 'publish', 'buyer', input, (actor, now) => {
      const req = this.#get('SELECT * FROM requirements WHERE id = ?', input.requirementId);
      require(req.buyer_account === actor.account_id, 'INSUFFICIENT_AUTHORITY');
      require(req.revision === input.expectedRevision, 'STALE_REVISION');
      require(req.state === 'draft', 'ALREADY_PUBLISHED');
      require(total(input.slots.map(s => s.quantity)) <= (req.quantity as number), 'QUANTITY_EXCEEDED');
      const account = this.#get('SELECT * FROM accounts WHERE id = ?', actor.account_id);
      const amount = total(input.slots.map(s => s.compensation));
      for (const slot of input.slots) {
        require(slot.currency === account.currency, 'CURRENCY_MISMATCH');
        require(slot.expiresAt > now, 'SLOT_EXPIRED');
      }
      // Reserve the entire publication before any slot becomes discoverable.
      const held = this.#run(`UPDATE accounts SET reserved = reserved + ?
        WHERE id = ? AND balance - reserved >= ?`, amount, actor.account_id, amount);
      require(held.changes === 1, 'FUNDING_UNAVAILABLE');
      for (const slot of input.slots) {
        this.#run('INSERT INTO slots VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          slot.id, input.requirementId, slot.quantity, req.spec_revision as number,
          slot.termsRevision, slot.compensation, slot.price, slot.currency, slot.expiresAt, 'available');
        this.#run("INSERT INTO reservations VALUES (?, ?, ?, 'held', NULL)",
          slot.id, actor.account_id, slot.compensation);
      }
      this.#run("UPDATE requirements SET state = 'published' WHERE id = ?", input.requirementId);
      return { requirementId: input.requirementId, slots: input.slots.map(s => s.id), reserved: amount };
    });
  }

  purchase(actorId: string, key: string, raw: unknown): Result {
    const input = purchaseInput(raw);
    return this.#command(actorId, key, 'purchase', 'producer', input, (actor, now) => {
      const slot = this.#get('SELECT * FROM slots WHERE id = ?', input.slotId);
      const eligible = this.#db.prepare(`SELECT 1 FROM eligible_producers
        WHERE requirement_id = ? AND principal_id = ?`).get(slot.requirement_id, actor.id);
      require(eligible, 'INSUFFICIENT_AUTHORITY');
      require(slot.spec_revision === input.specRevision && slot.terms_revision === input.termsRevision, 'STALE_REVISION');
      require(slot.state === 'available', 'SLOT_UNAVAILABLE');
      require((slot.expires_at as number) > now, 'SLOT_EXPIRED');
      const hold = this.#get('SELECT * FROM reservations WHERE slot_id = ?', input.slotId);
      require(hold.state === 'held' && hold.amount === slot.compensation, 'FUNDING_UNAVAILABLE');
      const producer = this.#get('SELECT * FROM accounts WHERE id = ?', actor.account_id);
      const suspense = this.#get("SELECT * FROM accounts WHERE id = 'slot-price-suspense'");
      require(producer.currency === slot.currency && suspense.currency === slot.currency, 'CURRENCY_MISMATCH');
      const debited = this.#run(`UPDATE accounts SET balance = balance - ?
        WHERE id = ? AND balance - reserved >= ?`, slot.price as number, actor.account_id, slot.price as number);
      require(debited.changes === 1, 'PRODUCER_FUNDS_UNAVAILABLE');
      integer((suspense.balance as number) + (slot.price as number));
      this.#run("UPDATE accounts SET balance = balance + ? WHERE id = 'slot-price-suspense'", slot.price as number);
      const commitmentId = randomUUID();
      this.#run('INSERT INTO commitments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        commitmentId, input.slotId, actor.id, slot.spec_revision as number, slot.terms_revision as number,
        slot.quantity as number, slot.compensation as number, slot.price as number, slot.currency as string);
      const allocated = this.#run("UPDATE slots SET state = 'purchased' WHERE id = ? AND state = 'available'", input.slotId);
      require(allocated.changes === 1, 'SLOT_UNAVAILABLE');
      // Transfer the publication hold; do not reserve buyer funds a second time.
      this.#run("UPDATE reservations SET state = 'committed', commitment_id = ? WHERE slot_id = ?", commitmentId, input.slotId);
      for (const [account, amount] of [[actor.account_id, -(slot.price as number)], ['slot-price-suspense', slot.price]] as [string, number][]) {
        this.#run('INSERT INTO journal_entries VALUES (?, ?, ?, ?, ?)',
          commitmentId, account, amount, slot.currency as string, 'synthetic_slot_price');
      }
      return { slotId: input.slotId, commitmentId, producerId: actor.id };
    });
  }

  release(actorId: string, key: string, raw: unknown): Result {
    object(raw, ['slotId', 'specRevision', 'termsRevision', 'reason']);
    const input: Release = { ...purchaseInput({ slotId: raw.slotId,
      specRevision: raw.specRevision, termsRevision: raw.termsRevision }), reason: raw.reason as Release['reason'] };
    require(['withdrawn', 'expired'].includes(input.reason), 'INVALID_INPUT');
    return this.#command(actorId, key, 'release', 'buyer', input, (actor, now) => {
      const slot = this.#get('SELECT * FROM slots WHERE id = ?', input.slotId);
      const req = this.#get('SELECT * FROM requirements WHERE id = ?', slot.requirement_id as string);
      require(req.buyer_account === actor.account_id, 'INSUFFICIENT_AUTHORITY');
      require(slot.spec_revision === input.specRevision && slot.terms_revision === input.termsRevision, 'STALE_REVISION');
      if (slot.state === 'withdrawn' || slot.state === 'expired') return { slotId: input.slotId, released: 0, state: slot.state };
      require(slot.state === 'available', 'COMMITMENT_DISPOSITION_REQUIRED');
      if (input.reason === 'expired') require((slot.expires_at as number) <= now, 'NOT_EXPIRED');
      const hold = this.#get('SELECT * FROM reservations WHERE slot_id = ?', input.slotId);
      require(hold.state === 'held', 'FUNDING_UNAVAILABLE');
      this.#run("UPDATE reservations SET state = 'released' WHERE slot_id = ?", input.slotId);
      this.#run('UPDATE accounts SET reserved = reserved - ? WHERE id = ?', hold.amount as number, actor.account_id);
      this.#run('UPDATE slots SET state = ? WHERE id = ?', input.reason, input.slotId);
      return { slotId: input.slotId, released: hold.amount as number, state: input.reason };
    });
  }
}
