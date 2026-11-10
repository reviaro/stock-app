'use strict';
const store=require('./research_store');
const {hash}=require('./research_data');
const RECOMMENDATION_MAX_AGE_MS=24*60*60_000;
const RESEARCH_MAX_AGE_MS=30*60_000;
const fail=message=>Object.assign(Error(message),{code:'LIVE_RESEARCH_REQUIRED',status:409});
async function validateAnalysis(input,symbol,{now=new Date(),getPacket=store.getPacket,maxAgeMs=RESEARCH_MAX_AGE_MS}={}){
    if(!input||typeof input.packetId!=='string'||typeof input.contentHash!=='string'||!/^[a-f0-9]{64}$/.test(input.contentHash)||typeof input.strategyVersion!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(input.strategyVersion))throw fail('Provide a saved research packet and strategy version for this decision.');
    const age=now.getTime()-Date.parse(input.analyzedAt);
    const text=(v,min=10,max=1000)=>typeof v==='string'&&v.trim().length>=min&&v.length<=max;
    if(!Number.isFinite(age)||age< -60_000||age>=maxAgeMs||!text(input.invalidation)||!text(input.model,1,120)||!Array.isArray(input.assumptions)||!input.assumptions.length||input.assumptions.length>10||!input.assumptions.every(v=>text(v,3,500))||!Array.isArray(input.alternatives)||!input.alternatives.length||input.alternatives.length>5||!input.alternatives.every(v=>text(v,3,500)))throw fail('Provide current analysis, model identity, assumptions, alternatives and thesis invalidation.');
    const packet=await getPacket(input.packetId);
    if(!packet||packet.symbol!==symbol||packet.contentHash!==input.contentHash||packet.accountScope!=='research_only'||!packet.eligibleForDecision||!Number.isFinite(Date.parse(packet.generatedAt))||now.getTime()-Date.parse(packet.generatedAt)>=maxAgeMs||Date.parse(packet.generatedAt)>now.getTime()+60_000||Date.parse(input.analyzedAt)<Date.parse(packet.generatedAt)-60_000)throw fail('Research evidence is missing, expired, mismatched or incomplete. Fetch a new packet and analyze its blockers.');
    if(!Array.isArray(input.claims)||!input.claims.length||input.claims.length>20)throw fail('Include at least one factual claim tied to a field in the saved evidence.');
    const claims=input.claims.map(claim=>{
        if(typeof claim?.path!=='string'||!/^data\.(info\.(price|marketCap|peRatio|freeCashflow|sharesOutstanding)|quality\.metrics\.[a-z_]+\.value|fund\.(expenseRatioPct|benchmark)|news\.[0-9]{1,2}\.(title|url))$/.test(claim.path))throw fail('Unsupported research claim path.');
        const value=claim.path.split('.').reduce((current,key)=>current?.[key],packet);
        if(value==null||!['number','string','boolean'].includes(typeof value)||claim.value!==value)throw fail('A factual claim does not match the saved evidence.');
        return {path:claim.path,value};
    });
    return {claims,packetId:input.packetId,contentHash:input.contentHash,strategyVersion:input.strategyVersion,analyzedAt:input.analyzedAt,model:input.model,
        assumptions:input.assumptions.map(s=>s.trim()),alternatives:input.alternatives.map(s=>s.trim()),invalidation:input.invalidation.trim()};
}
async function validateStored(key,symbol,now=new Date()){
    const rows=await store.connection(db=>store.all(db,'SELECT analysis_json FROM research_decision_evidence WHERE decision_key=?',[key]));
    if(!rows.length)throw fail('This decision needs a current research evidence record.');
    return validateAnalysis(JSON.parse(rows[0].analysis_json),symbol,{now,maxAgeMs:RECOMMENDATION_MAX_AGE_MS});
}
function recommendationExpiresAt(analysis,packetGeneratedAt){
    const times=[Date.parse(analysis?.analyzedAt),Date.parse(packetGeneratedAt)];
    return times.every(Number.isFinite)?new Date(Math.min(...times)+RECOMMENDATION_MAX_AGE_MS).toISOString():null;
}
async function freshPacket(symbol){
    const research=require('./research_service');
    research.invalidate(symbol);
    return research.packet(symbol);
}
async function validateForExecution(key,symbol,{now=()=>new Date(),getFreshPacket=freshPacket}={}){
    const analysis=await validateStored(key,symbol,now());
    const original=await store.getPacket(analysis.packetId);
    let fresh;
    try { fresh=await getFreshPacket(symbol); }
    catch { throw fail('Current research is unavailable. Refresh research before submitting this recommendation.'); }
    const checkedAt=now().getTime(),generatedAt=Date.parse(fresh?.generatedAt);
    if(!fresh||fresh.symbol!==symbol||fresh.accountScope!=='research_only'||!fresh.eligibleForDecision||!Number.isFinite(generatedAt)
        ||generatedAt>checkedAt+60_000||checkedAt-generatedAt>=RESEARCH_MAX_AGE_MS||fresh.provenance?.news?.available!==true
        ||fresh.provenance.news.stale||fresh.provenance.news.isDemo||!Array.isArray(fresh.data?.news))throw fail('Current research or material-event coverage is incomplete. Ask the strategy agent to review fresh evidence.');
    // A changed headline/filing needs analysis; the execution path must not guess
    // whether an event is material. A research price is never an execution quote.
    const oldNews=new Set((original.data?.news||[]).map(item=>hash(item)));
    const oldFilings=new Set((original.data?.filings?.filings||[]).map(item=>hash(item)));
    const newEvent=fresh.data.news.some(item=>!oldNews.has(hash(item)))
        ||(fresh.data.filings?.filings||[]).some(item=>!oldFilings.has(hash(item)));
    const fundamentals=packet=>({
        metrics:Object.fromEntries(Object.entries(packet.data?.quality?.metrics||{}).map(([name,m])=>[name,{value:m.value,periods:m.periods}])),
        freeCashflow:packet.data?.info?.freeCashflow,sharesOutstanding:packet.data?.info?.sharesOutstanding,
        fund:packet.data?.fund?{benchmark:packet.data.fund.benchmark,expenseRatioPct:packet.data.fund.expenseRatioPct,holdings:packet.data.fund.holdings,holdingsAsOf:packet.data.fund.holdingsAsOf}:null,
    });
    const changedClaim=analysis.claims.some(claim=>!['data.info.price','data.info.marketCap','data.info.peRatio'].includes(claim.path)
        &&claim.path.split('.').reduce((value,key)=>value?.[key],fresh)!==claim.value);
    if(newEvent||changedClaim||hash(fundamentals(original))!==hash(fundamentals(fresh)))throw fail('New news, filings or changed thesis evidence need fresh strategy-agent analysis before execution.');
    const expiresAt=recommendationExpiresAt(analysis,original.generatedAt);
    if(!expiresAt||Date.parse(expiresAt)<=checkedAt)throw fail('The 24-hour recommendation window expired. Ask the strategy agent for a new decision.');
    return {packetId:fresh.id,contentHash:fresh.contentHash,checkedAt:new Date(checkedAt).toISOString(),expiresAt,
        validUntil:new Date(Math.min(Date.parse(expiresAt),generatedAt+RESEARCH_MAX_AGE_MS)).toISOString()};
}
module.exports={validateAnalysis,validateStored,validateForExecution,recommendationExpiresAt,RECOMMENDATION_MAX_AGE_MS};
