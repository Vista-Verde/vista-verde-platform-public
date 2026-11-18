/** Synthetic monthly expected values, USD; never a payment or accounting ledger. */
export type Payer = 'platform' | 'seller' | 'buyer';
export interface Scenario {
  name: string;
  orders: number; aov: number; acceptanceRate: number; fillRate: number; paidShare: number; completionShare: number; leakage: number;
  feeBasis: 'paid' | 'completed';
  takeRate: number; feeFixed: number; feeCap: number;
  commissionPayer: 'seller' | 'buyer'; processingPayer: Payer;
  cardShare: number; cardRate: number; cardFixed: number;
  achRate: number; achFixed: number; achCap: number;
  suppliers: number; rounds: number; chargeMode: 'combined' | 'perSupplier';
  sellers: number; payoutsPerSeller: number;
  activeAccountFee: number; payoutRate: number; payoutFixed: number; routingRate: number; providerMonthly: number;
  verificationShare: number; verificationFee: number;
  refundRate: number; cardDisputeRate: number; contestShare: number; winRate: number;
  disputeFee: number; counterFee: number; achReturnRate: number; achReturnFee: number;
  recoveryRate: number; fraudRate: number;
  supportPerOrder: number; supportPerRefund: number; supportPerDispute: number;
  ordersPerBuyer: number; newBuyerShare: number; acquisitionCost: number; fixedCost: number;
  cardDays: number; achDays: number; payoutLagDays: number; reserveRate: number; reserveDays: number;
}

export const baseScenario: Scenario = {
  name: 'Base', orders: 200, aov: 1000, acceptanceRate: .8, fillRate: .8, paidShare: .75, completionShare: .8, leakage: .2, feeBasis: 'completed',
  takeRate: .03, feeFixed: 0, feeCap: 0, commissionPayer: 'seller', processingPayer: 'platform',
  cardShare: .4, cardRate: .029, cardFixed: .3, achRate: .008, achFixed: 0, achCap: 5,
  suppliers: 2, rounds: 1, chargeMode: 'combined', sellers: 20, payoutsPerSeller: 4,
  activeAccountFee: 2, payoutRate: .0025, payoutFixed: .25, routingRate: .0025, providerMonthly: 0,
  verificationShare: .1, verificationFee: 1.5,
  refundRate: .03, cardDisputeRate: .005, contestShare: .5, winRate: .4,
  disputeFee: 15, counterFee: 15, achReturnRate: .005, achReturnFee: 15,
  recoveryRate: .5, fraudRate: .001,
  supportPerOrder: 3, supportPerRefund: 5, supportPerDispute: 20,
  ordersPerBuyer: 1.5, newBuyerShare: .4, acquisitionCost: 25, fixedCost: 3000,
  cardDays: 2, achDays: 4, payoutLagDays: 7, reserveRate: .05, reserveDays: 60,
};
export const scenarios: Record<string, Scenario> = {
  Conservative: { ...baseScenario, name: 'Conservative', orders: 60, aov: 250, acceptanceRate: .5, fillRate: .6, paidShare: .6, completionShare: .7, leakage: .4, takeRate: .02,
    cardShare: .8, refundRate: .08, cardDisputeRate: .01, achReturnRate: .01, recoveryRate: .2,
    supportPerOrder: 5, ordersPerBuyer: 1, newBuyerShare: .7, acquisitionCost: 50 },
  Base: baseScenario,
  Upside: { ...baseScenario, name: 'Upside', orders: 600, aov: 3000, acceptanceRate: .9, fillRate: .9, paidShare: 1, completionShare: .95, leakage: .1, takeRate: .04,
    cardShare: .2, refundRate: .01, cardDisputeRate: .002, achReturnRate: .002, recoveryRate: .75,
    supportPerOrder: 2, sellers: 40, ordersPerBuyer: 2, newBuyerShare: .25, acquisitionCost: 10 },
};

