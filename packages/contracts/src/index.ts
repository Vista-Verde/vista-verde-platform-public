import { createHash } from 'node:crypto';
import { z } from 'zod';
import { marketOperations } from './market.ts';
import { commandNames } from './operation-names.ts';
export { commandNames } from './operation-names.ts';
export * from './market.ts';

export const BASELINE = 'foundation.v0.1' as const;
export const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,99}$/);
export const count = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const revision = count.max(2147483647);
export const minor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const instant = z.iso.datetime({ offset: false });
export const auditCursor = z.string().regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine(value => value.length<=19 && /^[0-9]+$/.test(value) && BigInt(value)<=9223372036854775807n,'Cursor exceeds the audit sequence range.');
export const money = z.strictObject({ minorUnits: minor, currency: z.string().regex(/^[A-Z]{3}$/) });
export const quantity = z.strictObject({ value: count, unit: z.string().min(1).max(40) });
const meta = { idempotencyKey: id };
const expected = { expectedRecordVersion: revision };
const released = { requirementRevision: revision, specificationRevision: revision, termsRevision: revision };
export const line = z.strictObject({ lineId: id, quantity, specificationId: id, specificationRevision: revision });
export const slot = z.strictObject({
  slotId: id, lineId: id, quantity, specificationId: id, specificationRevision: revision,
  termsId: id, termsRevision: revision, slotPrice: money, compensation: money, expiresAt: instant
});
export const operations = {
  getWorkspace: z.strictObject({ cursor: id.optional(), limit: count.max(100).default(20) }),
  createRequirementDraft: z.strictObject({ ...meta, intendedUse: z.string().min(1).max(500),
    lines: z.array(line).min(1).max(20), destination: z.string().min(1).max(300).optional(),
    deliveryWindow: z.strictObject({ from: instant, to: instant }).optional(),
    acceptanceCriteria: z.array(z.string().min(1).max(300)).min(1).max(20).optional() }),
  getRequirement: z.strictObject({ requirementId: id }),
  publishRequirement: z.strictObject({ ...meta, ...expected, requirementId: id,
    requirementRevision: revision, slots: z.array(slot).min(1).max(100) }),
  listAvailableSlots: z.strictObject({ requirementId: id.optional(), cursor: id.optional(), limit: count.max(100).default(20) }),
  purchaseSlot: z.strictObject({ ...meta, ...expected, ...released, slotId: id }),
  getCommitment: z.strictObject({ commitmentId: id }),
  withdrawUnpurchasedSlot: z.strictObject({ ...meta, ...expected, ...released, slotId: id, reason: z.string().min(1).max(300) }),
  processExpiredSlot: z.strictObject({ ...meta, ...expected, ...released, slotId: id }),
  getScopedAudit: z.strictObject({ requirementId: id, cursor: auditCursor.optional(), limit: count.max(100).default(20) }),
  ...marketOperations
};
export type Operation = keyof typeof operations;
export type Command = typeof commandNames[number];
export type Input<O extends Operation> = z.output<(typeof operations)[O]>;
export type CommandInput = Input<Command>;
export const contextSchema = z.strictObject({ actorId: id, organizationId: id, grantId: id,
  credentialMode: z.literal('local_fixture'), requestId: id });
export type Context = z.infer<typeof contextSchema>;
export const codes = ['UNAUTHENTICATED', 'FORBIDDEN', 'VALIDATION_FAILED', 'REVISION_CONFLICT',
  'INELIGIBLE', 'INSUFFICIENT_FUNDS', 'SLOT_UNAVAILABLE', 'SLOT_EXPIRED', 'IDEMPOTENCY_CONFLICT',
  'COMMITMENT_DISPOSITION_REQUIRED', 'RETRYABLE_BUSY', 'INTERNAL_ERROR',
  'ORDER_UNAVAILABLE', 'PROPOSAL_EXPIRED', 'MATCH_INVALID', 'FULFILLMENT_CONFLICT', 'BUDGET_EXCEEDED', 'INVENTORY_UNAVAILABLE'] as const;
export type ErrorCode = typeof codes[number];
export const success = z.strictObject({ schemaVersion: z.literal(BASELINE), ok: z.literal(true),
  recordIds: z.record(z.string(), z.string()), revisions: z.record(z.string(), count),
  state: z.enum(['draft','published','available','purchased','withdrawn','expired','audit',
    'market','item','order','workspace','project','proposed','awaiting_confirmation','partially_approved',
    'committed','allocated','partial','in_progress','completed','fulfilled','reported','acknowledged','stale','linked','used']),
  nextActor: z.enum(['buyer_human','producer','buyer','seller','receiver']).nullable(),
  nextAction: z.enum(['review_and_publish','purchase_slot','capacity_confirmation_pending',
    'compare_orders','propose_allocation','review_terms','confirm_proposal','report_fulfillment','acknowledge_fulfillment',
    'respond_to_work_order','link_material_source','record_material_use','list_material_leftover']).nullable(),
  synthetic: z.literal(true), data: z.record(z.string(), z.json()) });
export const failure = z.strictObject({ schemaVersion: z.literal(BASELINE), ok: z.literal(false),
  code: z.enum(codes), message: z.string(), retryable: z.boolean(),
  fieldIssues: z.array(z.strictObject({ field: z.string(), message: z.string() })) });
export const envelope = z.discriminatedUnion('ok', [success, failure]);
export type Success = z.infer<typeof success>;
export type Failure = z.infer<typeof failure>;
export type Envelope = z.infer<typeof envelope>;
export const event = z.strictObject({ schemaVersion: z.literal(BASELINE), eventId: id,
  actorId: id, organizationId: id, operation: z.enum(Object.keys(operations) as [Operation, ...Operation[]]),
  happenedAt: instant, requirementId: id, recordIds: z.record(z.string(), z.string()),
  revisions: z.record(z.string(), count), reason: z.string(), synthetic: z.literal(true) });
export const states = { requirement: ['draft', 'published'], slot: ['available', 'purchased', 'withdrawn', 'expired'],
  hold: ['held', 'committed', 'released'], commitment: ['purchased'],
  marketOrder: ['published','allocated'], marketProposal: ['proposed','partially_approved','committed','expired','stale'],
  marketCommitment: ['committed','in_progress','completed'], marketFulfillment: ['reported','acknowledged'] } as const;

export function normalize<O extends Operation>(operation: O, raw: unknown): Input<O> {
  const input = operations[operation].parse(raw) as Input<O>;
  if ('slots' in input) {
    input.slots.sort((a, b) => a.slotId.localeCompare(b.slotId));
    for (const s of input.slots) s.expiresAt=new Date(s.expiresAt).toISOString();
  }
  if ('lines' in input) input.lines.sort((a, b) => a.lineId.localeCompare(b.lineId));
  if ('deliveryWindow' in input && input.deliveryWindow) input.deliveryWindow={
    from: new Date(input.deliveryWindow.from).toISOString(),to: new Date(input.deliveryWindow.to).toISOString() };
  if ('availableAt' in input) input.availableAt=new Date(input.availableAt).toISOString();
  if ('deliveryBy' in input) input.deliveryBy=new Date(input.deliveryBy).toISOString();
  if ('expiresAt' in input) input.expiresAt=new Date(input.expiresAt).toISOString();
  return input;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, canonical(v)]));
  return value;
}
export function fingerprint(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex');
}
