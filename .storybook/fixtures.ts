import type { MarketOrderRow } from '../apps/web/market/components.tsx';
import type { HouseProjectDTO, MarketCommitment, MarketItem, MarketItemDetailDTO, MarketOrder, MarketWorkspace } from '../packages/contracts/src/market.ts';

// Isolated component fixtures. These never seed the database or impersonate an API.
// Active examples use one preview-session epoch; actual expiry checks keep using
// the real clock, and explicit expired stories retain their expired values.
const fixtureNow=Date.now();
export const storyInstant=(days:number)=>new Date(fixtureNow+days*86400000).toISOString();
export const storyDemand: MarketOrderRow = {
  id: 'story-demand-panels', organizationId: 'story-house-coop', organizationName: 'Synthetic House Cooperative',
  quantity: { value: 12, unit: 'each' }, openQuantity: 12,
  unitPrice: { minorUnits: 12500, currency: 'USD' }, location: 'Synthetic house site',
  availableAt: storyInstant(0), deliveryBy: storyInstant(30), recordVersion: 1,
};

export const storySupplies: MarketOrderRow[] = [
  {
    id: 'story-supply-a', organizationId: 'story-panel-works-a', organizationName: 'Synthetic Panel Works A',
    quantity: { value: 8, unit: 'each' }, openQuantity: 8,
    unitPrice: { minorUnits: 12500, currency: 'USD' }, location: 'Synthetic depot A',
    availableAt: storyInstant(1), deliveryBy: storyInstant(30), supplyMode: 'stock', recordVersion: 1,
  },
  {
    id: 'story-supply-b', organizationId: 'story-panel-works-b', organizationName: 'Synthetic Panel Works B',
    quantity: { value: 4, unit: 'each' }, openQuantity: 4,
    unitPrice: { minorUnits: 13000, currency: 'USD' }, location: 'Synthetic workshop B',
    availableAt: storyInstant(3), deliveryBy: storyInstant(30), supplyMode: 'made_to_order', recordVersion: 1,
  },
];

export const storyItems: MarketItem[] = [
  {
    itemId: 'story-panels', name: 'Illustrative wall panels',
    description: 'Synthetic counted panels for a manually linked house component. No building specification or certification.',
    specificationRevision: 1, specificationLabel: 'Synthetic panel profile v1', unit: 'each',
    specification: { profile: 'illustrative', countedUnit: 'each' }, synthetic: true,
  },
  {
    itemId: 'story-house', name: 'Illustrative whole house',
    description: 'Synthetic whole-house goal, separate from its component commitments.',
    specificationRevision: 1, specificationLabel: 'Synthetic house profile v1', unit: 'each',
    specification: { profile: 'illustrative' }, synthetic: true,
  },
];

function orderFixture(row: MarketOrderRow, side: 'buy' | 'sell'): MarketOrder {
  const total = row.quantity.value * row.unitPrice.minorUnits;
  return {
    orderId: row.id, itemId: 'story-panels', specificationRevision: 1, side,
    kind: side === 'buy' ? 'work_order' : 'material_listing',
    need: side === 'buy' ? 'Produce and deliver counted illustrative panels under the stated synthetic specification and timing.' : null,
    budget: side === 'buy' ? { minorUnits: total, currency: 'USD' } : null,
    budgetCommitted: side === 'buy' ? { minorUnits: 0, currency: 'USD' } : null,
    remainingBudget: side === 'buy' ? { minorUnits: total, currency: 'USD' } : null,
    ...(row.supplyMode ? { supplyMode: row.supplyMode } : {}), organizationId: row.organizationId,
    quantity: { value: row.quantity.value, unit: 'each' }, unitPrice: { minorUnits: row.unitPrice.minorUnits, currency: 'USD' },
    location: row.location, availableAt: row.availableAt, deliveryBy: row.deliveryBy,
    terms: 'Synthetic counted goods only. Receiver acknowledges separately. No certification or payment.',
    recordVersion: row.recordVersion, orderRevision: 1, state: 'published',
    allocatedQuantity: { value: 0, unit: 'each' }, remainingQuantity: { value: row.openQuantity, unit: 'each' },
    reportedQuantity: { value: 0, unit: 'each' }, acknowledgedQuantity: { value: 0, unit: 'each' }, synthetic: true,
  };
}

export const storyBuyOrder = orderFixture(storyDemand, 'buy');
export const storySellOrder = orderFixture(storySupplies[0]!, 'sell');
export const storyCommitment: MarketCommitment = {
  commitmentId: 'story-commitment-a', proposalId: 'story-proposal-a', proposalRevision: 1,
  buyOrderId: storyBuyOrder.orderId, sellOrderId: storySellOrder.orderId,
  buyerOrganizationId: storyBuyOrder.organizationId, sellerOrganizationId: storySellOrder.organizationId,
  quantity: { value: 8, unit: 'each' }, unitPrice: { minorUnits: 12500, currency: 'USD' },
  expiresAt: storyInstant(5), buyOrderSnapshot: storyBuyOrder, sellOrderSnapshot: storySellOrder,
  synthetic: true, recordVersion: 2, state: 'in_progress',
  reportedQuantity: { value: 5, unit: 'each' }, acknowledgedQuantity: { value: 0, unit: 'each' },
  remainingQuantity: { value: 8, unit: 'each' },
  fulfillmentReports: [{ fulfillmentId: 'story-report-a', quantity: { value: 5, unit: 'each' }, reportedAt: storyInstant(-1), acknowledged: false, recordVersion: 1 }],
  committedAt: storyInstant(-2),
};

