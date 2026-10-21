'use strict';
const {test,before}=require('node:test');
const assert=require('node:assert/strict');
const db=require('../database/db');
const store=require('../services/research_store');
const evaluation=require('../services/research_evaluation');

before(()=>db.initDb());
const definition={strategyVersion:'timing-v1',model:'test-model',benchmark:'BENCH',durationDays:30,horizonDays:1,minDecisions:30,costBps:10,timingVersion:'entry_calendar_days_v2'};
const decision=date=>({symbol:'TEST',action:'buy',decisionDate:date,createdAt:date+'T15:00:00Z',timingVersion:definition.timingVersion,maturityAt:null});
const marks=dates=>dates.flatMap((date,index)=>[
    {symbol:'TEST',price:100+index*10,event_at:date,packet_id:'asset-series'},
    {symbol:'BENCH',price:100+index*5,event_at:date,packet_id:'benchmark-series'},
]);

test('a one-day horizon holds from the next session entry to a later completed close',()=>{
    const result=evaluation.assess(definition,[decision('2026-01-05')],marks(['2026-01-06','2026-01-07']),new Date('2026-01-08T15:00:00Z'));
    assert.equal(result.observationCount,1);
    assert.equal(result.completed[0].entry,'2026-01-06');
    assert.equal(result.completed[0].maturityDate,'2026-01-07');
    assert.equal(result.completed[0].exit,'2026-01-07');
    assert.ok(Math.abs(result.meanBuyExcessReturnPct-4.9)<1e-8);
});

test('a Friday decision starts its horizon after a weekend and holiday entry delay',()=>{
    const result=evaluation.assess(definition,[decision('2026-01-16')],marks(['2026-01-20','2026-01-21']),new Date('2026-01-22T15:00:00Z'));
    assert.equal(result.observationCount,1);
    assert.equal(result.completed[0].entry,'2026-01-20');
    assert.equal(result.completed[0].maturityDate,'2026-01-21');
    assert.equal(result.completed[0].exit,'2026-01-21');
});

test('a weekend maturity exits on the first later common completed holiday-adjusted session',()=>{
    const result=evaluation.assess(definition,[decision('2026-01-15')],marks(['2026-01-16','2026-01-20']),new Date('2026-01-21T15:00:00Z'));
    assert.equal(result.observationCount,1);
    assert.equal(result.completed[0].maturityDate,'2026-01-17');
    assert.equal(result.completed[0].exit,'2026-01-20');
});

test('longer horizons measure the declared calendar days from actual entry',()=>{
    const result=evaluation.assess({...definition,horizonDays:30},[decision('2026-01-05')],marks(['2026-01-06','2026-02-04','2026-02-05']),new Date('2026-02-06T15:00:00Z'));
    assert.equal(result.observationCount,1);
    assert.equal(result.completed[0].maturityDate,'2026-02-05');
    assert.equal(result.completed[0].exit,'2026-02-05');
});

test('current sessions and history before the actual entry horizon cannot mature a decision',()=>{
    const histories=marks(['2026-01-20','2026-01-21']);
    const result=evaluation.assess(definition,[decision('2026-01-16')],histories,new Date('2026-01-21T23:30:00Z'));
    assert.equal(result.observationCount,0);
    assert.deepEqual(result.excluded,['unmatured']);
    // The UTC date has changed, but the current New York session is still Jan 21.
    assert.deepEqual(evaluation.assess(definition,[decision('2026-01-16')],histories,new Date('2026-01-22T01:00:00Z')).excluded,['unmatured']);
});

test('missing, delayed, or mixed-vintage prices are not accepted as a completed short horizon',()=>{
    const now=new Date('2026-01-30T15:00:00Z');
    for(const history of [marks(['2026-01-20']),marks(['2026-01-20','2026-01-27']),marks(['2026-01-26','2026-01-27']),
        marks(['2026-01-20','2026-01-21']).map((mark,index)=>index===2?{...mark,packet_id:'different-vintage'}:mark)]){
        assert.equal(evaluation.assess(definition,[decision('2026-01-16')],history,now).observationCount,0);
    }
});

test('persisted legacy zero-duration decisions are explicitly excluded without changing their frozen contract',()=>{
    const legacyDefinition={...definition};delete legacyDefinition.timingVersion;
    const legacy={symbol:'TEST',action:'buy',created_at:'2026-01-05T15:00:00Z',decision_json:JSON.stringify({decisionDate:'2026-01-05',maturityDate:'2026-01-06',maturityAt:'2026-01-06T23:59:59Z'})};
    const result=evaluation.assess(legacyDefinition,[legacy],marks(['2026-01-06','2026-01-07']),new Date('2026-01-08T15:00:00Z'));
    assert.equal(result.observationCount,0);
    assert.deepEqual(result.excluded,['legacy_nonpositive_holding_period']);
    assert.match(result.limitations.join(' '),/create a new evaluation/i);
});

