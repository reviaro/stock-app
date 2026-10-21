'use strict';
const {numberOrNull,QUOTE_MAX_AGE_MS}=require('./research_data');
const store=require('./research_store');
function validateDisclosure(input,now=new Date()){
    if(!input||!/^[A-Z][A-Z0-9.-]{0,14}$/.test(input.symbol||'')||typeof input.benchmark!=='string'||!input.benchmark.trim()||input.benchmark.length>120||input.attestation!=='I VERIFIED THIS ISSUER DISCLOSURE')throw Error('Provide a fund symbol, benchmark and issuer verification attestation');
    const ratio=numberOrNull(input.expenseRatioPct),age=now.getTime()-Date.parse(input.asOf);
    if(ratio==null||ratio<0||ratio>10||!/^\d{4}-\d{2}-\d{2}$/.test(input.asOf||'')||!Number.isFinite(age)||new Date(input.asOf).toISOString().slice(0,10)!==input.asOf||age<0||age>90*86400000)throw Error('Fund expense and disclosure date must be valid and no older than 90 days');
    let url;try{url=new URL(input.issuerUrl);}catch{throw Error('Provide the issuer disclosure HTTPS URL');}
    if(url.protocol!=='https:'||url.username||url.password||input.issuerUrl.length>1000)throw Error('Invalid issuer disclosure URL');
    if(!Array.isArray(input.holdings)||input.holdings.length<1||input.holdings.length>2000)throw Error('Provide dated disclosed holdings');
    const holdings=input.holdings.map(h=>{
        if(!/^[A-Z][A-Z0-9.-]{0,14}$/.test(h?.symbol||'')||typeof h.weightPct!=='number'||!Number.isFinite(h.weightPct)||h.weightPct<=0||h.weightPct>100)throw Error('Invalid disclosed holding');
        return {symbol:h.symbol,weightPct:h.weightPct};
    });
    if(new Set(holdings.map(h=>h.symbol)).size!==holdings.length||holdings.reduce((n,h)=>n+h.weightPct,0)>100.01)throw Error('Disclosed holdings must be unique and cannot exceed 100%');
    return {symbol:input.symbol,applicable:true,issuerVerified:true,verification:'operator_attested',issuerUrl:url.href,
        benchmark:input.benchmark.trim(),expenseRatioPct:ratio,holdingsAsOf:input.asOf,holdings,
        disclosedWeightPct:holdings.reduce((n,h)=>n+h.weightPct,0),source:'issuer_disclosure',
        limitations:['Issuer verification is operator-attested; the server does not fetch or independently authenticate the linked document.','Partial holdings leave residual exposure unknown.']};
}
async function save(input){
    const data=validateDisclosure(input);const packet=await store.savePacket({schemaVersion:1,symbol:data.symbol,kind:'fund_disclosure',generatedAt:new Date().toISOString(),data});return packet;
}
async function latest(symbol,now=new Date()){
    const rows=await store.connection(db=>store.all(db,"SELECT id FROM research_packets WHERE symbol=? AND json_extract(packet_json,'$.kind')='fund_disclosure' ORDER BY created_at DESC LIMIT 1",[symbol]));
    if(!rows.length)return null;const packet=await store.getPacket(rows[0].id);
    if(now.getTime()-Date.parse(packet.data.holdingsAsOf)>90*86400000)return {...packet.data,issuerVerified:false,stale:true};
    return packet.data;
}
function validateHoldings(holdings){
    if(!Array.isArray(holdings))throw Error('Invalid portfolio exposure inputs');
    for(const position of holdings){
        if(!position||typeof position.weightPct!=='number'||!Number.isFinite(position.weightPct)||position.weightPct<0||position.weightPct>100||!/^[A-Z][A-Z0-9.-]{0,14}$/.test(position.symbol||''))throw Error('Invalid portfolio exposure inputs');
    }
    if(holdings.reduce((n,h)=>n+h.weightPct,0)>100.01)throw Error('Portfolio weights exceed 100%');
}
function exposure(holdings,funds={}){
    validateHoldings(holdings);
    const underlying={},unknown=[];
    for(const position of holdings){
        const fund=funds[position.symbol];
        if(!fund){underlying[position.symbol]=(underlying[position.symbol]||0)+position.weightPct;continue;}
        if(!fund.issuerVerified){unknown.push({symbol:position.symbol,weightPct:position.weightPct});continue;}
        let known=0;
        for(const h of fund.holdings||[]){const value=position.weightPct*h.weightPct/100;known+=value;underlying[h.symbol]=(underlying[h.symbol]||0)+value;}
        if(position.weightPct-known>.001)unknown.push({symbol:position.symbol,weightPct:position.weightPct-known});
    }
    return {underlying:Object.entries(underlying).map(([symbol,weightPct])=>({symbol,weightPct})).sort((a,b)=>b.weightPct-a.weightPct),unknown,complete:unknown.length===0};
}
function verifiedProfile(packet,symbol,now){
    const info=packet?.data?.info,evidence=packet?.provenance?.info;
    const age=now.getTime()-Date.parse(evidence?.eventAt||info?.timestamp);
    return packet?.symbol===symbol&&info?.symbol===symbol&&evidence?.available===true
        &&!evidence.stale&&!evidence.isDemo&&!info.stale&&!info.isDemo&&!info.is_demo
        &&Number.isFinite(age)&&age>=-60_000&&age<=QUOTE_MAX_AGE_MS;
}
function verifiedDisclosure(packet,symbol,now){
    const fund=packet?.data?.fund,evidence=packet?.provenance?.fund;
    const age=now.getTime()-Date.parse(fund?.holdingsAsOf);
    if(fund?.symbol!==symbol||fund.issuerVerified!==true||fund.source!=='issuer_disclosure'
        ||fund.stale||fund.isDemo||evidence?.available!==true||evidence.stale||evidence.isDemo
        ||!Number.isFinite(age)||age<0||age>90*86400000||!Array.isArray(fund.holdings)||!fund.holdings.length)return false;
    try{validateHoldings(fund.holdings);}catch{return false;}
    return new Set(fund.holdings.map(h=>h.symbol)).size===fund.holdings.length;
}
async function analyzeExposure(holdings,{getPacket=symbol=>require('./research_service').packet(symbol),now=new Date()}={}){
    validateHoldings(holdings);
    const funds={};
    for(const symbol of new Set(holdings.map(h=>h.symbol))){
        // Absence from this map means a verified direct stock, never a failed lookup.
        funds[symbol]={issuerVerified:false};
        let packet;try{packet=await getPacket(symbol);}catch{continue;}
        if(!verifiedProfile(packet,symbol,now))continue;
        const type=packet.data.info.quoteType;
        if(type==='EQUITY')delete funds[symbol];
        else if(['ETF','MUTUALFUND'].includes(type)&&verifiedDisclosure(packet,symbol,now))funds[symbol]=packet.data.fund;
    }
    return exposure(holdings,funds);
}
module.exports={validateDisclosure,save,latest,exposure,analyzeExposure};
