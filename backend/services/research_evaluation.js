'use strict';
const crypto=require('node:crypto');
const store=require('./research_store');
const {evidence}=require('./research_data');
const marketDate=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
const DAY_MS=86400000;
const ENTRY_TIMING='entry_calendar_days_v2',LEGACY_TIMING='decision_calendar_days_v1';
const addDays=(date,days)=>new Date(Date.parse(date+'T00:00:00Z')+days*DAY_MS).toISOString().slice(0,10);
const readDecision=row=>typeof row.decision_json==='string'?JSON.parse(row.decision_json):row;
const timingFor=(definition,decision)=>decision.timingVersion||definition.timingVersion||LEGACY_TIMING;
const entryAfterFor=(row,decision)=>decision.decisionDate||marketDate(row.created_at||decision.createdAt);
const invalid=message=>Object.assign(Error(message),{status:400,code:'RESEARCH_INVALID_INPUT'});
function validateDefinition(input){
    if(!input||!['strategyVersion','model','benchmark','durationDays','horizonDays','minDecisions','costBps'].every(k=>Object.hasOwn(input,k)))throw invalid('Provide the full prospective evaluation definition');
    if(typeof input.strategyVersion!=='string'||typeof input.benchmark!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(input.strategyVersion)||typeof input.model!=='string'||!input.model.trim()||input.model.length>120||!/^[A-Z][A-Z0-9.-]{0,14}$/.test(input.benchmark))throw invalid('Invalid strategy, model or benchmark');
    for(const [key,min,max]of [['durationDays',1,365],['horizonDays',1,365],['minDecisions',30,10000]])if(!Number.isInteger(input[key])||input[key]<min||input[key]>max)throw invalid('Invalid prospective observation window or sample requirement');
    if(typeof input.costBps!=='number'||!Number.isFinite(input.costBps)||input.costBps<0||input.costBps>100)throw invalid('Invalid estimated round-trip costs');
    return Object.fromEntries(['strategyVersion','model','benchmark','durationDays','horizonDays','minDecisions','costBps'].map(k=>[k,input[k]]));
}
async function create(input,now=new Date()){
    const definition={...validateDefinition(input),timingVersion:ENTRY_TIMING},id=crypto.randomUUID(),endsAt=new Date(now.getTime()+definition.durationDays*DAY_MS).toISOString();
    await store.connection(db=>store.run(db,'INSERT INTO research_evaluations VALUES(?,?,?,?)',[id,JSON.stringify(definition),now.toISOString(),endsAt]));
    return {id,definition,startedAt:now.toISOString(),endsAt};
}
async function get(id){return store.connection(async db=>{const row=(await store.all(db,'SELECT * FROM research_evaluations WHERE id=?',[id]))[0];if(!row)throw invalid('Evaluation not found');return {...row,definition:JSON.parse(row.definition_json)};});}
async function record(id,input,now=new Date()){
    const evaluation=await get(id),d=evaluation.definition;
    if(now.toISOString()>=evaluation.ends_at)throw invalid('This predeclared collection window ended');
    if(input?.account_id!==1)throw invalid('Explicit long-term account_id=1 is required');
    if(input?.model!==d.model||input?.strategyVersion!==d.strategyVersion)throw invalid('Report the actual model and strategy version; both must match the frozen definition');
    if(!input||!['buy','hold','avoid'].includes(input.action)||typeof input.reason!=='string'||input.reason.trim().length<10||input.reason.length>1000)throw invalid('Provide a reason and buy, hold or avoid decision');
    const packet=await store.getPacket(input.packetId),benchmark=await store.getPacket(input.benchmarkPacketId);
    for(const p of [packet,benchmark])if(!p||p.accountScope!=='research_only'||Date.parse(p.generatedAt)<Date.parse(evaluation.created_at)||Date.parse(p.generatedAt)>now.getTime()||now.getTime()-Date.parse(p.generatedAt)>30*60_000||!(p.data?.info?.price>0)||!p.provenance?.info?.eventAt)throw invalid('Use complete, current research packets collected after the evaluation started');
    if(input.action==='buy'&&!packet.eligibleForDecision)throw invalid('Buy theses require complete research evidence');
    if(benchmark.symbol!==d.benchmark)throw invalid('Benchmark packet does not match the frozen definition');
    const decisionDate=marketDate(now);
    const timingVersion=timingFor(d,{});
    const maturityDate=timingVersion===ENTRY_TIMING?null:addDays(decisionDate,d.horizonDays);
    const decision={account_id:1,action:input.action,reason:input.reason,packetId:input.packetId,benchmarkPacketId:input.benchmarkPacketId,decisionDate,maturityDate,timingVersion,
        observationNotBefore:timingVersion===ENTRY_TIMING?addDays(decisionDate,d.horizonDays+1):maturityDate,
        model:d.model,strategyVersion:d.strategyVersion,entryPrice:packet.data.info.price,benchmarkPrice:benchmark.data.info.price,
        createdAt:now.toISOString(),maturityAt:maturityDate?maturityDate+'T23:59:59.000Z':null,packetHash:packet.contentHash,benchmarkHash:benchmark.contentHash};
    const existing=await store.connection(db=>store.all(db,'SELECT id FROM research_shadow_decisions WHERE evaluation_id=? AND symbol=?',[id,packet.symbol]));
    if(existing.length)throw invalid('Only one independent observation per symbol is collected in this window');
    const decisionId=crypto.randomUUID();
    await store.connection(db=>store.run(db,'INSERT INTO research_shadow_decisions VALUES(?,?,?,?,?,?,?)',[decisionId,id,input.packetId,packet.symbol,input.action,JSON.stringify(decision),now.toISOString()]));
    return {id:decisionId,...decision};
}
async function observe(id,{bridge=require('./pybridge'),now=new Date()}={}){
    const evaluation=await get(id);
    const decisions=await store.connection(db=>store.all(db,'SELECT * FROM research_shadow_decisions WHERE evaluation_id=?',[id]));
    const marks=await store.connection(db=>store.all(db,'SELECT * FROM research_evaluation_marks WHERE evaluation_id=? ORDER BY rowid',[id]));
    const pendingDecisions=decisions.filter(row=>{
        const assessment=assess(evaluation.definition,[row],marks,now);
        return assessment.excluded.includes('missing_matched_adjusted_history');
    });
    if(!pendingDecisions.length)return {recorded:0,requested:0,remaining:0};
    // An entry can move past the earliest possible date on weekends/holidays.
    // A latest-history date alone cannot prove that an entry and exit matched.
    const attempts=await store.connection(db=>store.all(db,"SELECT detail_json FROM research_ai_audit WHERE run_id=? AND event='evaluation_history_attempt' ORDER BY rowid",[id]));
    const lastAttempt=new Map(attempts.map((attempt,index)=>[JSON.parse(attempt.detail_json).symbol,index]));
    const pendingAssets=[...new Set(pendingDecisions.map(d=>d.symbol))].filter(symbol=>symbol!==evaluation.definition.benchmark)
        .sort((a,b)=>(lastAttempt.get(a)??-1)-(lastAttempt.get(b)??-1));
    const pending=[evaluation.definition.benchmark,...pendingAssets];
    const symbols=pending.slice(0,10);let count=0;
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
    for(const symbol of symbols){
        await store.audit({runId:id,model:evaluation.definition.model,event:'evaluation_history_attempt',detail:{symbol}});
        const result=await bridge.getStockHistory(symbol,'5y','1d');
        if(!evidence(result,{now}).available||result.data?.adjustment!=='dividend_and_split_adjusted')continue;
        const bars=(result.data?.data||[]).map(b=>({...b,date:typeof b.date==='string'?b.date.slice(0,10):null})).filter(b=>/^\d{4}-\d{2}-\d{2}$/.test(b.date)&&b.date<today&&typeof b.close==='number'&&Number.isFinite(b.close)&&b.close>0);
        if(!bars.length)continue;
        const packet=await store.savePacket({symbol,kind:'evaluation_history',generatedAt:now.toISOString(),data:{bars},
            adjustment:'provider_dividend_and_split_adjusted',source:'yfinance',limitations:['Historical adjustment factors can be revised by the provider; each immutable observation preserves its own full series.']});
        await store.connection(async db=>{
            await store.run(db,'BEGIN IMMEDIATE');
            try{
                for(const bar of bars)await store.run(db,'INSERT OR IGNORE INTO research_evaluation_marks VALUES(?,?,?,?,?,?)',[crypto.randomUUID(),id,symbol,bar.close,bar.date,packet.id]);
                await store.run(db,'COMMIT');
            }catch(error){await store.run(db,'ROLLBACK');throw error;}
        });count++;
    }
    return {recorded:count,requested:pending.length,remaining:Math.max(0,pending.length-count)};
}
function assess(definition,decisions,marks,now=new Date()){
    const completed=[],excluded=[],today=marketDate(now);
    for(const row of decisions){
        const decision=readDecision(row),timingVersion=timingFor(definition,decision),entryAfter=entryAfterFor(row,decision);
        if(![ENTRY_TIMING,LEGACY_TIMING].includes(timingVersion)){excluded.push('unsupported_timing_version');continue;}
        const maturity=Date.parse(decision.maturityAt);
        if(timingVersion===ENTRY_TIMING?addDays(entryAfter,definition.horizonDays+1)>=today:!Number.isFinite(maturity)||maturity>now.getTime()){
            excluded.push('unmatured');continue;
        }
        const symbol=row.symbol||decision.symbol;
        const series=ticker=>{
            const groups=new Map();
            for(const m of marks.filter(m=>m.symbol===ticker&&m.event_at<today&&Number.isFinite(m.price)&&m.price>0)){
                if(!groups.has(m.packet_id))groups.set(m.packet_id,[]);groups.get(m.packet_id).push(m);
            }
            return [...groups.values()].reverse();
        };
        let matched=null,waitingForMaturity=false,unsupportedLegacyHorizon=false;
        for(const assetSeries of series(symbol)){
            for(const referenceSeries of series(definition.benchmark)){
                const asset=new Map(assetSeries.map(m=>[m.event_at,m.price])),reference=new Map(referenceSeries.map(m=>[m.event_at,m.price]));
                const common=[...asset.keys()].filter(d=>reference.has(d)).sort();
                const entry=common.find(d=>d>entryAfter);
                if(!entry||Date.parse(entry)-Date.parse(entryAfter)>7*DAY_MS)continue;
                const maturityDate=timingVersion===ENTRY_TIMING?addDays(entry,definition.horizonDays):decision.maturityDate||marketDate(decision.maturityAt);
                if(maturityDate>=today){waitingForMaturity=true;continue;}
                const exit=common.find(d=>d>=maturityDate);
                if(timingVersion===LEGACY_TIMING&&exit&&entry>=exit){unsupportedLegacyHorizon=true;continue;}
                if(exit&&entry<exit&&Date.parse(exit)-Date.parse(maturityDate)<=4*DAY_MS){matched={entry,exit,maturityDate,timingVersion,dailyPrices:common.filter(d=>d>=entry&&d<=exit).map(d=>asset.get(d)),assetReturnPct:(asset.get(exit)/asset.get(entry)-1)*100,benchmarkReturnPct:(reference.get(exit)/reference.get(entry)-1)*100};break;}
            }
            if(matched)break;
        }
        if(!matched){excluded.push(unsupportedLegacyHorizon?'legacy_nonpositive_holding_period':waitingForMaturity?'unmatured':'missing_matched_adjusted_history');continue;}
        if(![matched.assetReturnPct,matched.benchmarkReturnPct].every(Number.isFinite)){excluded.push('invalid_numeric_return');continue;}
        let peak=1,maxDrawdown=0;
        for(const price of matched.dailyPrices){const equity=price/matched.dailyPrices[0]*(1-definition.costBps/10000);peak=Math.max(peak,equity);maxDrawdown=Math.max(maxDrawdown,(peak-equity)/peak*100);}
        if(!Number.isFinite(maxDrawdown)){excluded.push('invalid_numeric_drawdown');continue;}
        const {dailyPrices,...summary}=matched;void dailyPrices;
        const action=row.action||decision.action,assetReturn=matched.assetReturnPct-(action==='buy'?definition.costBps/100:0);
        completed.push({symbol,action,...summary,maxClosingDrawdownPct:action==='buy'?maxDrawdown:null,assetReturnPct:assetReturn,excessReturnPct:assetReturn-matched.benchmarkReturnPct,
            correct:action==='avoid'?assetReturn<matched.benchmarkReturnPct:action==='buy'?assetReturn>matched.benchmarkReturnPct:null});
    }
    const buys=completed.filter(d=>d.action==='buy'),mean=values=>values.length?values.reduce((a,b)=>a+b,0)/values.length:null;
    const blockers=[];if(completed.length<definition.minDecisions)blockers.push('insufficient_independent_matured_observations');
    if(excluded.length)blockers.push('incomplete_observation_coverage');
    return {completed,excluded,observationCount:completed.length,meanBuyExcessReturnPct:mean(buys.map(d=>d.excessReturnPct)),
        worstBuyClosingDrawdownPct:buys.length?Math.max(...buys.map(d=>d.maxClosingDrawdownPct)):null,
        decisionAccuracyPct:mean(completed.filter(d=>d.correct!=null).map(d=>d.correct?100:0)),
        confidenceInterval:null,uncertainty:'Symbols in a shared window can be correlated; collect multiple prospective windows before inferring statistical reliability.',
        blockers,automatedPromotionEnabled:false,liveReadiness:false,
        limitations:['Prospective research outcomes, not actual portfolio P&L or live strategy qualification.',
            'For entry_calendar_days_v2, entry is the next completed common daily close after the New York decision date; maturity is the entry date plus the declared calendar days. Exit is the first common completed close on or after maturity.',
            'Legacy evaluations retain their frozen decision-date maturity. If that maturity provides no positive holding period, the observation is excluded as legacy_nonpositive_holding_period; create a new evaluation to use the entry-based horizon.',
            'Uses one coherent provider-adjusted series per instrument, incorporating splits and dividends; estimated round-trip costs apply to hypothetical buys.',
            'Single-name closing drawdown is not portfolio drawdown; taxes and executable liquidity require a separate verified strategy run.',
            'One symbol per evaluation reduces repeated-observation inflation; separate windows can still be correlated.']};
}

async function report(id,now=new Date()){
    const evaluation=await get(id);
    const [decisions,marks]=await store.connection(db=>Promise.all([store.all(db,'SELECT * FROM research_shadow_decisions WHERE evaluation_id=?',[id]),store.all(db,'SELECT * FROM research_evaluation_marks WHERE evaluation_id=? ORDER BY rowid',[id])]));
    return {evaluation,assessment:assess(evaluation.definition,decisions,marks,now)};
}
const list=()=>store.connection(db=>store.all(db,'SELECT id,definition_json,created_at,ends_at FROM research_evaluations ORDER BY created_at DESC LIMIT 50'));
module.exports={validateDefinition,create,record,observe,report,list,assess};
