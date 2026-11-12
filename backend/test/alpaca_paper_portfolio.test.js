'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createPaperPortfolio,readFills,estimateLots,historyPoints}=require('../services/alpaca_paper_portfolio');
const {createPaperInvestingClient}=require('../services/alpaca_paper_long_term');
const at='2026-01-10T16:00:00.000Z';
function activity(id,side,qty,price,date='2026-01-01T16:00:00Z',order=id) {
    return {id,activity_type:'FILL',order_id:order,symbol:'TEST',side,qty:String(qty),price:String(price),transaction_time:date,cum_qty:'999'};
}
function fixture() {
    const account={id:'synthetic-paper',currency:'USD',cash:'850',equity:'1180'};
    const state={accountKey:'hash:synthetic-paper'};
    const data={positions:[{symbol:'TEST',side:'long',qty:'3',avg_entry_price:'100',current_price:'110',market_value:'330',unrealized_pl:'30',unrealized_plpc:'0.1',lastday_price:'100'}],
        fills:[activity('sell','sell',2,120,'2026-01-03T16:00:00Z','sell-order'),activity('buy','buy',5,100,'2026-01-01T16:00:00Z','buy-order')],
        history:{timestamp:[1767373200,1767632400],equity:[1200,1180],profit_loss:[0,-20],profit_loss_pct:[0,-20/1200]}};
    const orders=[{account_key:state.accountKey,broker_id:'buy-order',symbol:'TEST',side:'buy',filled_qty:5,decision_key:'synthetic-thesis'},
        {account_key:state.accountKey,broker_id:'sell-order',symbol:'TEST',side:'sell',filled_qty:2}];
    const ownership=[];
    const store={settings:async()=>({...state}),hash:s=>'hash:'+s,orders:async()=>orders,ownership:async()=>ownership,
        decisions:async()=>[{decision_key:'synthetic-thesis',reason:'A synthetic long-term investment thesis.'}]};
    const calls=[];
    const client={getAccount:async()=>{calls.push('account');return {...account};},getPositions:async()=>data.positions,
        getAccountActivities:async()=>data.fills,getPortfolioHistory:async()=>data.history};
    const options={store,clientFactory:()=>client,env:{},configuration:()=>({configured:true}),now:()=>new Date(at)};
    return {account,state,data,orders,ownership,store,client,options,calls,report:createPaperPortfolio(options)};
}
test('paper portfolio uses broker positions, individual executions and account-scoped thesis evidence',async()=>{
    const f=fixture(),before=structuredClone({state:f.state,orders:f.orders,ownership:f.ownership});
    const report=await f.report();
    assert.equal(report.environment,'paper');assert.equal(report.positions[0].avgCost,100);
    assert.equal(report.positions[0].priceChange,10);assert.equal(report.positions[0].priceChangePct,10);
    assert.equal(report.positions[0].unrealizedPnlPct,10);assert.equal(report.positions[0].managedQty,3);
    assert.equal(report.positions[0].heldSince,'2026-01-01T16:00:00.000Z');
    assert.equal(report.trades[0].qty,2);assert.equal(report.trades[0].amount,240); // Never cum_qty.
    assert.equal(report.realizedPnl,40);assert.equal(report.realizedExitCount,1);assert.equal(report.winRatePct,100);
    assert.equal(report.actions.length,1);assert.equal(report.actions[0].id,'buy');
    assert.equal(report.periodReturnPct,-1.67);assert.equal(report.observedEquityDrawdownPct,-1.67);
    assert.deepEqual({state:f.state,orders:f.orders,ownership:f.ownership},before);
    assert.equal(f.calls.length,2);assert.deepEqual(report.warnings,[]);
});
test('missing numeric fields stay unavailable and zero is retained',async()=>{
    const f=fixture();Object.assign(f.data.positions[0],{avg_entry_price:'',current_price:null,lastday_price:undefined,unrealized_plpc:null,unrealized_pl:'0',market_value:null});
    const p=(await f.report()).positions[0];
    for(const key of ['avgCost','price','priceChange','priceChangePct','unrealizedPnlPct','value','weightPct']) assert.equal(p[key],null,key);
    assert.equal(p.unrealizedPnl,0);
});
test('fill and equity provider failures leave independently verified holdings available',async()=>{
    const f=fixture();f.client.getAccountActivities=async()=>{throw Error('synthetic upstream failure');};
    f.client.getPortfolioHistory=async()=>({timestamp:[1],equity:[]});
    const report=await f.report();
    assert.equal(report.positions.length,1);assert.equal(report.fillsAvailable,false);
    assert.equal(report.realizedPnl,null);assert.equal(report.positions[0].heldSince,null);
    assert.equal(report.fillHistoryComplete,false);assert.equal(report.periodReturnPct,null);
    assert.equal(report.warnings.length,2);assert.equal(report.trades.length,0);
});
test('fills page with the final activity id and deduplicate overlapping partial executions',async()=>{
    const rows=Array.from({length:100},(_,i)=>activity('fill-'+i,'buy',0.25,100));let calls=0;
    const result=await readFills({getAccountActivities:async options=>{
        calls++;assert.equal(options.pageSize,100);assert.equal(options.direction,'desc');
        if(calls===1) {assert.equal(options.pageToken,undefined);return rows;}
        assert.equal(options.pageToken,'fill-99');return [rows.at(-1),activity('final','buy',0.5,100)];
    }});
    assert.equal(calls,2);assert.equal(result.fills.length,101);assert.equal(result.complete,true);
    assert.equal(result.fills.reduce((n,f)=>n+f.qty,0),25.5);
});
test('repeated pagination, page limit, invalid and conflicting fills never imply complete history',async()=>{
    const rows=Array.from({length:100},(_,i)=>activity('fill-'+i,'buy',1,100));
    const repeated=await readFills({getAccountActivities:async()=>rows});assert.equal(repeated.complete,false);
    let calls=0;
    const capped=await readFills({getAccountActivities:async()=>{const page=calls++;return rows.map(r=>({...r,id:page+'-'+r.id}));}});
    assert.equal(calls,10);assert.equal(capped.fills.length,1000);assert.equal(capped.complete,false);
    for(const extra of [{...rows[0],qty:''},{...rows[0],qty:'2'},{...rows[0],side:'sell_short'}]) {
        const result=await readFills({getAccountActivities:async()=>[rows[0],extra]});assert.equal(result.complete,false);
    }
});
test('FIFO supports partial sells, remaining lot age and groups multiple fills of a sell order',()=>{
    const fill=(id,side,qty,price,date,orderId=id)=>({id,orderId,symbol:'TEST',side,qty,price,date});
    const fills=[fill('s2','sell',1,120,'2026-01-04','sell-order'),fill('s1','sell',1,110,'2026-01-03','sell-order'),fill('b2','buy',3,90,'2026-01-02'),fill('b1','buy',1,100,'2026-01-01')];
    const r=estimateLots(fills,[{symbol:'TEST',qty:2}],true);
    assert.equal(r.realizedPnl,40);assert.equal(r.realizedExitCount,1);assert.equal(r.winRatePct,100);assert.equal(r.heldSince.TEST,'2026-01-02');
    for(const [positions,complete] of [[[{symbol:'TEST',qty:3}],true],[[{symbol:'TEST',qty:-1}],true],[[{symbol:'TEST',qty:2}],false]]) {
        const r=estimateLots(fills,positions,complete);assert.equal(r.realizedPnl,null);assert.deepEqual(r.heldSince,{});
    }
    assert.equal(estimateLots([fills[0]],[],true).realizedPnl,null);
});
test('equity series refuses malformed or unordered observations and preserves missing P&L',()=>{
    assert.throws(()=>historyPoints({timestamp:[2,1],equity:[100,110]}));
    assert.throws(()=>historyPoints({timestamp:[1],equity:['']}));
    assert.equal(historyPoints({timestamp:[1],equity:[0]})[0].returnPct,null);
    assert.equal(historyPoints({timestamp:[1],equity:[0]})[0].equity,0);
});
test('account mismatch, account changes, unsupported currency and foreign stored evidence fail closed',async()=>{
    for(const mutate of [f=>f.account.id='other-paper',f=>f.options.env.ALPACA_PAPER_ACCOUNT_ID='other-paper',f=>f.orders[0].account_key='live-hash',f=>f.ownership.push({account_key:'other-paper'}),
        f=>{f.client.getAccount=async()=>({...f.account,id:f.calls.push('read')===1?f.account.id:'changed-account'});},
        f=>{let calls=0;f.store.settings=async()=>({...f.state,accountKey:++calls===1?f.state.accountKey:'changed-binding'});}]) {
        const f=fixture();mutate(f);await assert.rejects(f.report(),{code:'PAPER_ACCOUNT_MISMATCH'});
    }
    const f=fixture();f.account.currency='EUR';await assert.rejects(f.report(),{code:'PAPER_ACCOUNT_BLOCKED'});
});
test('unsupported periods and disconnected accounts do not contact the broker',async()=>{
    const f=fixture();await assert.rejects(f.report({period:'5Y'}),{code:'PAPER_INVALID_PERIOD'});
    f.options.configuration=()=>({configured:false});await assert.rejects(createPaperPortfolio(f.options)(),{code:'PAPER_NOT_CONFIGURED'});
    assert.deepEqual(f.calls,[]);
});
test('new report requests remain GETs on the fixed paper host with paper credentials',async()=>{
    const calls=[],client=createPaperInvestingClient({env:{ALPACA_PAPER_API_KEY:'synthetic-paper',ALPACA_PAPER_SECRET_KEY:'synthetic-secret',ALPACA_LIVE_API_KEY:'synthetic-live'},fetchImpl:async(url,options)=>{calls.push({url,options});return {ok:true,status:200,json:async()=>({})};}});
    await client.getPortfolioHistory({period:'3M'});await client.getAccountActivities({activityType:'FILL',direction:'desc',pageSize:100,pageToken:'synthetic::cursor'});
    assert.equal(calls[0].url,'https://paper-api.alpaca.markets/v2/account/portfolio/history?period=3M&timeframe=1D');
    assert.equal(new URL(calls[1].url).searchParams.get('page_token'),'synthetic::cursor');
    assert.ok(calls.every(c=>c.url.startsWith('https://paper-api.alpaca.markets/')&&c.options.method==='GET'&&c.options.headers['APCA-API-KEY-ID']==='synthetic-paper'));
});
