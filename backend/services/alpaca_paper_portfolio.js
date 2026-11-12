'use strict';

// Read-only account reporting. Never reads simulator/live ledgers or submits,
// reconciles, adopts, or changes broker orders or investing policy.
const fail = (code, message, status = 503) => Object.assign(new Error(message), {code:'PAPER_'+code,status});
const number = value => (typeof value === 'number' || typeof value === 'string') && String(value).trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
const round = value => value == null ? null : Math.round(value * 100) / 100;
const positive = value => { const n=number(value); return n > 0 ? n : null; };
const EPS = 1e-7;
const MAX_PAGES = 10;
const PAGE_SIZE = 100;

async function readFills(client) {
    const rows=new Map(), tokens=new Set();
    let pageToken, complete=false, invalid=false;
    for(let page=0;page<MAX_PAGES;page++) {
        const batch=await client.getAccountActivities({activityType:'FILL',direction:'desc',pageSize:PAGE_SIZE,pageToken});
        if(!Array.isArray(batch)) throw Error('Invalid fill response');
        for(const row of batch) {
            const qty=positive(row?.qty), price=positive(row?.price), stamp=Date.parse(row?.transaction_time);
            if(typeof row?.id!=='string' || !row.id || row.activity_type!=='FILL' || !['buy','sell'].includes(row.side)
                || typeof row.symbol!=='string' || !row.symbol || !qty || !price || !Number.isFinite(stamp) || !Number.isFinite(qty*price)) { invalid=true; continue; }
            const fill={id:row.id,orderId:typeof row.order_id==='string'?row.order_id:null,symbol:row.symbol,side:row.side,qty,price,amount:round(qty*price),date:new Date(stamp).toISOString()};
            if(rows.has(row.id) && JSON.stringify(rows.get(row.id))!==JSON.stringify(fill)) invalid=true;
            rows.set(row.id,fill);
        }
        if(batch.length<PAGE_SIZE) { complete=true; break; }
        const next=batch.at(-1)?.id;
        if(typeof next!=='string' || !next || tokens.has(next)) break;
        tokens.add(next);pageToken=next;
    }
    return {fills:[...rows.values()].sort((a,b)=>b.date.localeCompare(a.date)||b.id.localeCompare(a.id)),complete:complete&&!invalid};
}

// These are explicitly FIFO estimates from broker execution activities, not
// broker tax lots. Suppress estimates if the available fills cannot explain the
// current positions, including truncated history, shorts and corporate actions.
function estimateLots(fills, positions, complete) {
    const lots=new Map(), exits=new Map(), directions=new Map();
    let valid=complete;
    for(const fill of [...fills].reverse()) {
        const tie=fill.symbol+'|'+fill.date;
        if(directions.has(tie) && directions.get(tie)!==fill.side) valid=false;
        directions.set(tie,fill.side);
        if(!lots.has(fill.symbol)) lots.set(fill.symbol,[]);
        const queue=lots.get(fill.symbol);
        if(fill.side==='buy') queue.push({qty:fill.qty,price:fill.price,date:fill.date});
        else {
            let left=fill.qty, cost=0;
            while(left>EPS && queue.length) {
                const lot=queue[0], qty=Math.min(left,lot.qty);
                cost+=qty*lot.price;left-=qty;lot.qty-=qty;
                if(lot.qty<EPS) queue.shift();
            }
            if(left>EPS) valid=false;
            const key=fill.orderId||fill.id;
            exits.set(key,(exits.get(key)||0)+fill.qty*fill.price-cost);
        }
    }
    for(const symbol of new Set([...lots.keys(),...positions.map(p=>p.symbol)])) {
        const expected=(lots.get(symbol)||[]).reduce((n,lot)=>n+lot.qty,0), position=positions.find(p=>p.symbol===symbol);
        if(Math.abs(expected-(position?.qty||0))>EPS || (position && position.qty<=0)) valid=false;
    }
    return {
        realizedPnl:valid?round([...exits.values()].reduce((a,b)=>a+b,0)):null,
        realizedExitCount:valid?exits.size:null,
        winRatePct:valid&&exits.size?round([...exits.values()].filter(n=>n>EPS).length/exits.size*100):null,
        heldSince:valid?Object.fromEntries([...lots].map(([symbol,queue])=>[symbol,queue[0]?.date||null])):{},
        available:valid,
    };
}

function historyPoints(raw) {
    if(!raw || !Array.isArray(raw.timestamp) || !Array.isArray(raw.equity) || raw.timestamp.length!==raw.equity.length) throw Error('Invalid history response');
    const points=raw.timestamp.map((stamp,i)=>{
        const seconds=number(stamp), equity=number(raw.equity[i]), date=seconds===null?NaN:seconds*1000;
        if(!Number.isFinite(date) || date<0 || date>8.64e15 || equity===null) throw Error('Invalid history point');
        return {date:new Date(date).toISOString(),equity,profitLoss:number(raw.profit_loss?.[i]),returnPct:raw.profit_loss_pct?.[i]==null?null:round(number(raw.profit_loss_pct[i])===null?null:number(raw.profit_loss_pct[i])*100)};
    });
    if(points.some((point,i)=>i>0 && point.date<=points[i-1].date)) throw Error('Unordered history');
    return points;
}

