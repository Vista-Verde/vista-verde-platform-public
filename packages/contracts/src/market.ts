import { z } from 'zod';
export { marketCommandNames } from './operation-names.ts';
import { marketCommandNames } from './operation-names.ts';

// The first market slice is counted synthetic goods. Measured quantities and
// other currencies need an explicit precision/rounding policy before widening.
const marketId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,99}$/);
const marketCount = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const marketRevision = marketCount.max(2147483647);
const marketCounter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const marketInstant = z.iso.datetime({ offset: false });
const marketCursor = z.string().regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine(value => BigInt(value) <= 9223372036854775807n, 'Cursor exceeds the audit sequence range.');
const text = (maximum: number) => z.string().min(1).max(maximum)
  .refine(value => value.trim().length > 0, 'Text must not be blank.');

export const marketQuantitySchema = z.strictObject({ value: marketCount, unit: z.literal('each') });
export const marketQuantityCounterSchema = z.strictObject({ value: marketCounter, unit: z.literal('each') });
export const marketUnitPriceSchema = z.strictObject({ minorUnits: marketCounter, currency: z.literal('USD') });
// A work order budget expresses a total intent ceiling, never escrow or funding.
export const workOrderBudgetSchema = marketUnitPriceSchema;
export const marketSupplyModeSchema = z.enum(['stock', 'made_to_order']);
export const marketOrderKindSchema = z.enum(['work_order', 'material_listing', 'capacity_offer']);
const page = { cursor: marketId.optional(), limit: marketCount.max(100).default(20) };
const commandMeta = { idempotencyKey: marketId };

// Versioned, immutable job metadata. No bytes, filename, path, address or
// client approval/identity field is accepted in this bounded print profile.
export const printRequirementsSchema = z.strictObject({
  version:z.literal('mock-print.v1'),profile:z.literal('FDM-PETG-175-BLACK-SYNTH'),
  mesh:z.strictObject({format:z.enum(['binary','ascii']),triangles:z.number().int().min(1).max(100000),
    bounds:z.tuple([z.number().finite().positive().max(1e7),z.number().finite().positive().max(1e7),z.number().finite().positive().max(1e7)]),
    units:z.enum(['mm','inch']),synthetic:z.boolean()}),
  materialResponsibility:z.enum(['producer','customer']),
  delivery:z.strictObject({mode:z.literal('mock_courier'),zone:z.enum(['A','B']),allowance:marketUnitPriceSchema})
}).superRefine((v,c)=>{
  const factor=v.mesh.units==='inch'?25.4:1;
  if(v.mesh.bounds.some((n,i)=>n*factor>[220,220,250][i]!))c.addIssue({code:'custom',path:['mesh','bounds'],message:'Bounds exceed the fictional print envelope.'});
  if(v.delivery.allowance.minorUnits<(v.delivery.zone==='A'?1000:1800))c.addIssue({code:'custom',path:['delivery','allowance'],message:'Allow the separate fictional courier amount.'});
});
export type PrintRequirements=z.infer<typeof printRequirementsSchema>;
export const PRINT_JOB_TEMPLATE='PRINT-JOB-SYNTH';
export const PRINT_MATERIAL_ITEM='PRINT-PETG-SPOOL-SYNTH';

const orderFields = {
  itemId: marketId, specificationRevision: marketRevision, side: z.enum(['buy', 'sell']),
  supplyMode: marketSupplyModeSchema.optional(), quantity: marketQuantitySchema,
  unitPrice: marketUnitPriceSchema, location: text(300), availableAt: marketInstant,
  deliveryBy: marketInstant, terms: text(2000)
};