export const percentKeys = new Set<keyof Scenario>(['acceptanceRate','fillRate','paidShare','completionShare','leakage','takeRate','cardShare','cardRate','achRate','payoutRate',
  'routingRate','verificationShare','refundRate','cardDisputeRate','contestShare','winRate','achReturnRate','recoveryRate',
  'fraudRate','newBuyerShare','reserveRate']);
const integerKeys = new Set<keyof Scenario>(['orders','suppliers','rounds','sellers','payoutsPerSeller']);

export function validateScenario(s: Scenario): string[] {
  const errors: string[] = [];
  for (const [key, value] of Object.entries(s)) {
    if (typeof value !== 'number') continue;
    if (!Number.isFinite(value) || value < 0) errors.push(`${key}: enter a finite nonnegative value`);
    if (value > 1_000_000_000) errors.push(`${key}: exceeds exploration limit`);
    if (percentKeys.has(key as keyof Scenario) && value > 1) errors.push(`${key}: cannot exceed 100%`);
    if (integerKeys.has(key as keyof Scenario) && !Number.isInteger(value)) errors.push(`${key}: use a whole number`);
  }
  if (s.aov <= 0 || s.ordersPerBuyer < 1 || s.suppliers < 1 || s.rounds < 1 || s.sellers < 1 || s.payoutsPerSeller < 1)
    errors.push('AOV must be positive; frequency, suppliers, rounds, sellers and payouts must be at least one');
  if (s.cardRate >= 1 || s.achRate >= 1) errors.push('Processing rates must be below 100%');
  if (s.orders > 10_000_000 || s.aov > 1_000_000) errors.push('Exploration limit: 10 million orders and $1 million AOV');
  if (s.commissionPayer !== 'seller' && s.commissionPayer !== 'buyer') errors.push('Invalid commission payer');
  if (!['platform','seller','buyer'].includes(s.processingPayer)) errors.push('Invalid processing payer');
  if (!['combined','perSupplier'].includes(s.chargeMode)) errors.push('Invalid charge mode');
  if (!['paid','completed'].includes(s.feeBasis)) errors.push('Invalid fee basis');
  if (s.feeCap > 0 && s.feeCap < s.feeFixed) errors.push('Fee cap must cover the fixed platform fee');
  return errors;
}

/** Cap applies per successful charge. Zero cap means uncapped. */
export function processingFee(amount: number, rate: number, fixed: number, cap = 0): number {
  if (amount <= 0) return 0;
  return cap > 0 ? Math.min(amount * rate + fixed, cap) : amount * rate + fixed;
}
/** Exact gross-up of a buyer reimbursement, including processing on the reimbursement itself. */
export function buyerCharge(base: number, rate: number, fixed: number, cap = 0): number {
  if (base <= 0) return 0;
  const uncapped = (base + fixed) / (1 - rate);
  return cap > 0 && processingFee(uncapped, rate, fixed) >= cap ? base + cap : uncapped;
}

