'use strict';
const store=require('./research_store');
const fail=message=>Object.assign(Error(message),{code:'LIVE_RESEARCH_REQUIRED',status:409});
async function validateAnalysis(input,symbol,{now=new Date(),getPacket=store.getPacket}={}){
    if(!input||typeof input.packetId!=='string'||typeof input.contentHash!=='string'||!/^[a-f0-9]{64}$/.test(input.contentHash)||typeof input.strategyVersion!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(input.strategyVersion))throw fail('Provide a saved research packet and strategy version for this decision.');
    const age=now.getTime()-Date.parse(input.analyzedAt);
    const text=(v,min=10,max=1000)=>typeof v==='string'&&v.trim().length>=min&&v.length<=max;
    if(!Number.isFinite(age)||age< -60_000||age>30*60_000||!text(input.invalidation)||!text(input.model,1,120)||!Array.isArray(input.assumptions)||!input.assumptions.length||input.assumptions.length>10||!input.assumptions.every(v=>text(v,3,500))||!Array.isArray(input.alternatives)||!input.alternatives.length||input.alternatives.length>5||!input.alternatives.every(v=>text(v,3,500)))throw fail('Provide recent analysis, model identity, assumptions, alternatives and thesis invalidation.');
    const packet=await getPacket(input.packetId);
    if(!packet||packet.symbol!==symbol||packet.contentHash!==input.contentHash||packet.accountScope!=='research_only'||!packet.eligibleForDecision||!Number.isFinite(Date.parse(packet.generatedAt))||now.getTime()-Date.parse(packet.generatedAt)>30*60_000||Date.parse(packet.generatedAt)>now.getTime()+60_000||Date.parse(input.analyzedAt)<Date.parse(packet.generatedAt)-60_000)throw fail('Research evidence is missing, stale, mismatched or incomplete. Fetch a new packet and analyze its blockers.');
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
    return validateAnalysis(JSON.parse(rows[0].analysis_json),symbol,{now});
}
module.exports={validateAnalysis,validateStored};
