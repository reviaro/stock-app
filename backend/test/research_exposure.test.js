'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {analyzeExposure}=require('../services/fund_research');

const now=new Date('2026-10-21T18:00:00Z');
function packet(symbol,quoteType='EQUITY'){
    return {symbol,data:{info:{symbol,quoteType,timestamp:now.toISOString()}},
        provenance:{info:{available:true,stale:false,isDemo:false,eventAt:now.toISOString()}}};
}
function fundPacket(symbol,type='ETF',holdings=[{symbol:'AAA',weightPct:100}]){
    const result=packet(symbol,type);
    result.data.fund={symbol,issuerVerified:true,source:'issuer_disclosure',holdingsAsOf:'2026-10-20',holdings};
    result.provenance.fund={available:true,stale:false,isDemo:false,eventAt:'2026-10-20'};
    return result;
}
const analyze=(holdings,packets)=>analyzeExposure(holdings,{now,getPacket:async symbol=>packets[symbol]});

test('verified direct stocks and dated ETF or mutual fund holdings combine overlapping exposure',async()=>{
    const result=await analyze([{symbol:'AAA',weightPct:25},{symbol:'FUND',weightPct:50},{symbol:'MFUND',weightPct:25}],{
        AAA:packet('AAA'),FUND:fundPacket('FUND','ETF',[{symbol:'AAA',weightPct:40},{symbol:'BBB',weightPct:60}]),MFUND:fundPacket('MFUND','MUTUALFUND'),
    });
    assert.deepEqual(result,{underlying:[{symbol:'AAA',weightPct:70},{symbol:'BBB',weightPct:30}],unknown:[],complete:true});
});

test('profile outage, unavailable result, and unknown classification preserve the entire position as unknown',async()=>{
    const holdings=[{symbol:'FUND',weightPct:100}];
    for(const getPacket of [async()=>{throw Error('Provider unavailable');},async()=>null,async()=>({status:'error'}),async()=>({...packet('FUND'),data:{info:null}}),async()=>packet('FUND',null),async()=>packet('FUND','FUTURE')]){
        assert.deepEqual(await analyzeExposure(holdings,{getPacket,now}),{underlying:[],unknown:holdings,complete:false});
    }
});

test('stale, unverified, demo, wrong-symbol and untimed profiles cannot become direct holdings',async()=>{
    const mutations=[
        p=>{p.provenance.info.available=false;},p=>{p.provenance.info.stale=true;},
        p=>{p.data.info.stale=true;},p=>{p.provenance.info.isDemo=true;},p=>{p.data.info.isDemo=true;},
        p=>{p.provenance.info.eventAt='2020-01-01';},p=>{p.provenance.info.eventAt='2027-01-01';},
        p=>{delete p.provenance;},p=>{delete p.provenance.info.eventAt;delete p.data.info.timestamp;},
        p=>{p.symbol='OTHER';},p=>{p.data.info.symbol='OTHER';},
    ];
    for(const mutate of mutations){
        const p=packet('AAA');mutate(p);
        const result=await analyze([{symbol:'AAA',weightPct:100}],{AAA:p});
        assert.equal(result.complete,false);assert.deepEqual(result.underlying,[]);assert.equal(result.unknown[0].weightPct,100);
    }
});

test('current partial disclosures preserve residual unknown exposure alongside verified direct stock',async()=>{
    const result=await analyze([{symbol:'FUND',weightPct:80},{symbol:'AAA',weightPct:20}],{
        FUND:fundPacket('FUND','ETF',[{symbol:'AAA',weightPct:25}]),AAA:packet('AAA'),
    });
    assert.deepEqual(result,{underlying:[{symbol:'AAA',weightPct:40}],unknown:[{symbol:'FUND',weightPct:60}],complete:false});
});

test('missing, expired, future, unverified or malformed disclosures never count as complete fund exposure',async()=>{
    const mutations=[
        p=>{delete p.data.fund;},p=>{p.data.fund.holdingsAsOf='2026-01-01';},p=>{p.data.fund.holdingsAsOf='2027-01-01';},
        p=>{delete p.data.fund.holdingsAsOf;},p=>{p.data.fund.issuerVerified=false;},p=>{p.data.fund.stale=true;},
        p=>{p.provenance.fund.stale=true;},p=>{p.provenance.fund.available=false;},p=>{delete p.provenance.fund;},
        p=>{p.data.fund.source='yfinance';},p=>{p.data.fund.symbol='OTHER';},p=>{p.data.fund.holdings=[];},
        p=>{p.data.fund.holdings=[{symbol:'AAA',weightPct:110}];},
        p=>{p.data.fund.holdings=[{symbol:'AAA',weightPct:50},{symbol:'AAA',weightPct:50}];},
    ];
    for(const mutate of mutations){
        const p=fundPacket('FUND');mutate(p);
        const result=await analyze([{symbol:'FUND',weightPct:100}],{FUND:p});
        assert.deepEqual(result,{underlying:[],unknown:[{symbol:'FUND',weightPct:100}],complete:false});
    }
});

test('one unavailable profile does not discard other verified exposures',async()=>{
    const result=await analyzeExposure([{symbol:'AAA',weightPct:40},{symbol:'FUND',weightPct:60}],{
        now,getPacket:async symbol=>{if(symbol==='FUND')throw Error('Provider unavailable');return packet(symbol);},
    });
    assert.deepEqual(result,{underlying:[{symbol:'AAA',weightPct:40}],unknown:[{symbol:'FUND',weightPct:60}],complete:false});
});

test('invalid portfolio weights fail before requesting providers',async()=>{
    let calls=0;
    await assert.rejects(analyzeExposure([{symbol:'AAA',weightPct:70},{symbol:'BBB',weightPct:60}],{now,getPacket:async()=>{calls++;}}),/weights exceed/);
    assert.equal(calls,0);
});