export const marketOperations = {
  getSourcingWorkspace: z.strictObject(page),
  listWorkOrders: z.strictObject({ search: text(200).optional(), printOnly: z.boolean().optional(), ...page }),
  listMaterialListings: z.strictObject({ search: text(200).optional(), ...page }),
  listMarketItems: z.strictObject({ search: text(200).optional(), ...page }),
  getMarketItem: z.strictObject({ itemId: marketId, ...page }),
  getMarketWorkspace: z.strictObject({ ...page, workOrderId: marketId.optional() }),
  getMarketOrder: z.strictObject({ orderId: marketId }),
  getMarketProposal: z.strictObject({ proposalId: marketId }),
  getMarketCommitment: z.strictObject({ commitmentId: marketId }),
  getHouseProject: z.strictObject({ projectId: marketId.default('house-demo') }),
  getMarketAudit: z.strictObject({ recordId: marketId, cursor: marketCursor.optional(), limit: marketCount.max(100).default(20) }),
  postWorkOrder: z.strictObject({ ...commandMeta, itemId: marketId, specificationRevision: marketRevision,
    need: text(2000), quantity: marketQuantitySchema, budget: workOrderBudgetSchema,
    location: orderFields.location, availableAt: marketInstant, deliveryBy: marketInstant,
    terms: orderFields.terms, printRequirements:printRequirementsSchema.optional() }).superRefine((value, context) => {
    if(value.printRequirements){const days=(Date.parse(value.deliveryBy)-Date.parse(value.availableAt))/86400000;if(days<(value.printRequirements.delivery.zone==='A'?6:9)||days>30)context.addIssue({code:'custom',path:['deliveryBy'],message:'Deadline must allow the fictional courier arrival within 30 days.'});}
    if ('printRequirements' in value && value.printRequirements && (value.itemId!==PRINT_JOB_TEMPLATE || value.specificationRevision!==1 || value.quantity.value>10))
      context.addIssue({code:'custom',path:['printRequirements'],message:'Print intake requires the reserved version-1 template and 1–10 counted parts.'});
    if (Date.parse(value.availableAt) > Date.parse(value.deliveryBy))
      context.addIssue({ code: 'custom', path: ['deliveryBy'], message: 'Delivery deadline must be at or after availability.' });
  }),
  postMaterialListing: z.strictObject({ ...commandMeta, ...orderFields }).omit({ side: true })
    .extend({ supplyMode: marketSupplyModeSchema, sourceLotId: marketId.optional() }).superRefine((value, context) => {
      if (value.sourceLotId !== undefined && value.supplyMode !== 'stock')
        context.addIssue({ code: 'custom', path: ['supplyMode'], message: 'Source-backed lot listings require stock mode.' });
      if (Date.parse(value.availableAt) > Date.parse(value.deliveryBy))
        context.addIssue({ code: 'custom', path: ['deliveryBy'], message: 'Delivery deadline must be at or after availability.' });
      if (value.unitPrice.minorUnits > Math.floor(Number.MAX_SAFE_INTEGER / value.quantity.value))
        context.addIssue({ code: 'custom', path: ['unitPrice'], message: 'Quantity times unit price exceeds safe minor units.' });
    }),
  respondToWorkOrder: z.strictObject({ ...commandMeta, workOrderId: marketId,
    expectedRecordVersion: marketRevision, quantity: marketQuantitySchema, unitPrice: marketUnitPriceSchema,
    supplyMode: marketSupplyModeSchema, location: orderFields.location,
    availableAt: marketInstant, deliveryBy: marketInstant, terms: orderFields.terms,
    expiresAt: marketInstant, acceptCustomerMaterial:z.literal(true).optional() }).superRefine((value, context) => {
      if(value.acceptCustomerMaterial && value.terms.length>1900)context.addIssue({code:'custom',path:['terms'],message:'Customer-material response terms allow 1900 characters plus the recorded acceptance.'});
      if (Date.parse(value.availableAt) > Date.parse(value.deliveryBy))
        context.addIssue({ code: 'custom', path: ['deliveryBy'], message: 'Delivery deadline must be at or after availability.' });
      if (value.unitPrice.minorUnits > Math.floor(Number.MAX_SAFE_INTEGER / value.quantity.value))
        context.addIssue({ code: 'custom', path: ['unitPrice'], message: 'Quantity times unit price exceeds safe minor units.' });
    }),
  linkMaterialSource: z.strictObject({ ...commandMeta, workOrderId: marketId, materialListingId: marketId,
    quantity: marketQuantitySchema, note: text(1000) }),
  recordMaterialUse: z.strictObject({ ...commandMeta, lotId: marketId, expectedRecordVersion: marketRevision,
    quantity: marketQuantitySchema, note: text(1000) }),
  linkWorkStages: z.strictObject({ ...commandMeta, upstreamWorkOrderId: marketId, downstreamWorkOrderId: marketId,
    note: text(1000) }).superRefine((value, context) => {
    if (value.upstreamWorkOrderId === value.downstreamWorkOrderId)
      context.addIssue({ code: 'custom', path: ['downstreamWorkOrderId'], message: 'Linked work stages must be distinct.' });
  }),
  createMarketOrder: z.strictObject({ ...commandMeta, ...orderFields }).superRefine((value, context) => {
    if (value.side === 'sell' && value.supplyMode === undefined)
      context.addIssue({ code: 'custom', path: ['supplyMode'], message: 'Sell supply requires stock or made-to-order mode.' });
    if (value.side === 'buy' && value.supplyMode !== undefined)
      context.addIssue({ code: 'custom', path: ['supplyMode'], message: 'Supply mode applies only to sell orders.' });
    if (Date.parse(value.availableAt) > Date.parse(value.deliveryBy))
      context.addIssue({ code: 'custom', path: ['deliveryBy'], message: 'Delivery deadline must be at or after availability.' });
    if (value.unitPrice.minorUnits > Math.floor(Number.MAX_SAFE_INTEGER / value.quantity.value))
      context.addIssue({ code: 'custom', path: ['unitPrice'], message: 'Quantity times unit price exceeds safe minor units.' });
  }),
  proposeMarketAllocation: z.strictObject({ ...commandMeta, buyOrderId: marketId, sellOrderId: marketId,
    expectedBuyVersion: marketRevision, expectedSellVersion: marketRevision, quantity: marketQuantitySchema,
    unitPrice: marketUnitPriceSchema, expiresAt: marketInstant }).superRefine((value, context) => {
    if (value.buyOrderId === value.sellOrderId)
      context.addIssue({ code: 'custom', path: ['sellOrderId'], message: 'Buy and sell orders must be distinct.' });
    if (value.unitPrice.minorUnits > Math.floor(Number.MAX_SAFE_INTEGER / value.quantity.value))
      context.addIssue({ code: 'custom', path: ['unitPrice'], message: 'Quantity times unit price exceeds safe minor units.' });
  }),
  confirmMarketProposal: z.strictObject({ ...commandMeta, proposalId: marketId, expectedRecordVersion: marketRevision }),
  reportMarketFulfillment: z.strictObject({ ...commandMeta, commitmentId: marketId,
    expectedRecordVersion: marketRevision, quantity: marketQuantitySchema, note: text(1000).optional() }),
  acknowledgeMarketFulfillment: z.strictObject({ ...commandMeta, fulfillmentId: marketId, expectedRecordVersion: marketRevision })
};

