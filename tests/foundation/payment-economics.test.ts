import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseScenario, breakEven, buyerCharge, evaluate, networkEconomics, processingFee, validateScenario } from '../../apps/payment-economics/model.ts';
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual-expected)<1e-7, `${actual} != ${expected}`);
const clean = { ...baseScenario, orders: 100, aov: 100, acceptanceRate: 1, fillRate: 1, paidShare: 1, completionShare: 1, leakage: 0, cardShare: 1,
  refundRate: 0, cardDisputeRate: 0, achReturnRate: 0, fraudRate: 0, verificationShare: 0,
  activeAccountFee: 0, payoutRate: 0, payoutFixed: 0, routingRate: 0, providerMonthly: 0,
  supportPerOrder: 0, supportPerRefund: 0, supportPerDispute: 0, acquisitionCost: 0, fixedCost: 0 };

test('zero volume and zero funding produce no variable costs or fabricated break-even',()=>{
  for(const s of [{...baseScenario,orders:0},{...baseScenario,fillRate:0},{...baseScenario,acceptanceRate:0},{...baseScenario,paidShare:0},{...baseScenario,leakage:1}]) {
    const r=evaluate(s);
    for(const key of ['gmv','revenue','charges','processing','payoutVolume','payouts','accountCost','acquisition','supportCost'] as const) near(r[key],0);
    near(r.operating,-s.fixedCost);
    for(const n of Object.values(r.cash)) near(n,0);
  }
  assert.equal(breakEven({...baseScenario,fillRate:0}).status,'noFunding');
});
test('posted budgets, contracted goods, paid value, completion and earned fee are distinct',()=>{
  const s={...clean,orders:100,aov:1000,acceptanceRate:.5,fillRate:.6,paidShare:.5,completionShare:.75,leakage:.2};
  const r=evaluate(s); near(r.postedBudget,100000); near(r.contractedValue,30000); near(r.gmv,12000); near(r.completedValue,9000); near(r.revenue,270);
  near(evaluate({...s,feeBasis:'paid'}).revenue,360);
  near(evaluate({...s,completionShare:0}).revenue,0);
  near(evaluate({...s,completionShare:0}).gmv,12000);
});
test('GMV is goods only; fee counted once; processing costs absorbed only once',()=>{
  const r=evaluate(clean); near(r.gmv,10000); near(r.revenue,300); near(r.processing,320); near(r.operating,-20);
  near(r.refundProcessing,0); near(r.processingRecovery,0);
});
test('buyer additions are outside GMV and reimbursements gross up their own processing',()=>{
  const s={...clean,commissionPayer:'buyer' as const,processingPayer:'buyer' as const};
  const r=evaluate(s); near(r.gmv,10000); near(r.revenue,300); near(r.processingBurden,0); near(r.operating,300);
  near(r.buyerCollected,100*buyerCharge(103,.029,.3));
  near(r.processing,r.buyerCollected-10300);
});
test('ACH cap is applied per charge, including high-value buyer gross-up',()=>{
  near(processingFee(100000,.008,0,5),5); near(buyerCharge(100000,.008,0,5),100005);
  const r=evaluate({...clean,orders:1,aov:100000,cardShare:0}); near(r.processing,5);
  const split=evaluate({...clean,orders:1,aov:100000,cardShare:0,chargeMode:'perSupplier',suppliers:4,rounds:2});
  near(split.processing,40); near(split.gmv,100000); near(split.revenue,3000); near(split.charges,8);
});
test('partial fills and supplier splits do not multiply GMV or platform fees',()=>{
  const combined=evaluate({...clean,orders:1,aov:1000,fillRate:.6,suppliers:3});
  const split=evaluate({...clean,orders:1,aov:1000,fillRate:.6,suppliers:3,chargeMode:'perSupplier'});
  near(combined.gmv,600); near(split.gmv,600); near(split.revenue,18); near(combined.revenue,18);
  near(split.processing-combined.processing,.6); near(split.allocations,3);
});
test('platform percentage plus fixed fee capped once at order level',()=>{
  const r=evaluate({...clean,orders:1,aov:1000,feeFixed:2,feeCap:20,suppliers:4,rounds:2,chargeMode:'perSupplier'});
  near(r.revenue,20); near(r.gmv,1000); near(r.charges,8);
});
test('refunds reverse commission and reimbursement; original processing remains a single cost',()=>{
  const absorbed=evaluate({...clean,refundRate:.25}); near(absorbed.revenue,225); near(absorbed.processing,320); near(absorbed.refundProcessing,80); near(absorbed.operating,-95);
  const passed=evaluate({...clean,refundRate:.25,processingPayer:'seller'}); near(passed.processingRecovery,240); near(passed.processingBurden,80); near(passed.operating,145);
  const all=evaluate({...clean,refundRate:1}); near(all.revenue,0); near(all.operating,-320); near(all.payouts,0);
});
test('seller reimbursement cannot exceed proceeds on tiny orders',()=>{
  const r=evaluate({...clean,orders:1,aov:.1,processingPayer:'seller'});
  near(r.revenue,.003); near(r.processing,.3029); near(r.processingRecovery,.097); near(r.sellerShortfall,.2059); near(r.payoutVolume,0);
});
test('nonpositive marginal contribution prevents misleading volume break-even',()=>{
  assert.equal(breakEven({...clean,fixedCost:1000}).status,'negative');
  const positive={...clean,takeRate:.05,fixedCost:1000}; const be=breakEven(positive);
  assert.equal(be.status,'reachable');
  if(be.status==='reachable') { near(be.orders,556); near(be.gmv,55600); assert.ok(evaluate({...positive,orders:be.orders}).operating>=0); assert.ok(evaluate({...positive,orders:be.orders-1}).operating<0); }
});
test('card dispute wins and seller recovery are distinct; no double counting lost fee principal',()=>{
  const s={...clean,orders:100,aov:100,cardDisputeRate:.1,contestShare:1,winRate:.5,recoveryRate:.5};
  const r=evaluate(s); near(r.cardDisputes,10); near(r.revenue,285); near(r.disputeCost,225);
  near(r.principalAtRisk,485); near(r.principalLoss,242.5); near(r.operating,285-320-225-242.5);
  const won=evaluate({...s,winRate:1}); near(won.revenue,300); near(won.disputeCost,150); near(won.principalLoss,0);
});
test('ACH returns do not inherit card contest-win recovery',()=>{
  const r=evaluate({...clean,cardShare:0,achReturnRate:.1,winRate:1,recoveryRate:0});
  near(r.revenue,270); near(r.principalLoss,970); near(r.achReturns,10); near(r.disputeCost,150);
});
test('refund and chargeback cohorts are disjoint',()=>{
  const r=evaluate({...clean,refundRate:.5,cardDisputeRate:1,contestShare:0,recoveryRate:0});
  near(r.revenue,0); near(r.netGMV,0); near(r.refunds,5000); near(r.disputedMerchandise,5000); near(r.principalLoss,4850);
});
test('payout frequency changes fixed fees, not GMV, payout volume or percentage costs',()=>{
  const s={...clean,orders:100,aov:1000,sellers:10,payoutFixed:.25,payoutRate:.0025,routingRate:.0025,activeAccountFee:2};
  const monthly=evaluate({...s,payoutsPerSeller:1}),weekly=evaluate({...s,payoutsPerSeller:4});
  near(monthly.payouts,10); near(weekly.payouts,40); near(weekly.payoutCost-monthly.payoutCost,7.5);
  near(weekly.payoutVolume,monthly.payoutVolume); near(weekly.routingCost,monthly.routingCost); near(weekly.accountCost,20);
});
test('leakage, repeat frequency and CAC feed business costs independently of processing',()=>{
  const r=evaluate({...clean,leakage:.2,ordersPerBuyer:2,newBuyerShare:.5,acquisitionCost:10});
  near(r.gmv,8000); near(r.paidOrders,80); near(r.newBuyers,20); near(r.acquisition,200); near(r.processorOnly,-16); near(r.operating,-216);
});
test('cash timing and reserves change exposure only, never profit',()=>{
  const before=evaluate(clean),after=evaluate({...clean,payoutLagDays:60,reserveRate:1,reserveDays:90,achDays:10,cardDays:15});
  near(after.operating,before.operating); assert.ok(after.cash.supplierQueue>before.cash.supplierQueue); assert.ok(after.cash.reserveBuffer>before.cash.reserveBuffer);
});
test('invalid inputs rejected before calculations; all scenario outputs finite',()=>{
  for(const input of [{...clean,orders:-1},{...clean,aov:NaN},{...clean,cardShare:1.1},{...clean,rounds:0},{...clean,cardRate:1}]) {
    assert.ok(validateScenario(input).length>0); assert.throws(()=>evaluate(input));
  }
  for(const payer of ['platform','seller','buyer'] as const) for(const share of [0,.5,1]) {
    const r=evaluate({...clean,processingPayer:payer,cardShare:share});
    for(const value of Object.values(r)) if(typeof value==='number') assert.ok(Number.isFinite(value));
    near(r.processingBurden,r.processing-r.processingRecovery);
  }
});
const trades=[
  {id:'materials',label:'Materials',price:300,inputCost:0,ownCost:180,leakage:0,buyerTradeId:'components'},
  {id:'components',label:'Components',price:700,inputCost:300,ownCost:200,leakage:0,buyerTradeId:'finished'},
  {id:'finished',label:'Finished',price:1000,inputCost:700,ownCost:150,leakage:0},
];
test('network gross distinct trades differ from final demand; rates never recursively compound',()=>{
  const each=networkEconomics(clean,trades,'finished','eachTrade'),one=networkEconomics(clean,trades,'finished','finalBoundary');
  near(each.grossTradeVolume,2000); near(each.finalCustomerValue,1000); near(each.platformFee,60); near(one.platformFee,30);
  assert.deepEqual(each.rows.map(t=>t.platformFee),[9,21,30]);
  near(each.producerMargin,410); near(one.producerMargin,440); near(each.producerMargin-one.producerMargin,-30);
  near(each.rows[1]!.price,700); // Not 700 multiplied by an upstream mark-up.
});
test('network leakage removes only the affected trade payment/fee, while preserving final demand boundary',()=>{
  const r=networkEconomics(clean,trades.map(t=>t.id==='materials'?{...t,leakage:1}:t),'finished','eachTrade');
  near(r.grossTradeVolume,2000); near(r.paidOnPlatform,1700); near(r.finalCustomerValue,1000); near(r.platformFee,51);
  near(r.rows[0]!.producerMargin,120);
});
test('buyer-paid upstream fees reduce downstream producer margins; external consumer additions kept separate',()=>{
  const s={...clean,commissionPayer:'buyer' as const};
  const each=networkEconomics(s,trades,'finished','eachTrade'),one=networkEconomics(s,trades,'finished','finalBoundary');
  near(each.rows[0]!.producerMargin,120); near(each.rows[1]!.producerMargin,191); near(each.rows[2]!.producerMargin,129);
  near(each.producerFees,30); near(each.externalBuyerAdditions,30); near(each.producerMargin,440);
  near(one.producerFees,0); near(one.externalBuyerAdditions,30); near(one.producerMargin,470);
  const processingBuyer=networkEconomics({...s,processingPayer:'buyer'},trades,'finished','eachTrade');
  assert.ok(processingBuyer.rows[1]!.producerMargin<191); assert.ok(processingBuyer.externalBuyerAdditions>30);
});
test('circular recovered material is a distinct next-cycle sale, never recharges original payment',()=>{
  const recovered={id:'recovered-next-cycle',label:'Recovered',price:150,inputCost:20,ownCost:70,leakage:0};
  const r=networkEconomics(clean,[...trades,recovered],'finished','eachTrade');
  near(r.grossTradeVolume,2150); near(r.finalCustomerValue,1000); near(r.platformFee,64.5);
  near(r.rows[2]!.platformFee,30); near(r.rows[3]!.platformFee,4.5);
});
test('network requires distinct payments and explicit final boundary; negative producer margin visible',()=>{
  assert.throws(()=>networkEconomics(clean,[...trades,trades[0]!],'finished','eachTrade'));
  assert.throws(()=>networkEconomics(clean,trades,'unknown','eachTrade'));
  assert.throws(()=>networkEconomics(clean,[{...trades[0]!,leakage:1.1}],'materials','eachTrade'));
  const r=networkEconomics(clean,[{...trades[0]!,ownCost:500}],'materials','eachTrade');
  near(r.rows[0]!.producerMargin,-209);
});
