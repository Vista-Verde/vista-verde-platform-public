import type { Command, Envelope, Operation, Success } from '../../packages/contracts/src/index.ts';
import { commandNames,marketCommandNames } from '../../packages/contracts/src/operation-names.ts';

export type Session = { producerExchange?:boolean; signedIn: boolean; csrf: string; persona: string | null; personas: { id: string; label: string }[] };
export type Pending = { persona: string; operation: Command; input: Record<string, unknown>; label: string; uncertain?: boolean };
export type Failure = Error & { code?: string; retryable?: boolean; details?: string };
export const commands: readonly Command[] = commandNames;
const labels: Record<string,string> = {
  INSUFFICIENT_FUNDS:'Insufficient synthetic funds. Nothing was published or charged. Review the available balance and try a smaller amount.',
  SLOT_UNAVAILABLE:'This slot is no longer available. Another purchase or closure won. Nothing was charged for this attempt.',
  SLOT_EXPIRED:'This slot has expired. No new purchase or publication was made.',
  REVISION_CONFLICT:'The record changed since this view opened. Refresh and review the current revisions before trying again.',
  FORBIDDEN:'This action or record is unavailable to the current demo grant. Check the role, organization and reviewed eligibility.',
  UNAUTHENTICATED:'The demo session or fixture grant expired. Select an available demo role again.',
  VALIDATION_FAILED:'These fields do not meet the shared contract. Review quantities, units, dates and released references.',
  RETRYABLE_BUSY:'The database is busy. Retry the saved request with its original key.',
  IDEMPOTENCY_CONFLICT:'This retry key belongs to different terms. The conflicting request made no change.',
  COMMITMENT_DISPOSITION_REQUIRED:'Purchased compensation stays reserved. A recorded disposition is required; this demo cannot release it.',
  ORDER_UNAVAILABLE:'The remaining demand or supply changed. Refresh both orders and review a smaller allocation.',
  PROPOSAL_EXPIRED:'This proposal expired. Review current orders before proposing new terms.',
  MATCH_INVALID:'These orders cannot be allocated together. Review their item, specification, unit and timing.',
  FULFILLMENT_CONFLICT:'This report or acknowledgement exceeds the remaining agreed quantity. Refresh the commitment and review its progress.',
  BUDGET_EXCEEDED:'These terms exceed the work order’s remaining stated budget. Review a smaller response or different terms. This budget does not represent held or paid funds.',
  INVENTORY_UNAVAILABLE:'This synthetic lot has insufficient unoffered quantity. Refresh its used, offered and allocated amounts before listing or recording use.'
};