export type MarketOperation = keyof typeof marketOperations;
export type MarketCommand = typeof marketCommandNames[number];
export type MarketInput<O extends MarketOperation> = z.output<(typeof marketOperations)[O]>;

export const marketItemSchema = z.strictObject({ itemId: marketId, name: text(200), description: text(2000),
  specificationRevision: marketRevision, specificationLabel: text(100), unit: z.literal('each'),
  specification: z.record(z.string(), z.json()), synthetic: z.literal(true) });

export const marketOrderSchema = z.strictObject({ ...orderFields, orderId: marketId, organizationId: marketId,
  kind: marketOrderKindSchema, need: text(2000).nullable(), budget: workOrderBudgetSchema.nullable(),
  budgetCommitted: workOrderBudgetSchema.nullable(), remainingBudget: workOrderBudgetSchema.nullable(),
  linkedWorkOrderId: marketId.optional(), sourceLotId: marketId.optional(),
  recordVersion: marketRevision, orderRevision: marketRevision, state: z.enum(['published', 'allocated']),
  allocatedQuantity: marketQuantityCounterSchema, remainingQuantity: marketQuantityCounterSchema,
  reportedQuantity: marketQuantityCounterSchema, acknowledgedQuantity: marketQuantityCounterSchema,
  synthetic: z.literal(true), printRequirements:printRequirementsSchema.optional(), attention:z.strictObject({status:z.enum(['awaiting_responses','approval_required','waiting_counterparty','authorization_needed','blocked','fulfillment','receipt','completed']),nextActor:z.enum(['you','counterparty','authorized_approver','producer','receiver','none']),approvalCount:marketCounter,exceptionCount:marketCounter}).optional() });

export const workOrderSchema = marketOrderSchema.omit({ supplyMode: true, linkedWorkOrderId: true, sourceLotId: true }).extend({
  kind: z.literal('work_order'), side: z.literal('buy'), need: text(2000), budget: workOrderBudgetSchema,
  budgetCommitted: workOrderBudgetSchema, remainingBudget: workOrderBudgetSchema });
export const materialListingSchema = marketOrderSchema.omit({ linkedWorkOrderId: true }).extend({
  kind: z.literal('material_listing'), side: z.literal('sell'), supplyMode: marketSupplyModeSchema,
  need: z.null(), budget: z.null(), budgetCommitted: z.null(), remainingBudget: z.null() });