test('persisted legacy positive holding periods retain their original decision-date maturity',()=>{
    const legacyDefinition={...definition,horizonDays:5};delete legacyDefinition.timingVersion;
    const legacy={symbol:'TEST',action:'buy',created_at:'2026-01-02T15:00:00Z',decision_json:JSON.stringify({decisionDate:'2026-01-02',maturityDate:'2026-01-07',maturityAt:'2026-01-07T23:59:59Z'})};
    const result=evaluation.assess(legacyDefinition,[legacy],marks(['2026-01-05','2026-01-07']),new Date('2026-01-08T15:00:00Z'));
    assert.equal(result.observationCount,1);
    assert.equal(result.completed[0].maturityDate,'2026-01-07');
    assert.equal(result.completed[0].timingVersion,'decision_calendar_days_v1');
});

test('observation retries after discovering a delayed entry until the actual one-day exit exists',async()=>{
    const decisionAt=new Date('2026-01-16T15:00:00Z');
    const trial=await evaluation.create(definition,new Date('2026-01-15T15:00:00Z'));
    assert.equal(trial.definition.timingVersion,'entry_calendar_days_v2');
    const packet=async symbol=>store.savePacket({symbol,generatedAt:decisionAt.toISOString(),accountScope:'research_only',eligibleForDecision:true,data:{info:{price:100}},provenance:{info:{eventAt:decisionAt.toISOString()}}});
    const asset=await packet('TEST'),benchmark=await packet('BENCH');
    const saved=await evaluation.record(trial.id,{account_id:1,packetId:asset.id,benchmarkPacketId:benchmark.id,model:definition.model,strategyVersion:definition.strategyVersion,action:'buy',reason:'Synthetic analysis for a delayed holiday entry.'},decisionAt);
    assert.equal(saved.maturityAt,null);
    assert.equal(saved.maturityDate,null);
    assert.equal(saved.observationNotBefore,'2026-01-18');
    let calls=0,dates=['2026-01-16','2026-01-20'];
    const bridge={getStockHistory:async symbol=>{calls++;return {status:'success',data:{adjustment:'dividend_and_split_adjusted',data:dates.map((date,index)=>({date,close:100+index*(symbol==='TEST'?10:5)}))}};}};
    assert.equal((await evaluation.observe(trial.id,{bridge,now:decisionAt})).requested,0);
    assert.equal(calls,0);
    const beforeExit=new Date('2026-01-21T15:00:00Z');
    assert.equal((await evaluation.observe(trial.id,{bridge,now:beforeExit})).recorded,2);
    assert.deepEqual((await evaluation.report(trial.id,beforeExit)).assessment.excluded,['unmatured']);
    assert.equal((await evaluation.observe(trial.id,{bridge,now:beforeExit})).requested,0);
    dates=[...dates,'2026-01-21'];
    const afterExit=new Date('2026-01-22T15:00:00Z');
    assert.equal((await evaluation.observe(trial.id,{bridge,now:afterExit})).recorded,2);
    const report=await evaluation.report(trial.id,afterExit);
    assert.equal(report.assessment.observationCount,1);
    assert.equal(report.assessment.completed[0].entry,'2026-01-20');
    assert.equal(report.assessment.completed[0].exit,'2026-01-21');
    assert.equal((await evaluation.observe(trial.id,{bridge,now:afterExit})).requested,0);
    assert.equal(calls,4);
});

test('bounded observation retries advance past unavailable symbols instead of starving later decisions',async()=>{
    const decisionAt=new Date('2026-01-16T15:00:00Z');
    const trial=await evaluation.create(definition,new Date('2026-01-15T15:00:00Z'));
    const packet=async symbol=>store.savePacket({symbol,generatedAt:decisionAt.toISOString(),accountScope:'research_only',eligibleForDecision:true,data:{info:{price:100}},provenance:{info:{eventAt:decisionAt.toISOString()}}});
    const benchmark=await packet('BENCH');
    for(let index=0;index<10;index++){
        const asset=await packet('ASSET'+index);
        await evaluation.record(trial.id,{account_id:1,packetId:asset.id,benchmarkPacketId:benchmark.id,model:definition.model,strategyVersion:definition.strategyVersion,action:'buy',reason:'Synthetic analysis for a bounded observation batch.'},decisionAt);
    }
    const calls=[];
    const bridge={getStockHistory:async symbol=>{
        calls.push(symbol);
        if(symbol!=='BENCH'&&symbol!=='ASSET9')return {status:'error',message:'Unavailable synthetic history'};
        return {status:'success',data:{adjustment:'dividend_and_split_adjusted',data:[{date:'2026-01-20',close:100},{date:'2026-01-21',close:110}]}};
    }};
    const now=new Date('2026-01-22T15:00:00Z');
    await evaluation.observe(trial.id,{bridge,now});
    assert.equal(calls.length,10);
    assert.equal(calls.includes('ASSET9'),false);
    await evaluation.observe(trial.id,{bridge,now});
    assert.equal(calls.length,20);
    assert.equal(calls[11],'ASSET9');
    assert.equal((await evaluation.report(trial.id,now)).assessment.observationCount,1);
});
