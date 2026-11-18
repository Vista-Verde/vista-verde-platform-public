import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BASELINE, commandNames, envelope, fingerprint, marketCommandNames, marketOperations,
  capacityOfferSchema, marketOrderSchema, marketQuantityCounterSchema, materialListingSchema,
  materialInventoryLotSchema, materialSourceLinkSchema, normalize, operations, sourcingWorkspaceSchema, workOrderSchema,
  workStageLinkSchema } from '../../packages/contracts/src/index.ts';
import type { Input } from '../../packages/contracts/src/index.ts';

const createOrder = (): Input<'createMarketOrder'> => ({ idempotencyKey: 'market-order-1', itemId: 'PANEL-DEMO',
  specificationRevision: 1, side: 'sell', supplyMode: 'stock', quantity: { value: 8, unit: 'each' },
  unitPrice: { minorUnits: 9000, currency: 'USD' }, location: 'Demo yard A',
  availableAt: '2026-10-12T00:00:00Z', deliveryBy: '2026-10-19T00:00:00Z',
  terms: 'Synthetic counted goods; receiver acknowledges reported each.' });
const proposal = (): Input<'proposeMarketAllocation'> => ({ idempotencyKey: 'market-proposal-1',
  buyOrderId: 'panel-buy', sellOrderId: 'panel-sell-a', expectedBuyVersion: 1, expectedSellVersion: 1,
  quantity: { value: 8, unit: 'each' }, unitPrice: { minorUnits: 9000, currency: 'USD' },
  expiresAt: '2026-10-15T00:00:00Z' });
const workOrder = (): Input<'postWorkOrder'> => ({ idempotencyKey: 'work-order-1', itemId: 'PANEL-DEMO',
  specificationRevision: 1, need: 'Need twelve counted demo panels at Demo site.', quantity: { value: 12, unit: 'each' },
  budget: { minorUnits: 120000, currency: 'USD' }, location: 'Demo site',
  availableAt: '2026-10-12T00:00:00Z', deliveryBy: '2026-10-19T00:00:00Z', terms: 'Explicit synthetic delivery terms.' });
const materialListing = (): Input<'postMaterialListing'> => ({ idempotencyKey: 'material-listing-1', itemId: 'PANEL-DEMO',
  specificationRevision: 1, supplyMode: 'stock', quantity: { value: 8, unit: 'each' },
  unitPrice: { minorUnits: 9000, currency: 'USD' }, location: 'Demo yard A',
  availableAt: '2026-10-12T00:00:00Z', deliveryBy: '2026-10-19T00:00:00Z', terms: 'Independent synthetic material listing.' });
const response = (): Input<'respondToWorkOrder'> => ({ idempotencyKey: 'response-1', workOrderId: 'panel-buy',
  expectedRecordVersion: 1, quantity: { value: 8, unit: 'each' }, unitPrice: { minorUnits: 9000, currency: 'USD' },
  supplyMode: 'made_to_order', location: 'Demo yard A', availableAt: '2026-10-12T00:00:00Z',
  deliveryBy: '2026-10-19T00:00:00Z', terms: 'Private producer response terms.', expiresAt: '2026-10-15T00:00:00Z' });
const materialLink = (): Input<'linkMaterialSource'> => ({ idempotencyKey: 'source-link-1', workOrderId: 'panel-buy',
  materialListingId: 'material-1', quantity: { value: 2, unit: 'each' }, note: 'Candidate source only; no reservation or purchase.' });
const materialUse = (): Input<'recordMaterialUse'> => ({ idempotencyKey: 'use-1', lotId: 'received-lot-1',
  expectedRecordVersion: 1, quantity: { value: 8, unit: 'each' }, note: 'Recorded use in this manual synthetic stage.' });
const stageLink = (): Input<'linkWorkStages'> => ({ idempotencyKey: 'stage-1', upstreamWorkOrderId: 'input-work-1',
  downstreamWorkOrderId: 'output-work-1', note: 'Manual stage reference only; no planning or automatic fulfillment.' });