export const capacityOfferSchema = materialListingSchema.extend({
  kind: z.literal('capacity_offer'), linkedWorkOrderId: marketId });

export const materialSourceLinkSchema = z.strictObject({ linkId: marketId, workOrderId: marketId,
  materialListingId: marketId, quantity: marketQuantitySchema, note: text(1000), actorId: marketId,
  organizationId: marketId, createdAt: marketInstant, synthetic: z.literal(true), nonbinding: z.literal(true) });

export const materialInventoryLotSchema = z.strictObject({ lotId: marketId, itemId: marketId,
  specificationRevision: marketRevision, organizationId: marketId, recordVersion: marketRevision,
  quantity: marketQuantitySchema, usedQuantity: marketQuantityCounterSchema, offeredQuantity: marketQuantityCounterSchema,
  allocatedQuantity: marketQuantityCounterSchema, availableQuantity: marketQuantityCounterSchema,
  sourceFulfillmentId: marketId.nullable(), sourceLotId: marketId.nullable(), sourceCommitmentId: marketId.nullable(),
  createdAt: marketInstant, synthetic: z.literal(true) }).superRefine((value, context) => {
    const accounted = [value.usedQuantity, value.offeredQuantity, value.allocatedQuantity, value.availableQuantity]
      .reduce((sum, quantity) => sum + BigInt(quantity.value), 0n);
    if (accounted !== BigInt(value.quantity.value))
      context.addIssue({ code: 'custom', path: ['quantity'], message: 'Lot quantity must equal its disjoint used, offered, allocated and available quantities.' });
  });
export const workStageLinkSchema = z.strictObject({ linkId: marketId, upstreamWorkOrderId: marketId,
  downstreamWorkOrderId: marketId, note: text(1000), actorId: marketId, organizationId: marketId,
  createdAt: marketInstant, synthetic: z.literal(true), nonbinding: z.literal(true) });
export const sourcingWorkspaceSchema = z.strictObject({ lots: z.array(materialInventoryLotSchema),
  stageLinks: z.array(workStageLinkSchema), nextCursor: marketId.nullable() });

const frozenProposalFields = {
  proposalId: marketId, proposalRevision: marketRevision, buyOrderId: marketId, sellOrderId: marketId,
  buyerOrganizationId: marketId, sellerOrganizationId: marketId, quantity: marketQuantitySchema,
  unitPrice: marketUnitPriceSchema, expiresAt: marketInstant,
  buyOrderSnapshot: marketOrderSchema, sellOrderSnapshot: marketOrderSchema, synthetic: z.literal(true)
};

export const marketProposalSchema = z.strictObject({ ...frozenProposalFields, recordVersion: marketRevision,
  state: z.enum(['proposed', 'partially_approved', 'committed', 'expired', 'stale']),
  buyerApproved: z.boolean(), sellerApproved: z.boolean(), commitmentId: marketId.optional() });

export const marketFulfillmentSchema = z.strictObject({ fulfillmentId: marketId,
  quantity: marketQuantitySchema, note: text(1000).optional(), reportedAt: marketInstant,
  acknowledged: z.boolean(), acknowledgedAt: marketInstant.optional(), recordVersion: marketRevision });

export const marketCommitmentSchema = z.strictObject({ ...frozenProposalFields, commitmentId: marketId,
  recordVersion: marketRevision, state: z.enum(['committed', 'in_progress', 'completed']),
  reportedQuantity: marketQuantityCounterSchema, acknowledgedQuantity: marketQuantityCounterSchema,
  remainingQuantity: marketQuantityCounterSchema, fulfillmentReports: z.array(marketFulfillmentSchema),
  committedAt: marketInstant });

export const marketPermissionsSchema = z.strictObject({ canPost: z.boolean(), canPropose: z.boolean(),
  canConfirm: z.boolean(), canReport: z.boolean(), canAcknowledge: z.boolean(),
  canPostWorkOrder: z.boolean(), canPostMaterialListing: z.boolean(), canRespondToWorkOrder: z.boolean(),
  canLinkMaterialSource: z.boolean(), canRecordMaterialUse: z.boolean(), canLinkWorkStages: z.boolean() });