export function evaluate(s: Scenario) {
  const errors = validateScenario(s);
  if (errors.length) throw new Error(errors.join('; '));
  const contractedOrders = s.orders * s.acceptanceRate;
  const paidOrders = s.fillRate > 0 && s.paidShare > 0 ? contractedOrders * (1 - s.leakage) : 0;
  // Input dollars are rounded to cents; resulting expectations may contain fractional cents.
  const contractedAov = Math.round(s.aov * 100) / 100 * s.fillRate;
  const fundedAov = contractedAov * s.paidShare;
  const postedBudget = s.orders * s.aov;
  const contractedValue = contractedOrders * contractedAov;
  const gmv = paidOrders * fundedAov;
  const chargesPerOrder = s.rounds * (s.chargeMode === 'perSupplier' ? s.suppliers : 1);
  const charges = paidOrders * chargesPerOrder;
  const allocations = paidOrders * s.suppliers;
  const feeBasisPerOrder = fundedAov * (s.feeBasis === 'completed' ? s.completionShare : 1);
  const feePerOrder = feeBasisPerOrder > 0 ? Math.min(feeBasisPerOrder, s.feeCap > 0
    ? Math.min(feeBasisPerOrder * s.takeRate + s.feeFixed, s.feeCap) : feeBasisPerOrder * s.takeRate + s.feeFixed) : 0;
  const grossRevenue = paidOrders * feePerOrder;
  const commissionPerCharge = feePerOrder / chargesPerOrder;
  const merchandisePerCharge = fundedAov / chargesPerOrder;
  const baseCharge = merchandisePerCharge + (s.commissionPayer === 'buyer' ? commissionPerCharge : 0);
  const cardAmount = s.processingPayer === 'buyer' ? buyerCharge(baseCharge, s.cardRate, s.cardFixed) : baseCharge;
  const achAmount = s.processingPayer === 'buyer' ? buyerCharge(baseCharge, s.achRate, s.achFixed, s.achCap) : baseCharge;
  const cardFee = processingFee(cardAmount, s.cardRate, s.cardFixed);
  const achFee = processingFee(achAmount, s.achRate, s.achFixed, s.achCap);
  const weightedFee = s.cardShare * cardFee + (1 - s.cardShare) * achFee;
  const processing = charges * weightedFee;
  const sellerAvailable = Math.max(0, merchandisePerCharge - (s.commissionPayer === 'seller' ? commissionPerCharge : 0));
  const recoverableCardFee = s.processingPayer === 'seller' ? Math.min(cardFee, sellerAvailable) : cardFee;
  const recoverableAchFee = s.processingPayer === 'seller' ? Math.min(achFee, sellerAvailable) : achFee;
  const sellerShortfall = s.processingPayer === 'seller' ? charges * (
    s.cardShare * (cardFee - recoverableCardFee) + (1 - s.cardShare) * (achFee - recoverableAchFee)) : 0;
  const buyerCollected = charges * (s.cardShare * cardAmount + (1 - s.cardShare) * achAmount);
  // Refunds and disputes are disjoint; dispute rates apply to nonrefunded payments.
  const retainedAfterRefund = 1 - s.refundRate;
  const cardLossRate = s.cardDisputeRate * (1 - s.contestShare * s.winRate);
  const lossRate = s.cardShare * cardLossRate + (1 - s.cardShare) * s.achReturnRate;
  const retained = retainedAfterRefund * (1 - lossRate);
  const refunds = gmv * s.refundRate;
  const disputedMerchandise = gmv * retainedAfterRefund * lossRate;
  const netGMV = gmv - refunds - disputedMerchandise;
  const completedValue = netGMV * s.completionShare;
  const revenue = grossRevenue * retained;
  const processingRecovery = s.processingPayer === 'platform' ? 0 : charges * retainedAfterRefund * (
    s.cardShare * recoverableCardFee * (1 - cardLossRate) + (1 - s.cardShare) * recoverableAchFee * (1 - s.achReturnRate));
  const processingBurden = processing - processingRecovery;
  const refundProcessing = processing * s.refundRate; // Informational subset of processing, never added twice.
  const cardDisputes = charges * s.cardShare * retainedAfterRefund * s.cardDisputeRate;
  const achReturns = charges * (1 - s.cardShare) * retainedAfterRefund * s.achReturnRate;
  const disputeCost = cardDisputes * (s.disputeFee + s.contestShare * s.counterFee * (1 - s.winRate)) + achReturns * s.achReturnFee;
  const sellerPrincipal = (fee: number) => Math.max(0, merchandisePerCharge
    - (s.commissionPayer === 'seller' ? commissionPerCharge : 0) - (s.processingPayer === 'seller' ? fee : 0));
  const principalAtRisk = charges * retainedAfterRefund * (
    s.cardShare * sellerPrincipal(cardFee) * cardLossRate + (1 - s.cardShare) * sellerPrincipal(achFee) * s.achReturnRate);
  const principalLoss = principalAtRisk * (1 - s.recoveryRate);
  const fraudLoss = netGMV * s.fraudRate * (1 - s.recoveryRate); // Additional loss, outside disputes.
  // Payout estimate assumes refunds precede payout and chargebacks follow payout.
  const payoutVolume = Math.max(0, gmv * retainedAfterRefund
    - (s.commissionPayer === 'seller' ? grossRevenue * retainedAfterRefund : 0)
    - (s.processingPayer === 'seller' ? (processing - sellerShortfall) * retainedAfterRefund : 0));
  const activeSellers = payoutVolume > 0 ? Math.min(s.sellers, allocations) : 0;
  const payouts = payoutVolume > 0 ? Math.min(activeSellers * s.payoutsPerSeller, allocations * s.rounds) : 0;
  const accountCost = activeSellers * s.activeAccountFee;
  const payoutCost = payoutVolume * s.payoutRate + payouts * s.payoutFixed;
  const routingCost = payoutVolume * s.routingRate;
  const verificationCost = paidOrders * (1 - s.cardShare) * s.verificationShare * s.verificationFee;
  const providerCost = accountCost + payoutCost + routingCost + verificationCost + s.providerMonthly;
  const supportCost = paidOrders * s.supportPerOrder + paidOrders * s.refundRate * s.supportPerRefund
    + (cardDisputes + achReturns) * s.supportPerDispute;
  const newBuyers = paidOrders / s.ordersPerBuyer * s.newBuyerShare;
  const acquisition = newBuyers * s.acquisitionCost;
  const contribution = revenue - processingBurden - providerCost - disputeCost - principalLoss - fraudLoss - supportCost - acquisition;
  const operating = contribution - s.fixedCost;
  const processorOnly = revenue - processingBurden;
  const cash = {
    pendingSettlement: charges / 30 * (s.cardShare * cardAmount * s.cardDays + (1 - s.cardShare) * achAmount * s.achDays),
    supplierQueue: payoutVolume / 30 * s.payoutLagDays,
    reserveBuffer: gmv / 30 * s.reserveDays * s.reserveRate,
    disputedGross: charges * retainedAfterRefund * (s.cardShare * cardAmount * s.cardDisputeRate + (1 - s.cardShare) * achAmount * s.achReturnRate),
  };
  return { postedBudget, contractedOrders, contractedValue, completedValue, feeBasisPerOrder, paidOrders, fundedAov, gmv, netGMV, charges, allocations, feePerOrder, grossRevenue, refunds,
    disputedMerchandise, revenue, buyerCollected, processing, processingRecovery, processingBurden, refundProcessing, sellerShortfall,
    cardDisputes, achReturns, disputeCost, principalAtRisk, principalLoss, fraudLoss, payoutVolume, activeSellers, payouts,
    accountCost, payoutCost, routingCost, verificationCost, providerCost, supportCost, newBuyers, acquisition,
    contribution, operating, processorOnly, cash };
}
export type Economics = ReturnType<typeof evaluate>;
export type BreakEven = { status: 'reachable'; orders: number; gmv: number; marginalContribution: number }
  | { status: 'negative' | 'noFunding' | 'beyondLimit'; marginalContribution: number };

