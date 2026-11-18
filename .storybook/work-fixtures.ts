import type { MarketItem, MarketOrder, MarketProposal, MaterialInventoryLot, MaterialSourceLink, SourcingWorkspaceDTO, WorkStageLink } from '../packages/contracts/src/market.ts';
import { demoBook, demoHouseProject, demoItems, demoWorkspace, storySellOrder, storyInstant } from './fixtures.ts';

// CSF-only data. No service calls, seed records, balance claims or automatic links.
export const workOrderItems = demoItems;
export const workOrders: MarketOrder[] = [
  demoBook.buyOrders[0]!,
  ...demoHouseProject.componentOrders.slice(1),
  demoHouseProject.wholeHouseOrder,
];
export const panelWorkOrder = workOrders[0]!;
export const producerWorkspace = {
  ...demoWorkspace, actorId: 'story-producer-human', organizationId: 'producer-a-org', role: 'producer' as const,
  orders: [], permissions: { canPost: true, canPropose: true, canConfirm: true, canReport: true, canAcknowledge: false,
    canPostWorkOrder: true, canPostMaterialListing: true, canRespondToWorkOrder: true, canLinkMaterialSource: true,
    canRecordMaterialUse: true, canLinkWorkStages: true },
};

export const supplyItems: MarketItem[] = [
  ...demoItems,
  { ...demoItems[1]!, itemId: 'RAW-BLOCK-DEMO', name: 'Illustrative raw blocks', specificationLabel: 'raw-demo-r1', description: 'Synthetic reusable raw inputs. No manufacturing recipe is implied.', specification: { profile: 'illustrative raw input', countUnit: 'each' } },
  { ...demoItems[1]!, itemId: 'INTERMEDIATE-DEMO', name: 'Illustrative intermediate blanks', specificationLabel: 'intermediate-demo-r1', description: 'Synthetic intermediate outputs independently offered for sourcing.', specification: { profile: 'illustrative intermediate output', countUnit: 'each' } },
];
export const independentSupplies: MarketOrder[] = [
  { ...storySellOrder, orderId: 'story-raw-supply', itemId: 'RAW-BLOCK-DEMO', organizationId: 'other-buyer-org', quantity: { value: 10, unit: 'each' }, remainingQuantity: { value: 10, unit: 'each' }, unitPrice: { minorUnits: 2000, currency: 'USD' }, location: 'Synthetic raw-material depot', terms: 'Synthetic reusable counted blocks. A source link is only a candidate; purchasing requires a separate explicit agreement.' },
  { ...storySellOrder, orderId: 'story-intermediate-supply', itemId: 'INTERMEDIATE-DEMO', organizationId: 'producer-b-org', quantity: { value: 6, unit: 'each' }, remainingQuantity: { value: 6, unit: 'each' }, unitPrice: { minorUnits: 4000, currency: 'USD' }, location: 'Synthetic intermediate workshop', terms: 'Synthetic intermediate output offered independently. No linked work order is required to list or source it.' },
  { ...storySellOrder, orderId: 'story-component-supply', itemId: 'PANEL-DEMO', organizationId: 'producer-a-org', quantity: { value: 2, unit: 'each' }, remainingQuantity: { value: 2, unit: 'each' }, unitPrice: { minorUnits: 9000, currency: 'USD' }, location: 'Synthetic component yard', terms: 'Synthetic finished component output offered separately from private producer responses.' },
];

export const materialSourceLinks: MaterialSourceLink[] = [{
  linkId: 'story-source-link', workOrderId: panelWorkOrder.orderId, materialListingId: independentSupplies[0]!.orderId,
  quantity: { value: 8, unit: 'each' }, note: 'Manually noted candidate raw inputs. No purchase, reservation, BOM conversion or proof of availability.',
  actorId: 'story-buyer-agent', organizationId: 'buyer-org', createdAt: '2026-10-12T09:00:00.000Z', synthetic: true, nonbinding: true,
}];