// HOUSE-DEMO-1 screen fixtures retain separate counted component units and the
// whole-house goal. The grouping creates no computed building requirements.
export const demoItems: MarketItem[] = [
  { ...storyItems[1]!, itemId: 'HOUSE-KIT-DEMO', name: 'Illustrative house', specificationLabel: 'demo-r1' },
  { ...storyItems[0]!, itemId: 'PANEL-DEMO', name: 'Illustrative wall panels', specificationLabel: 'demo-r1' },
  { ...storyItems[0]!, itemId: 'DOOR-DEMO', name: 'Illustrative doors', specificationLabel: 'demo-r1' },
  { ...storyItems[0]!, itemId: 'ROOF-MODULE-DEMO', name: 'Illustrative roof module', specificationLabel: 'demo-r1' },
];
const demoPanelDemand: MarketOrder = {
  ...storyBuyOrder, orderId: 'story-demo-panel-demand', itemId: 'PANEL-DEMO', organizationId: 'buyer-org',
  unitPrice: { minorUnits: 10000, currency: 'USD' }, location: 'Demo site',
  need: 'Produce and deliver 12 illustrative wall panels under demo-r1 to Demo site. Partial producer responses are allowed.',
  budget: { minorUnits: 120000, currency: 'USD' }, budgetCommitted: { minorUnits: 0, currency: 'USD' }, remainingBudget: { minorUnits: 120000, currency: 'USD' },
  availableAt: storyInstant(0), deliveryBy: storyInstant(7),
};
export const demoBook: MarketItemDetailDTO = {
  item: demoItems[1]!, buyOrders: [demoPanelDemand],
  sellOrders: [
    { ...storySellOrder, orderId: 'story-demo-panel-supply-a', itemId: 'PANEL-DEMO', organizationId: 'producer-a-org', location: 'Demo yard A', unitPrice: { minorUnits: 9000, currency: 'USD' }, availableAt: storyInstant(0), deliveryBy: storyInstant(7) },
    { ...storySellOrder, orderId: 'story-demo-panel-supply-b', itemId: 'PANEL-DEMO', organizationId: 'producer-b-org', quantity: { value: 4, unit: 'each' }, remainingQuantity: { value: 4, unit: 'each' }, supplyMode: 'made_to_order', location: 'Demo yard B', unitPrice: { minorUnits: 9500, currency: 'USD' }, availableAt: storyInstant(3), deliveryBy: storyInstant(7) },
  ], nextCursor: null,
};
export const demoWorkspace: MarketWorkspace = {
  actorId: 'story-buyer-human', organizationId: 'buyer-org', role: 'buyer_human', orders: [demoPanelDemand],
  proposals: [], commitments: [], permissions: { canPost: true, canPropose: true, canConfirm: true, canReport: false, canAcknowledge: true,
    canPostWorkOrder: true, canPostMaterialListing: true, canRespondToWorkOrder: false, canLinkMaterialSource: true,
    canRecordMaterialUse: false, canLinkWorkStages: true },
  nextCursor: null, synthetic: true,
};
export const demoHouseProject: HouseProjectDTO = {
  projectId: 'story-house-project', name: 'Illustrative house',
  description: 'A synthetic whole-house goal with three manually linked component demands. Every price, quantity, specification, location and date is fabricated.',
  wholeHouseOrderId: 'story-demo-house-demand',
  wholeHouseOrder: { ...demoPanelDemand, orderId: 'story-demo-house-demand', itemId: 'HOUSE-KIT-DEMO', quantity: { value: 1, unit: 'each' }, remainingQuantity: { value: 1, unit: 'each' }, unitPrice: { minorUnits: 10000000, currency: 'USD' }, need: 'Produce and deliver one illustrative house kit under its own explicit agreement. Component work does not complete this kit.', budget: { minorUnits: 10000000, currency: 'USD' }, remainingBudget: { minorUnits: 10000000, currency: 'USD' }, deliveryBy: storyInstant(45) },
  componentOrders: [
    { ...demoPanelDemand, state: 'allocated', allocatedQuantity: { value: 12, unit: 'each' }, remainingQuantity: { value: 0, unit: 'each' }, reportedQuantity: { value: 5, unit: 'each' }, acknowledgedQuantity: { value: 5, unit: 'each' }, budgetCommitted: { minorUnits: 110000, currency: 'USD' }, remainingBudget: { minorUnits: 10000, currency: 'USD' }, recordVersion: 3 },
    { ...demoPanelDemand, orderId: 'story-demo-door-demand', itemId: 'DOOR-DEMO', quantity: { value: 2, unit: 'each' }, remainingQuantity: { value: 2, unit: 'each' }, unitPrice: { minorUnits: 20000, currency: 'USD' }, need: 'Produce and deliver two illustrative doors under demo-r1.', budget: { minorUnits: 40000, currency: 'USD' }, remainingBudget: { minorUnits: 40000, currency: 'USD' } },
    { ...demoPanelDemand, orderId: 'story-demo-roof-demand', itemId: 'ROOF-MODULE-DEMO', quantity: { value: 1, unit: 'each' }, remainingQuantity: { value: 1, unit: 'each' }, unitPrice: { minorUnits: 50000, currency: 'USD' }, need: 'Produce and deliver one illustrative roof module under demo-r1.', budget: { minorUnits: 50000, currency: 'USD' }, remainingBudget: { minorUnits: 50000, currency: 'USD' }, deliveryBy: storyInstant(10) },
  ],
  notice: 'Synthetic software illustration, not an engineered house, building requirements, cost estimate, quality certification or actual procurement. Component completion never completes the separate house commitment.',
  synthetic: true,
};