/** Fixed cohort, AOV, mix, fee rules and operating assumptions. Not a scale forecast. */
export function breakEven(s: Scenario): BreakEven {
  if (!s.acceptanceRate || !s.fillRate || !s.paidShare || s.leakage === 1) return { status: 'noFunding', marginalContribution: 0 };
  const at = (orders: number) => evaluate({ ...s, orders });
  const marginalContribution = (at(10_000_000).operating - at(9_000_000).operating) / 1_000_000;
  if (marginalContribution <= 0) return { status: 'negative', marginalContribution };
  if (at(10_000_000).operating < 0) return { status: 'beyondLimit', marginalContribution };
  let low = 0, high = 10_000_000;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (at(mid).operating >= 0) high = mid; else low = mid + 1;
  }
  return { status: 'reachable', orders: low, gmv: at(low).gmv, marginalContribution };
}

export function sensitivity(s: Scenario, key: 'takeRate' | 'aov' | 'orders', values: number[]) {
  return values.map(value => ({ value, operating: evaluate({ ...s, [key]: value }).operating }));
}

export interface NetworkTrade { id: string; label: string; price: number; inputCost: number; ownCost: number; leakage: number; buyerTradeId?: string; }
export type NetworkFeePolicy = 'eachTrade' | 'finalBoundary';
/** One synthetic completed batch; prices are distinct payments, never recursively marked up. */
export function networkEconomics(s: Scenario, trades: NetworkTrade[], finalDemandId: string, policy: NetworkFeePolicy) {
  if (!['eachTrade','finalBoundary'].includes(policy)) throw new Error('Invalid network fee policy');
  if (!trades.length || new Set(trades.map(t=>t.id)).size !== trades.length) throw new Error('Distinct trade IDs required');
  const finalTrade = trades.find(t=>t.id===finalDemandId);
  if (!finalTrade) throw new Error('Choose an explicit final-demand measurement boundary');
  const rawRows = trades.map(t=>{
    if (!t.id || !t.label || [t.price,t.inputCost,t.ownCost,t.leakage].some(n=>!Number.isFinite(n) || n<0 || n>1_000_000)
      || t.price===0 || t.leakage>1) throw new Error('Invalid network trade');
    const billable = policy==='eachTrade' || t.id===finalDemandId;
    const r=evaluate({...s,orders:1,aov:t.price,acceptanceRate:1,fillRate:1,paidShare:1,completionShare:1,feeBasis:'paid',leakage:t.leakage,
      takeRate:billable?s.takeRate:0,feeFixed:billable?s.feeFixed:0,suppliers:1,rounds:1,chargeMode:'combined',sellers:1,payoutsPerSeller:1,
      refundRate:0,cardDisputeRate:0,achReturnRate:0,fraudRate:0,activeAccountFee:0,verificationShare:0,providerMonthly:0,
      supportPerOrder:0,supportPerRefund:0,supportPerDispute:0,acquisitionCost:0,fixedCost:0});
    const producerFee = s.commissionPayer==='seller'?r.revenue:0;
    const producerProcessing = s.processingPayer==='seller'?r.processingRecovery:0;
    return {...t,billable,platformFee:r.revenue,producerFee,producerProcessing,
      producerMargin:t.price-t.inputCost-t.ownCost-producerFee-producerProcessing,
      buyerFee:s.commissionPayer==='buyer'?r.revenue:0,buyerProcessing:s.processingPayer==='buyer'?r.processingRecovery:0,
      platformPaymentContribution:r.contribution,paidOnPlatform:r.gmv,buyerCollected:r.buyerCollected};
  });
  const rows=rawRows.map(row=>{
    const bought=rawRows.filter(t=>t.buyerTradeId===row.id);
    const upstreamBuyerFee=bought.reduce((v,t)=>v+t.buyerFee,0);
    const upstreamBuyerProcessing=bought.reduce((v,t)=>v+t.buyerProcessing,0);
    return {...row,producerFee:row.producerFee+upstreamBuyerFee,producerProcessing:row.producerProcessing+upstreamBuyerProcessing,
      producerMargin:row.producerMargin-upstreamBuyerFee-upstreamBuyerProcessing};
  });
  return {rows,grossTradeVolume:trades.reduce((v,t)=>v+t.price,0),paidOnPlatform:rows.reduce((v,r)=>v+r.paidOnPlatform,0),
    finalCustomerValue:finalTrade.price,platformFee:rows.reduce((v,r)=>v+r.platformFee,0),
    producerFees:rows.reduce((v,r)=>v+r.producerFee,0),producerMargin:rows.reduce((v,r)=>v+r.producerMargin,0),
    externalBuyerAdditions:rawRows.filter(t=>!trades.some(other=>other.id===t.buyerTradeId)).reduce((v,t)=>v+t.buyerFee+t.buyerProcessing,0),
    platformPaymentContribution:rows.reduce((v,r)=>v+r.platformPaymentContribution,0)};
}