// Only pending reads are coalesced. Writes are always explicit event-handler work;
// neither mounting, StrictMode nor a query retry can submit a business command.
export class WebClient {
  #fetch: typeof fetch;
  #boot?: Promise<Session>;
  #reads = new Map<string,Promise<Success>>();
  #readEpoch = 0;
  constructor(transport: typeof fetch = fetch) { this.#fetch = transport.bind(globalThis); }
  boot(): Promise<Session> {
    return this.#boot ??= this.#fetch('/session',{ credentials:'same-origin' }).then(async response => {
      if (!response.ok) throw new Error('Could not open the local demo session.');
      return await response.json() as Session;
    });
  }
  async switchSession(session: Session,persona?: string): Promise<Session> {
    const response = await this.#fetch('/session',{ method:persona ? 'POST' : 'DELETE',credentials:'same-origin',
      headers:{ 'content-type':'application/json','x-csrf-token':session.csrf },
      ...(persona ? { body:JSON.stringify({ persona }) } : {}) });
    if (!response.ok) throw new Error('This demo role is unavailable or expired. Reopen the local fixture if necessary.');
    return await response.json() as Session;
  }
  call(session: Session,operation: Operation,input: unknown): Promise<Success> {
    const write = (commands as readonly string[]).includes(operation);
    const body = JSON.stringify(input),key = JSON.stringify([session.csrf,this.#readEpoch,operation,body]);
    if (!write && this.#reads.has(key)) return this.#reads.get(key)!;
    const request = this.#fetch(`/${write ? 'commands' : 'queries'}/${operation}`,{ method:'POST',credentials:'same-origin',
      headers:{ 'content-type':'application/json','x-csrf-token':session.csrf },body }).then(async response => {
      const value = await response.json() as Envelope;
      if (typeof value.ok !== 'boolean') throw new Error('The server reply could not be verified.');
      if (!value.ok) throw Object.assign(new Error(labels[value.code] ?? value.message),{
        code:value.code,retryable:value.retryable,details:value.fieldIssues.map(issue => `${issue.field}: ${issue.message}`).join('; ')
      });
      return value;
    });
    if (write) {
      // A successful or interrupted write may have committed. Any subsequent
      // refresh must dispatch a new read, never reuse a pre-command snapshot.
      const invalidate = () => { this.#readEpoch++;this.#reads.clear(); };
      return request.then(value => { invalidate();return value; },error => { invalidate();throw error; });
    }
    this.#reads.set(key,request);
    // Attach cleanup on both outcomes without creating an unhandled rejection.
    const clear = () => { if (this.#reads.get(key) === request) this.#reads.delete(key); };
    void request.then(clear,clear);
    return request;
  }
}

export class PendingStore {
  #storage: Pick<Storage,'getItem'|'setItem'|'removeItem'>;
  #profile?:string;
  #commands:readonly Command[];
  constructor(storage: Pick<Storage,'getItem'|'setItem'|'removeItem'>,profile?:'vista-verde-work-orders.v0.3') {
    this.#storage=storage;this.#profile=profile;this.#commands=profile ? marketCommandNames:commands;
  }
  #key(persona:string):string { return this.#profile ? `vv.pending.${this.#profile}.${persona}`:`vv.pending.${persona}`; }
  read(persona: string): Pending | undefined {
    const text = this.#storage.getItem(this.#key(persona));
    if (!text) return;
    const saved = JSON.parse(text) as Pending & { profile?:string };
    if (!saved || saved.persona !== persona || saved.profile!==this.#profile || !this.#commands.includes(saved.operation) || typeof saved.label !== 'string' ||
      !saved.input || typeof saved.input !== 'object' || Array.isArray(saved.input) || typeof saved.input.idempotencyKey !== 'string') {
      throw new Error('The saved request is unreadable. Its original terms must be recovered before another command can run.');
    }
    // A prior document may have ended before it received ANY reply. A later denial
    // cannot establish that this historical request did not already commit.
    return { ...saved,uncertain:true };
  }
  save(request: Pending): void {
    if (!this.#commands.includes(request.operation)) throw new Error('Saved request belongs to a different data profile.');
    this.#storage.setItem(this.#key(request.persona),JSON.stringify({ ...request,...(this.#profile ? { profile:this.#profile }:{}) }));
  }
  complete(request: Pending): void {
    const current = this.read(request.persona);
    if (current?.operation === request.operation && current.input.idempotencyKey === request.input.idempotencyKey) {
      this.#storage.removeItem(this.#key(request.persona));
    }
  }
}
export function createPending(persona: string,operation: Command,input: Record<string,unknown>,label: string,key: string): Pending {
  return { persona,operation,input:{ ...structuredClone(input),idempotencyKey:key },label };
}
export function retainPending(request: Pending,error: Failure): boolean {
  const deniedRecovery = request.uncertain && ['FORBIDDEN','UNAUTHENTICATED','IDEMPOTENCY_CONFLICT'].includes(error.code ?? '');
  return !error.code || Boolean(error.retryable) || error.code === 'INTERNAL_ERROR' || Boolean(deniedRecovery);
}
export function usd(value: FormDataEntryValue | null): number {
  const text = String(value ?? '');
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(text)) throw new Error('Enter a nonnegative USD amount with at most two decimal places.');
  const [whole,fraction = ''] = text.split('.');
  const minor = Number(whole)*100+Number(fraction.padEnd(2,'0'));
  if (!Number.isSafeInteger(minor)) throw new Error('The amount is too large.');
  return minor;
}
