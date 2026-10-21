'use strict';
const {test,before}=require('node:test');
const assert=require('node:assert/strict');
const db=require('../database/db');
const store=require('../services/research_store');
const {normalizeFacts,createSecSource}=require('../services/sec_fundamentals');
const {validateAnalysis}=require('../services/research_decisions');
const {createResearchService}=require('../services/research_service');
const {calculateValuation}=require('../services/valuation_model');
const {exposure,validateDisclosure}=require('../services/fund_research');
const {assess,validateDefinition}=require('../services/research_evaluation');
before(()=>db.initDb());
const stamp=new Date().toISOString();
const facts=items=>({cik:123,facts:{'us-gaap':items}});
const reported=(val,start,end,filed='2026-02-01')=>({val,start,end,filed,form:'10-K',accn:'0000000123-26-000001'});
test('SEC facts retain period, filing identity and units without future revision leakage',()=>{
    const payload=facts({Revenues:{units:{USD:[reported(100,'2025-01-01','2025-12-31'),reported(900,'2025-01-01','2025-12-31','2027-02-01')]}},NetCashProvidedByUsedInOperatingActivities:{units:{USD:[reported(20,'2025-01-01','2025-12-31')]}},PaymentsToAcquirePropertyPlantAndEquipment:{units:{USD:[reported(5,'2025-01-01','2025-12-31')]}}});
    const r=normalizeFacts(payload,{asOf:'2026-10-21'});
    assert.equal(r.annual['Total Revenue']['2025-12-31'],100);assert.equal(r.annual['Free Cash Flow']['2025-12-31'],15);
    assert.equal(r.evidence[0].filed,'2026-02-01');assert.match(r.evidence[0].url,/sec.gov\/Archives/);
    assert.equal(r.evidence.some(f=>f.filed.startsWith('2027')),false);
});
test('SEC cumulative statements and different units cannot masquerade as quarterly facts',()=>{
    const r=normalizeFacts(facts({Revenues:{units:{USD:[reported(100,'2025-01-01','2025-09-30')],EUR:[reported(200,'2025-01-01','2025-12-31')]}}}));
    assert.equal(r.annual['Total Revenue'],undefined);assert.equal(r.quarterly['Total Revenue'],undefined);
});
test('unconfigured SEC source performs no network requests and never exposes contact values',async()=>{
    let count=0;const source=createSecSource({env:{},fetchImpl:async()=>{count++;throw Error('unexpected network');}});
    assert.equal((await source.get('TEST')).configurationRequired,true);assert.equal(count,0);
});
test('immutable evidence packets detect modification attempts',async()=>{
    const p=await store.savePacket({symbol:'TEST',generatedAt:stamp,data:{info:{price:100}}});
    assert.equal((await store.getPacket(p.id)).contentHash,p.contentHash);
    await assert.rejects(store.connection(c=>store.run(c,'UPDATE research_packets SET packet_json=? WHERE id=?',['{}',p.id])),/immutable/);
});
test('agent decisions reject stale, incomplete, wrong-symbol or altered evidence',async()=>{
    const packet={id:'p',symbol:'TEST',generatedAt:stamp,contentHash:'a'.repeat(64),accountScope:'research_only',eligibleForDecision:true,data:{info:{price:100}}};
    const input={claims:[{path:'data.info.price',value:100}],packetId:'p',contentHash:packet.contentHash,strategyVersion:'v1',analyzedAt:stamp,model:'synthetic-model',assumptions:['Reported cash flow persists'],alternatives:['Wait for the next filing'],invalidation:'Cash flow weakens below the stated assumption.'};
    const getPacket=async()=>packet;
    assert.equal((await validateAnalysis(input,'TEST',{getPacket})).strategyVersion,'v1');
    for(const change of [{eligibleForDecision:false},{symbol:'OTHER'},{contentHash:'b'.repeat(64)},{generatedAt:'2020-01-01T00:00:00Z'}])await assert.rejects(validateAnalysis(input,'TEST',{getPacket:async()=>({...packet,...change})}),{code:'LIVE_RESEARCH_REQUIRED'});
    await assert.rejects(validateAnalysis({...input,analyzedAt:'2020-01-01'},'TEST',{getPacket}),{code:'LIVE_RESEARCH_REQUIRED'});
});
test('shared packet retains news provenance and blocks incomplete financial coverage',async()=>{
    const bridge={getStockInfo:async()=>({status:'success',data:{symbol:'TEST',price:100,timestamp:stamp,quoteType:'EQUITY'}}),getNews:async()=>({status:'success',data:[{title:'Event',link:'https://example.test/event'}]}),getQualityMetrics:async()=>({status:'success',data:{composite:null,coveragePct:0,metrics:{}}})};
    const service=createResearchService({bridge,store:{savePacket:async p=>p}});const p=await service.packet('TEST');
    assert.equal(p.data.news.length,1);assert.equal(p.provenance.news.available,true);assert.equal(p.eligibleForDecision,false);assert.ok(p.blockers.length);
});
test('ETF look-through combines direct shares and disclosed underlying exposure, preserving residual unknown',()=>{
    const r=exposure([{symbol:'FUND',weightPct:50},{symbol:'TEST',weightPct:10}],{FUND:{issuerVerified:true,holdings:[{symbol:'TEST',weightPct:20}]}});
    assert.equal(r.underlying[0].weightPct,20);assert.equal(r.unknown[0].weightPct,40);assert.equal(r.complete,false);
    assert.throws(()=>validateDisclosure({}),/attestation/);
});
test('DCF scenario arithmetic is explicit and invalid terminal assumptions cannot produce values',()=>{
    const input={cashFlowBasis:'enterprise',freeCashFlow:100,sharesOutstanding:10,netDebt:0,growthPct:0,discountPct:10,terminalGrowthPct:0,years:5};
    const result=calculateValuation(input);assert.ok(Math.abs(result.basePerShare-100)<1e-8);
    assert.throws(()=>calculateValuation({...input,terminalGrowthPct:10}),/Unsupported/);
    assert.throws(()=>calculateValuation({...input,freeCashFlow:null}),/finite/);
    assert.throws(()=>calculateValuation({...input,cashFlowBasis:'equity',netDebt:10}),/must not subtract/);
});
test('prospective outcomes use matched adjusted series, costs and a next-close entry; never promote',()=>{
    const d={strategyVersion:'v1',model:'test',benchmark:'BENCH',durationDays:30,horizonDays:30,minDecisions:30,costBps:10};
    assert.deepEqual(validateDefinition(d),d);
    const decision={symbol:'TEST',action:'buy',created_at:'2026-01-01T12:00:00Z',decision_json:JSON.stringify({maturityAt:'2026-02-01T12:00:00Z'})};
    const marks=[{symbol:'TEST',price:50,event_at:'2026-01-02',packet_id:'a'},{symbol:'TEST',price:55,event_at:'2026-02-02',packet_id:'a'},{symbol:'BENCH',price:100,event_at:'2026-01-02',packet_id:'b'},{symbol:'BENCH',price:105,event_at:'2026-02-02',packet_id:'b'}];
    const r=assess(d,[decision],marks,new Date('2026-03-01'));
    assert.equal(r.observationCount,1);assert.ok(Math.abs(r.meanBuyExcessReturnPct-4.9)<1e-8);assert.equal(r.liveReadiness,false);assert.ok(r.blockers.includes('insufficient_independent_matured_observations'));
    const mixed=marks.map((m,i)=>i===1?{...m,packet_id:'other-adjustment-vintage'}:m);
    assert.equal(assess(d,[decision],mixed,new Date('2026-03-01')).observationCount,0);
});
test('prospective evaluation persists immutable, adjusted histories and links only independent matured decisions',async()=>{
    const evaluation=require('../services/research_evaluation');
    const start=new Date('2026-01-01T12:00:00Z'),decisionAt=new Date('2026-01-02T14:00:00Z');
    const trial=await evaluation.create({strategyVersion:'tested-v1',model:'test-model',benchmark:'BENCH',durationDays:10,horizonDays:5,minDecisions:30,costBps:10},start);
    const packet=await store.savePacket({symbol:'TEST',generatedAt:decisionAt.toISOString(),accountScope:'research_only',eligibleForDecision:true,data:{info:{price:100}},provenance:{info:{eventAt:decisionAt.toISOString()}}});
    const benchmark=await store.savePacket({symbol:'BENCH',generatedAt:decisionAt.toISOString(),accountScope:'research_only',eligibleForDecision:false,data:{info:{price:100}},provenance:{info:{eventAt:decisionAt.toISOString()}}});
    const input={account_id:1,packetId:packet.id,benchmarkPacketId:benchmark.id,action:'buy',reason:'Synthetic prospective analysis with explicit evidence.',model:'test-model',strategyVersion:'tested-v1'};
    await assert.rejects(evaluation.record(trial.id,{...input,model:'other-model'},decisionAt),/actual model/);
    const concurrent=await Promise.allSettled([evaluation.record(trial.id,input,decisionAt),evaluation.record(trial.id,input,decisionAt)]);
    assert.equal(concurrent.filter(r=>r.status==='fulfilled').length,1);
    let calls=0;
    const history=async symbol=>{calls++;return {status:'success',data:{adjustment:'dividend_and_split_adjusted',data:[['2026-01-05T00:00:00-05:00',100],['2026-01-06T00:00:00-05:00',90],['2026-01-12T00:00:00-05:00',symbol==='TEST'?120:110]].map(([date,close])=>({date,close}))}};};
    assert.equal((await evaluation.observe(trial.id,{now:decisionAt,bridge:{getStockHistory:history}})).requested,0);assert.equal(calls,0);
    const later=new Date('2026-01-20T15:00:00Z');
    assert.equal((await evaluation.observe(trial.id,{now:later,bridge:{getStockHistory:history}})).recorded,2);
    const result=await evaluation.report(trial.id,later);
    assert.equal(result.assessment.observationCount,1);assert.ok(Math.abs(result.assessment.meanBuyExcessReturnPct-9.9)<1e-8);
    assert.ok(result.assessment.worstBuyClosingDrawdownPct>=10);
    assert.equal(result.assessment.liveReadiness,false);
    await assert.rejects(store.connection(c=>store.run(c,'DELETE FROM research_evaluations WHERE id=?',[trial.id])),/immutable/);
});
test('operator-attested fund disclosure is dated, immutable and completes an otherwise missing ETF research model',async()=>{
    const funds=require('../services/fund_research');
    const now=new Date(),asOf=now.toISOString().slice(0,10);
    const disclosure=await funds.save({symbol:'FUND',benchmark:'Synthetic benchmark',expenseRatioPct:.05,asOf,issuerUrl:'https://issuer.example/disclosure',holdings:[{symbol:'TEST',weightPct:20}],attestation:'I VERIFIED THIS ISSUER DISCLOSURE'});
    assert.equal((await funds.latest('FUND')).issuerVerified,true);
    assert.equal((await funds.latest('FUND',new Date(now.getTime()+91*86400000))).issuerVerified,false);
    const bridge={getStockInfo:async()=>({status:'success',data:{symbol:'FUND',quoteType:'ETF',currency:'USD',price:100,timestamp:now.toISOString()}}),getNews:async()=>({status:'success',data:[]})};
    const service=createResearchService({bridge});
    const packet=await service.packet('FUND');
    assert.equal(packet.data.fund.disclosedWeightPct,20);assert.equal(packet.provenance.fund.source,'issuer_disclosure');assert.equal(packet.eligibleForDecision,true);
    await assert.rejects(store.connection(c=>store.run(c,'DELETE FROM research_packets WHERE id=?',[disclosure.id])),/immutable/);
});