export const privateCapacityOffer: MarketOrder = {
  ...storySellOrder, kind: 'capacity_offer', linkedWorkOrderId: panelWorkOrder.orderId, orderId: 'story-private-response-offer',
  itemId: panelWorkOrder.itemId, organizationId: 'producer-a-org', supplyMode: 'made_to_order',
  quantity: { value: 8, unit: 'each' }, remainingQuantity: { value: 8, unit: 'each' },
  unitPrice: { minorUnits: 9000, currency: 'USD' }, location: 'Synthetic producer A',
  terms: 'Private synthetic response to the stated need. No public material listing was created. Explicit consent is still required.',
};
export const producerResponse: MarketProposal = {
  proposalId: 'story-producer-response', proposalRevision: 1, buyOrderId: panelWorkOrder.orderId, sellOrderId: privateCapacityOffer.orderId,
  buyerOrganizationId: panelWorkOrder.organizationId, sellerOrganizationId: privateCapacityOffer.organizationId,
  quantity: { value: 8, unit: 'each' }, unitPrice: { minorUnits: 9000, currency: 'USD' }, expiresAt: storyInstant(2),
  buyOrderSnapshot: panelWorkOrder, sellOrderSnapshot: privateCapacityOffer, synthetic: true,
  recordVersion: 1, state: 'proposed', buyerApproved: false, sellerApproved: false,
};

export const intermediateWorkOrder: MarketOrder = {
  ...panelWorkOrder, orderId: 'story-intermediate-work', itemId: 'INTERMEDIATE-DEMO', organizationId: 'producer-a-org',
  need: 'Produce six illustrative intermediate blanks for separately scoped component work. No automated recipe or conversion is implied.',
  quantity: { value: 6, unit: 'each' }, remainingQuantity: { value: 6, unit: 'each' }, unitPrice: { minorUnits: 4000, currency: 'USD' },
  budget: { minorUnits: 24000, currency: 'USD' }, budgetCommitted: { minorUnits: 0, currency: 'USD' }, remainingBudget: { minorUnits: 24000, currency: 'USD' },
};
export const stageWorkOrders = [intermediateWorkOrder, panelWorkOrder, demoHouseProject.wholeHouseOrder];
export const manualStageLinks: WorkStageLink[] = [
  { linkId: 'story-intermediate-to-component', upstreamWorkOrderId: intermediateWorkOrder.orderId, downstreamWorkOrderId: panelWorkOrder.orderId,
    note: 'Manual navigation reference from intermediate work to panel work. Goods and agreements remain independently scoped.', actorId: 'story-producer-human', organizationId: 'producer-a-org', createdAt: '2026-10-12T09:00:00.000Z', synthetic: true, nonbinding: true },
  { linkId: 'story-component-to-house', upstreamWorkOrderId: panelWorkOrder.orderId, downstreamWorkOrderId: demoHouseProject.wholeHouseOrder.orderId,
    note: 'Manual component-to-final-work reference. Panel completion does not automatically complete the whole house.', actorId: 'story-producer-human', organizationId: 'producer-a-org', createdAt: '2026-10-12T09:00:00.000Z', synthetic: true, nonbinding: true },
];
export const receivedRawLot: MaterialInventoryLot = {
  lotId: 'story-received-raw-lot', itemId: 'RAW-BLOCK-DEMO', specificationRevision: 1, organizationId: 'producer-a-org', recordVersion: 1,
  quantity: { value: 10, unit: 'each' }, usedQuantity: { value: 0, unit: 'each' }, offeredQuantity: { value: 0, unit: 'each' },
  allocatedQuantity: { value: 0, unit: 'each' }, availableQuantity: { value: 10, unit: 'each' },
  sourceFulfillmentId: 'story-input-receipt', sourceLotId: 'story-supplier-raw-lot', sourceCommitmentId: 'story-input-commitment',
  createdAt: '2026-10-12T09:00:00.000Z', synthetic: true,
};
export const usedRawLot: MaterialInventoryLot = { ...receivedRawLot, recordVersion: 2, usedQuantity: { value: 8, unit: 'each' }, availableQuantity: { value: 2, unit: 'each' } };
export const relistedRawLot: MaterialInventoryLot = { ...usedRawLot, recordVersion: 3, offeredQuantity: { value: 2, unit: 'each' }, availableQuantity: { value: 0, unit: 'each' } };
export const sourcingFixture: SourcingWorkspaceDTO = { lots: [usedRawLot], stageLinks: manualStageLinks, nextCursor: null };
export const leftoverListing: MarketOrder = {
  ...independentSupplies[0]!, orderId: 'story-leftover-supply', organizationId: 'producer-a-org', sourceLotId: receivedRawLot.lotId,
  quantity: { value: 2, unit: 'each' }, remainingQuantity: { value: 2, unit: 'each' },
  terms: 'Synthetic reusable remainder offered from its tracked source lot. Used or already offered quantity is excluded. A future purchase still needs explicit agreement.',
};