test('market schemas share dispatch metadata and preserve the versioned foundation envelope', () => {
  for (const [name, schema] of Object.entries(marketOperations)) assert.equal(operations[name as keyof typeof operations], schema);
  for (const name of marketCommandNames) assert.ok((commandNames as readonly string[]).includes(name));
  assert.equal(normalize('listMarketItems', {}).limit, 20);
  assert.equal(normalize('listWorkOrders', {}).limit, 20);
  assert.equal(normalize('listMaterialListings', {}).limit, 20);
  assert.equal(normalize('getSourcingWorkspace', {}).limit, 20);
  assert.deepEqual(normalize('getHouseProject', {}), { projectId: 'house-demo' });
  assert.deepEqual(normalize('getMarketItem', { itemId: 'PANEL-DEMO' }), { itemId: 'PANEL-DEMO', limit: 20 });
  for (const state of ['market','published','proposed','partially_approved','committed','in_progress','completed','reported','acknowledged','linked','used'])
    assert.equal(envelope.parse({ schemaVersion: BASELINE, ok: true, recordIds: {}, revisions: {}, state,
      nextActor: null, nextAction: null, synthetic: true, data: {} }).ok, true);
  for (const code of ['ORDER_UNAVAILABLE','PROPOSAL_EXPIRED','MATCH_INVALID','FULFILLMENT_CONFLICT','BUDGET_EXCEEDED','INVENTORY_UNAVAILABLE'])
    assert.equal(envelope.parse({ schemaVersion: BASELINE, ok: false, code, message: code,
      retryable: false, fieldIssues: [] }).ok, false);
});

test('every market command rejects client authority and unknown nested fields', () => {
  const inputs = {
    createMarketOrder: createOrder(), proposeMarketAllocation: proposal(),
    postWorkOrder: workOrder(), postMaterialListing: materialListing(), respondToWorkOrder: response(), linkMaterialSource: materialLink(),
    recordMaterialUse: materialUse(), linkWorkStages: stageLink(),
    confirmMarketProposal: { idempotencyKey: 'confirm-1', proposalId: 'proposal-1', expectedRecordVersion: 1 },
    reportMarketFulfillment: { idempotencyKey: 'report-1', commitmentId: 'commitment-1', expectedRecordVersion: 1, quantity: { value: 5, unit: 'each' } },
    acknowledgeMarketFulfillment: { idempotencyKey: 'ack-1', fulfillmentId: 'report-1', expectedRecordVersion: 1 }
  };
  for (const operation of marketCommandNames) {
    assert.doesNotThrow(() => normalize(operation, inputs[operation]));
    for (const field of ['actorId','organizationId','party','role','grantId','funded','approved','buyerApproved','sellerApproved','key',
      'kind','budgetCommitted','remainingBudget','linkedWorkOrderId'])
      assert.throws(() => normalize(operation, { ...inputs[operation], [field]: true }), `${operation} rejects ${field}`);
  }
  assert.throws(() => normalize('createMarketOrder', { ...createOrder(), quantity: { value: 8, unit: 'each', approved: true } }));
  assert.throws(() => normalize('createMarketOrder', { ...createOrder(), unitPrice: { minorUnits: 9000, currency: 'USD', funded: true } }));
});