export const marketWorkspaceSchema = z.strictObject({ actorId: marketId, organizationId: marketId,
  role: z.enum(['buyer_agent', 'buyer_human', 'producer', 'operator']), orders: z.array(marketOrderSchema),
  proposals: z.array(marketProposalSchema), commitments: z.array(marketCommitmentSchema),
  permissions: marketPermissionsSchema, nextCursor: marketId.nullable(), synthetic: z.literal(true) });

export const houseProjectSchema = z.strictObject({ projectId: marketId, name: text(200), description: text(2000),
  wholeHouseOrderId: marketId, wholeHouseOrder: marketOrderSchema, componentOrders: z.array(marketOrderSchema),
  notice: text(2000), synthetic: z.literal(true) });

export const marketAuditEventSchema = z.strictObject({ schemaVersion: z.literal('foundation.v0.1'), eventId: marketId,
  actorId: marketId, organizationId: marketId, operation: z.enum(Object.keys(marketOperations) as [MarketOperation, ...MarketOperation[]]),
  happenedAt: marketInstant, recordIds: z.record(z.string(), z.string()), revisions: z.record(z.string(), marketCount),
  reason: z.string(), synthetic: z.literal(true) });

export const marketItemListSchema = z.strictObject({ items: z.array(marketItemSchema), nextCursor: marketId.nullable() });
export const marketOrderListSchema = z.strictObject({ orders: z.array(marketOrderSchema), nextCursor: marketId.nullable() });
export const marketOrderDetailSchema = z.strictObject({ order: marketOrderSchema, materialSourceLinks: z.array(materialSourceLinkSchema) });
export const marketItemDetailSchema = z.strictObject({ item: marketItemSchema, buyOrders: z.array(marketOrderSchema),
  sellOrders: z.array(marketOrderSchema), nextCursor: marketId.nullable() });
export const marketAuditSchema = z.strictObject({ events: z.array(marketAuditEventSchema), nextCursor: marketCursor.nullable() });

export type MarketQuantity = z.infer<typeof marketQuantitySchema>;
export type MarketUnitPrice = z.infer<typeof marketUnitPriceSchema>;
export type WorkOrderBudget = z.infer<typeof workOrderBudgetSchema>;
export type MarketItem = z.infer<typeof marketItemSchema>;
export type MarketOrder = z.infer<typeof marketOrderSchema>;
export type WorkOrder = z.infer<typeof workOrderSchema>;
export type MaterialListing = z.infer<typeof materialListingSchema>;
export type CapacityOffer = z.infer<typeof capacityOfferSchema>;
export type MaterialSourceLink = z.infer<typeof materialSourceLinkSchema>;
export type MaterialInventoryLot = z.infer<typeof materialInventoryLotSchema>;
export type WorkStageLink = z.infer<typeof workStageLinkSchema>;
export type SourcingWorkspaceDTO = z.infer<typeof sourcingWorkspaceSchema>;
export type MarketProposal = z.infer<typeof marketProposalSchema>;
export type MarketCommitment = z.infer<typeof marketCommitmentSchema>;
export type MarketFulfillment = z.infer<typeof marketFulfillmentSchema>;
export type MarketPermissions = z.infer<typeof marketPermissionsSchema>;
export type MarketWorkspace = z.infer<typeof marketWorkspaceSchema>;
export type HouseProjectDTO = z.infer<typeof houseProjectSchema>;
export type MarketAuditEvent = z.infer<typeof marketAuditEventSchema>;
export type MarketItemListDTO = z.infer<typeof marketItemListSchema>;
export type MarketOrderListDTO = z.infer<typeof marketOrderListSchema>;
export type MarketOrderDetailDTO = z.infer<typeof marketOrderDetailSchema>;
export type MarketItemDetailDTO = z.infer<typeof marketItemDetailSchema>;
export type MarketAuditDTO = z.infer<typeof marketAuditSchema>;
export type MarketItemDTO = MarketItem;
export type MarketOrderDTO = MarketOrder;
export type WorkOrderDTO = WorkOrder;
export type MaterialListingDTO = MaterialListing;
export type CapacityOfferDTO = CapacityOffer;
export type MaterialSourceLinkDTO = MaterialSourceLink;
export type MaterialInventoryLotDTO = MaterialInventoryLot;
export type WorkStageLinkDTO = WorkStageLink;
export type MarketProposalDTO = MarketProposal;
export type MarketCommitmentDTO = MarketCommitment;
export type MarketFulfillmentDTO = MarketFulfillment;
export type MarketWorkspaceDTO = MarketWorkspace;
