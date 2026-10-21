'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {numberOrNull,normalizeNews,evidence,usablePrice}=require('../services/research_data');
const {getHybridQuote}=require('../services/hybrid_market_data');
test('numeric missingness does not coerce null, blank, boolean or objects to zero',()=>{
    for(const v of [null,undefined,'',' ',false,true,{},[],NaN,Infinity])assert.equal(numberOrNull(v),null);
    assert.equal(numberOrNull(0),0);assert.equal(numberOrNull('12.5'),12.5);
});
test('real wrapped news is normalized with source, links, timestamps and deduplication',()=>{
    const n=normalizeNews({status:'success',data:[{title:'Event',link:'https://example.test/event',providerPublishTime:1700000000},{title:'Event',link:'https://example.test/event'}],meta:{source:'yfinance'}});
    assert.equal(n.items.length,1);assert.equal(n.items[0].url,'https://example.test/event');
    assert.ok(n.items[0].publishedAt.endsWith('Z'));assert.equal(n.evidence.available,true);
    assert.equal(normalizeNews({status:'error',error:'outage'}).evidence.available,false);
    assert.equal(normalizeNews({status:'success',data:[]}).evidence.empty,true);
});
test('stale, fabricated, untimed, future and invalid prices cannot value a research portfolio',()=>{
    const valid={status:'success',data:{price:100,timestamp:new Date().toISOString()}};
    assert.equal(usablePrice(valid),100);
    for(const r of [{...valid,meta:{stale:true}},{...valid,data:{...valid.data,isDemo:true}},{...valid,data:{price:100}},{...valid,data:{...valid.data,price:null}}])assert.equal(usablePrice(r),null);
    assert.equal(evidence({...valid,meta:{stale:true}}).stale,true);
});
test('stock and ETF hybrid quotes preserve stale metadata and verify symbol identity',async()=>{
    for(const quoteType of ['EQUITY','ETF']){
        const q=await getHybridQuote('TEST',{alpacaSource:async()=>{throw Error('outage');},yfinanceSource:async()=>({price:100,symbol:'TEST',currency:'USD',timestamp:new Date().toISOString(),quoteType,stale:true})});
        assert.equal(q.stale,true);assert.equal(q.symbol,'TEST');assert.equal(q.instrument_type,quoteType);
    }
    const bad=await getHybridQuote('TEST',{alpacaSource:async()=>({symbol:'OTHER',price:10,timestamp:new Date().toISOString()}),yfinanceSource:async()=>null});
    assert.equal(bad.price,null);
});
test('AI aggregation retains wrapped news and stale evidence without touching a database',async()=>{
    const vm=require('node:vm'),fs=require('node:fs');const mod={exports:{}};
    const bridge={getStockInfo:async()=>({status:'success',data:{price:100},meta:{stale:true}}),getNews:async()=>({status:'success',data:[{title:'Reported event',link:'https://example.test/filing'}]})};
    const research=require('../services/research_service').createResearchService({bridge,store:{savePacket:async p=>({...p,id:'synthetic-packet'})}});
    vm.runInNewContext(fs.readFileSync(require.resolve('../services/ai_context'),'utf8'),{module:mod,require:n=>n.includes('database')?{getWatchlist:async()=>[{symbol:'TEST'}]}:n==='./pybridge'?bridge:n==='./research_service'?research:require('../services/research_data')});
    const stock=await mod.exports.fetchStockContext('TEST');
    const watch=await mod.exports.aggregateWatchlistContext();
    assert.equal(stock.news.length,1);assert.equal(stock.evidence.info.stale,true);assert.equal(watch.rows[0].news.length,1);
});
test('snapshot refuses fabricated success and retains stale provenance for real quotes',async()=>{
    const {snapshotWatchlist}=require('../services/snapshotService');const saved=[];
    const db={getWatchlist:async()=>[{symbol:'TEST'}],getFirstStockSnapshot:async()=>null,getStockHistory:async()=>[],upsertStockSnapshot:async row=>saved.push(row)};
    await assert.rejects(snapshotWatchlist('openish',{db,pybridge:{getStockInfo:async()=>({status:'success',data:{price:100,isDemo:true}})}}),/Verified quote unavailable/);
    await snapshotWatchlist('openish',{db,pybridge:{getStockInfo:async()=>({status:'success',data:{price:100,timestamp:new Date().toISOString()},meta:{stale:true}})}});
    assert.equal(saved[0].isCarryForward,true);assert.equal(JSON.parse(saved[0].rawPayload).evidence.stale,true);
});