test('work orders use explicit total budgets and responses need no client listing or party identifiers', () => {
  const input = workOrder();
  assert.equal(normalize('postWorkOrder', input).budget.minorUnits, 120000);
  for (const field of ['side','supplyMode','unitPrice','organizationId','fundingProof'])
    assert.throws(() => normalize('postWorkOrder', { ...input, [field]: 'untrusted' }));
  for (const need of ['', '  ']) assert.throws(() => normalize('postWorkOrder', { ...input, need }));
  for (const minorUnits of [-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => normalize('postWorkOrder', { ...input, budget: { minorUnits, currency: 'USD' } }));
  assert.throws(() => normalize('postWorkOrder', { ...input, budget: { minorUnits: 120000, currency: 'EUR' } }));
  assert.throws(() => normalize('postWorkOrder', { ...input, budget: { ...input.budget, funded: true } }));
  for (const field of ['itemId','specificationRevision','sellOrderId','side','buyerOrganizationId','sellerOrganizationId'])
    assert.throws(() => normalize('respondToWorkOrder', { ...response(), [field]: 'untrusted' }));
  assert.throws(() => normalize('respondToWorkOrder', { ...response(), supplyMode: undefined }));
  assert.throws(() => normalize('respondToWorkOrder', { ...response(), unitPrice: { minorUnits: Number.MAX_SAFE_INTEGER, currency: 'USD' } }));
  assert.throws(() => normalize('respondToWorkOrder', { ...response(), deliveryBy: '2026-10-11T00:00:00Z' }));
  assert.throws(() => normalize('postMaterialListing', { ...materialListing(), side: 'sell' }));
  assert.throws(() => normalize('postMaterialListing', { ...materialListing(), supplyMode: undefined }));
  assert.throws(() => normalize('postMaterialListing', { ...materialListing(), unitPrice: { minorUnits: Number.MAX_SAFE_INTEGER, currency: 'USD' } }));
  assert.throws(() => normalize('linkMaterialSource', { ...materialLink(), reserved: true }));
  assert.throws(() => normalize('linkMaterialSource', { ...materialLink(), purchased: true }));
  assert.throws(() => normalize('linkMaterialSource', { ...materialLink(), note: '  ' }));
  assert.equal(normalize('postMaterialListing', { ...materialListing(), sourceLotId: 'received-lot-1' }).sourceLotId, 'received-lot-1');
  assert.throws(() => normalize('postMaterialListing', { ...materialListing(), sourceLotId: 'received-lot-1', supplyMode: 'made_to_order' }));
  assert.equal(normalize('postMaterialListing', { ...materialListing(), supplyMode: 'made_to_order' }).supplyMode, 'made_to_order');
  assert.throws(() => normalize('postMaterialListing', { ...materialListing(), sourceLotId: 'received-lot-1', lotOwner: 'other-party' }));
  assert.throws(() => normalize('createMarketOrder', { ...createOrder(), sourceLotId: 'received-lot-1' }));
});

test('manual use and stage inputs reject false inventory or execution authority', () => {
  assert.throws(() => normalize('recordMaterialUse', { ...materialUse(), expectedRecordVersion: undefined }));
  assert.throws(() => normalize('recordMaterialUse', { ...materialUse(), quantity: { value: 0, unit: 'each' } }));
  assert.throws(() => normalize('recordMaterialUse', { ...materialUse(), quantity: { value: 8, unit: 'kg' } }));
  for (const field of ['sourceCommitmentId','sourceFulfillmentId','sourceLotId','verifiedStock','producedQuantity'])
    assert.throws(() => normalize('recordMaterialUse', { ...materialUse(), [field]: 'untrusted' }));
  assert.throws(() => normalize('linkWorkStages', { ...stageLink(), downstreamWorkOrderId: stageLink().upstreamWorkOrderId }));
  for (const field of ['automatic','execute','billOfMaterials','commitmentId','engineeringValid'])
    assert.throws(() => normalize('linkWorkStages', { ...stageLink(), [field]: true }));
});

test('synthetic lot DTOs preserve disjoint stock accounting and attributable nonbinding stage links', () => {
  const quantity = (value: number) => ({ value, unit: 'each' as const });
  const lot = { lotId: 'received-lot-1', itemId: 'PANEL-DEMO', specificationRevision: 1, organizationId: 'producer-a',
    recordVersion: 2, quantity: quantity(10), usedQuantity: quantity(8), offeredQuantity: quantity(0),
    allocatedQuantity: quantity(0), availableQuantity: quantity(2), sourceFulfillmentId: 'fulfillment-1',
    sourceLotId: 'stock-lot-1', sourceCommitmentId: 'commitment-1', createdAt: '2026-10-12T00:00:00Z', synthetic: true };
  assert.equal(materialInventoryLotSchema.parse(lot).availableQuantity.value, 2);
  const relisted = { ...lot, recordVersion: 3, offeredQuantity: quantity(2), availableQuantity: quantity(0) };
  assert.equal(materialInventoryLotSchema.parse(relisted).offeredQuantity.value, 2);
  assert.throws(() => materialInventoryLotSchema.parse({ ...relisted, availableQuantity: quantity(2) }));
  assert.throws(() => materialInventoryLotSchema.parse({ ...relisted, offeredQuantity: quantity(4) }));
  assert.throws(() => materialInventoryLotSchema.parse({ ...relisted, allocatedQuantity: quantity(2) }));
  assert.throws(() => materialInventoryLotSchema.parse({ ...lot, sourceFulfillmentId: undefined }));
  const stage = { linkId: 'stage-link-1', upstreamWorkOrderId: 'input-work-1', downstreamWorkOrderId: 'output-work-1',
    note: 'Manual reference only.', actorId: 'actor-1', organizationId: 'producer-a',
    createdAt: '2026-10-12T00:00:00Z', synthetic: true, nonbinding: true };
  assert.equal(workStageLinkSchema.parse(stage).nonbinding, true);
  assert.throws(() => workStageLinkSchema.parse({ ...stage, nonbinding: false }));
  assert.equal(sourcingWorkspaceSchema.parse({ lots: [relisted], stageLinks: [stage], nextCursor: null }).lots.length, 1);
});

test('work order and supply DTOs expose budget intent and explicit nonbinding source references', () => {
  const { idempotencyKey, ...posted } = workOrder();
  assert.equal(idempotencyKey, 'work-order-1');
  const quantityZero = { value: 0, unit: 'each' as const };
  const budgetZero = { minorUnits: 0, currency: 'USD' as const };
  const order = { ...posted, orderId: 'work-1', organizationId: 'org-buyer', kind: 'work_order', side: 'buy',
    recordVersion: 1, orderRevision: 1, state: 'published', allocatedQuantity: quantityZero,
    remainingQuantity: posted.quantity, reportedQuantity: quantityZero, acknowledgedQuantity: quantityZero,
    unitPrice: { minorUnits: 10000, currency: 'USD' }, budgetCommitted: budgetZero, remainingBudget: posted.budget, synthetic: true };
  assert.equal(workOrderSchema.parse(order).budget.minorUnits, posted.budget.minorUnits);
  assert.equal(marketOrderSchema.parse(order).kind, 'work_order');
  assert.throws(() => marketOrderSchema.parse({ ...order, remainingBudget: undefined }));
  assert.throws(() => workOrderSchema.parse({ ...order, budget: null }));
  const supply = { ...order, kind: 'material_listing', side: 'sell', supplyMode: 'stock', need: null,
    budget: null, budgetCommitted: null, remainingBudget: null };
  assert.equal(materialListingSchema.parse(supply).kind, 'material_listing');
  assert.throws(() => materialListingSchema.parse({ ...supply, budget: posted.budget }));
  assert.equal(capacityOfferSchema.parse({ ...supply, kind: 'capacity_offer', linkedWorkOrderId: 'work-1' }).linkedWorkOrderId, 'work-1');
  assert.throws(() => capacityOfferSchema.parse({ ...supply, kind: 'capacity_offer' }));
  const link = { linkId: 'link-1', workOrderId: 'work-1', materialListingId: 'material-1', quantity: { value: 2, unit: 'each' },
    note: 'Optional manually identified source.', actorId: 'actor-1', organizationId: 'org-buyer',
    createdAt: '2026-10-12T00:00:00Z', synthetic: true, nonbinding: true };
  assert.equal(materialSourceLinkSchema.parse(link).nonbinding, true);
  assert.throws(() => materialSourceLinkSchema.parse({ ...link, nonbinding: false }));
});

test('counted goods, explicit sell modes, safe unit prices and UTC timing are enforced', () => {
  for (const value of [0,-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => normalize('createMarketOrder', { ...createOrder(), quantity: { value, unit: 'each' } }));
  for (const minorUnits of [-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => normalize('createMarketOrder', { ...createOrder(), unitPrice: { minorUnits, currency: 'USD' } }));
  assert.throws(() => normalize('createMarketOrder', { ...createOrder(), quantity: { value: 8, unit: 'kg' } }));
  assert.throws(() => normalize('createMarketOrder', { ...createOrder(), unitPrice: { minorUnits: 9000, currency: 'EUR' } }));
  assert.throws(() => normalize('createMarketOrder', { ...createOrder(), supplyMode: undefined }));
  assert.throws(() => normalize('createMarketOrder', { ...createOrder(), side: 'buy' }));
  assert.doesNotThrow(() => normalize('createMarketOrder', { ...createOrder(), side: 'buy', supplyMode: undefined }));
  assert.throws(() => normalize('createMarketOrder', { ...createOrder(), availableAt: '2026-10-12T00:00:00' }));
  assert.throws(() => normalize('createMarketOrder', { ...createOrder(), availableAt: '2026-10-12T00:00:00+02:00' }));
  assert.throws(() => normalize('createMarketOrder', { ...createOrder(), deliveryBy: '2026-10-11T00:00:00Z' }));
  assert.throws(() => normalize('createMarketOrder', { ...createOrder(), terms: '  ' }));
  assert.throws(() => normalize('createMarketOrder', { ...createOrder(), unitPrice: { minorUnits: Number.MAX_SAFE_INTEGER, currency: 'USD' } }));
  assert.throws(() => normalize('proposeMarketAllocation', { ...proposal(), sellOrderId: 'panel-buy' }));
  assert.throws(() => normalize('proposeMarketAllocation', { ...proposal(), unitPrice: { minorUnits: Number.MAX_SAFE_INTEGER, currency: 'USD' } }));
  assert.deepEqual(marketQuantityCounterSchema.parse({ value: 0, unit: 'each' }), { value: 0, unit: 'each' });
  for (const cursor of ['-1','01','1.5','9223372036854775808'])
    assert.throws(() => normalize('getMarketAudit', { recordId: 'panel-buy', cursor }));
});

test('market normalization canonicalizes UTC precision and preserves immutable term text', () => {
  const a = createOrder();
  const b = { ...a, availableAt: '2026-10-12T00:00:00.000Z', deliveryBy: '2026-10-19T00:00:00.000Z' };
  assert.equal(fingerprint(normalize('createMarketOrder', a)), fingerprint(normalize('createMarketOrder', b)));
  assert.equal(fingerprint(normalize('proposeMarketAllocation', proposal())), fingerprint(normalize('proposeMarketAllocation', {
    ...proposal(), expiresAt: '2026-10-15T00:00:00.000Z' })));
  assert.equal(normalize('createMarketOrder', { ...a, terms: ' Second; first. ' }).terms, ' Second; first. ');
  assert.notEqual(fingerprint(normalize('createMarketOrder', a)), fingerprint(normalize('createMarketOrder', { ...a, terms: 'Changed explicit terms.' })));
  assert.equal(a.availableAt, '2026-10-12T00:00:00Z', 'Normalization must not mutate the original request.');
  for (const [operation, input] of [['postWorkOrder', workOrder()], ['postMaterialListing', materialListing()],
    ['respondToWorkOrder', response()]] as const)
    assert.equal(fingerprint(normalize(operation, input)), fingerprint(normalize(operation, { ...input,
      availableAt: '2026-10-12T00:00:00.000Z', deliveryBy: '2026-10-19T00:00:00.000Z' })));
});

test('print requirements are bounded, versioned and reject files, false approval, oversize envelope and impossible courier dates',()=>{
 const from='2026-10-14T00:00:00Z',requirements={version:'mock-print.v1',profile:'FDM-PETG-175-BLACK-SYNTH',mesh:{format:'binary',triangles:12,bounds:[20,20,20],units:'mm',synthetic:true},materialResponsibility:'producer',delivery:{mode:'mock_courier',zone:'B',allowance:{minorUnits:1800,currency:'USD'}}};
 const input={...workOrder(),quantity:{value:1,unit:'each'},itemId:'PRINT-JOB-SYNTH',printRequirements:requirements,availableAt:from,deliveryBy:'2026-10-23T00:00:00Z'};
 assert.doesNotThrow(()=>normalize('postWorkOrder',input));
 for(const altered of [{quantity:{value:11,unit:'each'}},{deliveryBy:'2026-10-22T00:00:00Z'},{printRequirements:{...requirements,filename:'private.stl'}},{printRequirements:{...requirements,mesh:{...requirements.mesh,bounds:[221,20,20]}}},{printRequirements:{...requirements,approved:true}},{printRequirements:{...requirements,version:'mock-print.v2'}}])assert.throws(()=>normalize('postWorkOrder',{...input,...altered}));
});