function createPaperPortfolio({store,clientFactory,env,now=()=>new Date(),configuration}) {
    return async ({period='1M'}={}) => {
        if(!['1M','3M','1A'].includes(period)) throw fail('INVALID_PERIOD','Choose one month, three months or one year.',400);
        if(!configuration(env).configured) throw fail('NOT_CONFIGURED','Connect the Alpaca paper account to review its holdings and fills.');
        const state=await store.settings(), client=clientFactory();
        const account=await client.getAccount(), accountKey=store.hash(account?.id||'');
        const checkAccount=current=>{
            if(!current?.id || current.id!==account.id || (env.ALPACA_PAPER_ACCOUNT_ID && current.id!==env.ALPACA_PAPER_ACCOUNT_ID)
                || (state.accountKey && state.accountKey!==accountKey)) throw fail('ACCOUNT_MISMATCH','The paper account does not match its configured or previously bound account.');
            if(current.currency!=='USD') throw fail('ACCOUNT_BLOCKED','Paper portfolio reporting requires a USD account.');
        };
        checkAccount(account);
        const [rawPositions,orders,ownership,decisions,fillResult,historyResult]=await Promise.all([
            client.getPositions(),store.orders(),store.ownership(),store.decisions(),
            readFills(client).then(value=>({value}),()=>({error:true})),
            client.getPortfolioHistory({period}).then(historyPoints).then(value=>({value}),()=>({error:true})),
        ]);
        if(!Array.isArray(rawPositions)) throw fail('INVALID_BROKER_DATA','The broker holdings could not be verified.');
        if([...orders,...ownership].some(row=>row.account_key!==accountKey)) throw fail('ACCOUNT_MISMATCH','Retained investing evidence belongs to another paper account.');
        const owned=new Map();
        for(const row of ownership) owned.set(row.symbol,(owned.get(row.symbol)||0)+row.delta_qty);
        for(const row of orders) owned.set(row.symbol,(owned.get(row.symbol)||0)+(row.side==='buy'?1:-1)*row.filled_qty);
        const cash=number(account.cash), equity=number(account.equity);
        if(cash===null || equity===null) throw fail('INVALID_BROKER_DATA','The broker balances could not be verified.');
        const positions=rawPositions.map(row=>{
            const qty=number(row.qty), price=positive(row.current_price), previous=positive(row.lastday_price);
            if(typeof row.symbol!=='string' || !row.symbol || qty===null || qty===0) throw fail('INVALID_BROKER_DATA','The broker holdings could not be verified.');
            const change=price!==null && previous!==null?price-previous:null;
            const pnlPct=number(row.unrealized_plpc);
            return {symbol:row.symbol,qty,avgCost:positive(row.avg_entry_price),price,value:number(row.market_value),
                priceChange:round(change),priceChangePct:change===null?null:round(change/previous*100),
                unrealizedPnl:number(row.unrealized_pl),unrealizedPnlPct:pnlPct===null?null:round(pnlPct*100),
                weightPct:equity>0 && number(row.market_value)!==null?round(number(row.market_value)/equity*100):null,
                managedQty:owned.get(row.symbol)||0};
        }).sort((a,b)=>(b.value??-Infinity)-(a.value??-Infinity)||a.symbol.localeCompare(b.symbol));
        if(new Set(positions.map(p=>p.symbol)).size!==positions.length) throw fail('INVALID_BROKER_DATA','The broker returned duplicate holdings.');
        const fills=fillResult.value?.fills||[], complete=fillResult.value?.complete||false;
        const estimates=estimateLots(fills,positions,complete);
        const history=historyResult.value||[], warnings=[];
        if(fillResult.error) warnings.push('Broker fills are unavailable. Refresh to retry; an empty table does not mean there were no trades.');
        else if(!complete) warnings.push('Fill history is incomplete or exceeds 1,000 executions. FIFO estimates and holding periods are unavailable.');
        if(!estimates.available && complete) warnings.push('Recorded fills do not fully explain the current holdings. FIFO estimates and holding periods are unavailable; review external transfers, short sales or corporate actions.');
        if(historyResult.error) warnings.push('Broker equity history is unavailable. Current holdings and balances are still shown.');
        const byOrder=new Map(orders.filter(o=>o.broker_id).map(o=>[o.broker_id,o]));
        const byDecision=new Map(decisions.map(d=>[d.decision_key,d]));
        const trades=fills.map(fill=>{
            const order=byOrder.get(fill.orderId), decision=order && byDecision.get(order.decision_key);
            const matched=order && order.symbol===fill.symbol && order.side===fill.side;
            return {...fill,reason:matched?decision?.reason||null:null,origin:matched?'Long-term investing':'Other paper activity'};
        });
        // Avoid returning a mixed account snapshot if credentials changed during reads.
        checkAccount(await client.getAccount());
        const latest=await store.settings();
        if(latest.accountKey!==state.accountKey) throw fail('ACCOUNT_MISMATCH','Paper account binding changed. Refresh the portfolio.');
        let peak=0, drawdown=0;
        for(const point of history) { peak=Math.max(peak,point.equity);if(peak>0) drawdown=Math.min(drawdown,(point.equity/peak-1)*100); }
        return {environment:'paper',checkedAt:now().toISOString(),period,cash,equity,cashPct:equity>0?round(cash/equity*100):null,
            positions:positions.map(p=>({...p,heldSince:estimates.heldSince[p.symbol]||null})),
            unrealizedPnl:positions.every(p=>p.unrealizedPnl!==null)?round(positions.reduce((n,p)=>n+p.unrealizedPnl,0)):null,
            realizedPnl:estimates.realizedPnl,realizedExitCount:estimates.realizedExitCount,winRatePct:estimates.winRatePct,
            fifoAvailable:estimates.available,history,periodReturnPct:history.at(-1)?.returnPct??null,
            observedEquityDrawdownPct:history.length>1 && peak>0?round(drawdown):null,
            trades,fillHistoryComplete:complete,fillsAvailable:!fillResult.error,warnings,
            actions:trades.filter(t=>t.reason).slice(0,10)};
    };
}
module.exports={createPaperPortfolio,readFills,estimateLots,historyPoints};
