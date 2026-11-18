// Browser-safe operation metadata: no validation or server-only dependencies.
export const foundationCommandNames = ['createRequirementDraft', 'publishRequirement', 'purchaseSlot',
  'withdrawUnpurchasedSlot', 'processExpiredSlot'] as const;
export const marketCommandNames = ['createMarketOrder', 'proposeMarketAllocation', 'confirmMarketProposal',
  'reportMarketFulfillment', 'acknowledgeMarketFulfillment', 'postWorkOrder', 'postMaterialListing',
  'respondToWorkOrder', 'linkMaterialSource', 'recordMaterialUse', 'linkWorkStages'] as const;
export const commandNames = [...foundationCommandNames, ...marketCommandNames] as const;
