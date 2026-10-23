'use strict';

const crypto = require('node:crypto');
const db = require('../database/db');
const defaultStore = require('./alpaca_live_store');
const { configuration, createLiveClient, fail } = require('./alpaca_live_client');
const { getProvenQuote, ceilToTick, floorToTick } = require('./alpaca_market_data');
const { computeHoldings, buildSimulatorAccount } = require('./simulator_ledger');
const { getDefaultHybridQuote } = require('./hybrid_market_data');
const { emitSecurityEvent } = require('./security_events');
const MAX_EXECUTION_EVIDENCE_AGE_MS = 10_000;

const numeric = (value, label) => {
    if (!['number','string'].includes(typeof value) || String(value).trim()==='' || !Number.isFinite(Number(value))) throw fail('LIVE_INVALID_BROKER_DATA','Missing or invalid '+label+'.',503);
    return Number(value);
};
const round = (n, digits = 2) => Math.round((n + Number.EPSILON) * 10**digits) / 10**digits;
const cleanOrder = row => ({ id:row.id, planId:row.plan_id, decisionKey:row.decision_key, symbol:row.symbol, side:row.side,
    qty:row.qty, limitPrice:row.limit_price, status:row.status, filledQty:row.filled_qty,
    filledAvgPrice:row.filled_avg_price, createdAt:row.created_at, updatedAt:row.updated_at });

function orderObservation(local, remote) {
    const filled = numeric(remote?.filled_qty,'filled quantity');
    if (!remote?.id || remote.client_order_id !== local.client_order_id || remote.symbol !== local.symbol || remote.side !== local.side
        || numeric(remote.qty,'order quantity') !== local.qty || remote.type !== 'limit' || remote.time_in_force !== 'day'
        || numeric(remote.limit_price,'limit price') !== local.limit_price || typeof remote.status !== 'string'
        || remote.extended_hours === true || (remote.order_class && remote.order_class !== 'simple')
        || filled < 0 || filled > local.qty+1e-8 || (remote.status === 'filled' && Math.abs(filled-local.qty)>1e-8)) {
        throw fail('LIVE_ORDER_MISMATCH','Broker order evidence does not match the reserved intent. Trading remains blocked.',503);
    }
    const average = filled > 0 ? numeric(remote.filled_avg_price,'average fill price') : null;
    if (average !== null && average <= 0) throw fail('LIVE_ORDER_MISMATCH','Invalid broker fill price.',503);
    return { status:remote.status,broker_id:String(remote.id),filled_qty:filled,filled_avg_price:average };
}

function createLiveInvesting({ store=defaultStore, env=process.env, clientFactory=()=>createLiveClient({env}), now=()=>new Date(), sourceDb=db, getSourceQuote=getDefaultHybridQuote } = {}) {
    function requireAccount(account, state) {
        const accountKey = store.hash(account?.id || '');
        if (!env.ALPACA_LIVE_ACCOUNT_ID || account?.id !== env.ALPACA_LIVE_ACCOUNT_ID || (state.accountKey && state.accountKey !== accountKey)) throw fail('LIVE_ACCOUNT_MISMATCH','Set the expected live account ID. The connected account must match it.');
        if (account.currency !== 'USD') throw fail('LIVE_ACCOUNT_BLOCKED','Live investing requires a USD-denominated account.');
        return accountKey;
    }
    async function reconcile(client, state, account) {
        const accountKey = requireAccount(account,state);
        const rows = await store.orders();
        for (const row of rows) {
            if (row.account_key !== accountKey) throw fail('LIVE_ACCOUNT_MISMATCH','Retained order history belongs to another live account.');
            if (store.finalStatuses.has(row.status)) continue;
            const remote = await client.getOrderByClientId(row.client_order_id);
            if (remote) await store.updateOrder(row.id,orderObservation(row,remote));
        }
        return store.orders();
    }
    async function snapshot(retry=true) {
        const state = await store.settings(); const client = clientFactory();
        const readStartedAt = now().getTime();
        const [account, clock, rawPositions, openOrders] = await Promise.all([client.getAccount(),client.getClock(),client.getPositions(),client.getOrders()]);
        const accountKey = requireAccount(account,state);
        if (!Array.isArray(rawPositions) || !Array.isArray(openOrders) || typeof clock?.is_open !== 'boolean') throw fail('LIVE_INVALID_BROKER_DATA','Broker positions, orders or clock could not be verified.',503);
        const orders = await reconcile(client,state,account);
        const latest=await store.settings();
        if (latest.sequence!==state.sequence || latest.version!==state.version) {
            if (retry) return snapshot(false);
            throw fail('LIVE_STATE_CHANGED','Execution evidence changed while reading the broker. Refresh before continuing.');
        }
        const owned = {};
        for (const row of await store.ownership()) {
            if (row.account_key!==accountKey) throw fail('LIVE_ACCOUNT_MISMATCH','Reviewed ownership belongs to another live account.');
            owned[row.symbol]=round((owned[row.symbol]||0)+row.delta_qty,8);
        }
        for (const row of orders) owned[row.symbol] = round((owned[row.symbol]||0)+(row.side==='buy'?1:-1)*row.filled_qty,8);
        const positions = rawPositions.map(p => {
            const qty = numeric(p.qty,'position quantity'); const price = numeric(p.current_price,'position mark');
            if (p.side !== 'long' || qty<=0 || price<=0 || typeof p.symbol !== 'string') throw fail('LIVE_POSITION_UNSUPPORTED','Only verified long stock/ETF positions can be managed.');
            return {symbol:p.symbol,qty,price,value:round(qty*price),managedQty:owned[p.symbol]||0,
                unrealizedPnl:numeric(p.unrealized_pl,'unrealized profit/loss')};
        });
        if (new Set(positions.map(p=>p.symbol)).size!==positions.length) throw fail('LIVE_INVALID_BROKER_DATA','Broker position symbols must be unique.',503);
        const issues = [];
        if (account.status !== 'ACTIVE' || account.trading_blocked !== false || account.account_blocked !== false || account.trade_suspended_by_user === true) issues.push('The live account is not active and unblocked.');
        if (state.policy.paused) issues.push('Trading is paused.');
        if (!configuration(env).tradingEnabled) issues.push('Server-side live trading is disabled.');
        if (!clock.is_open) issues.push('The regular market session is closed.');
        if (openOrders.length) issues.push('The account has open broker orders. Wait for settlement or review them at Alpaca.');
        if (orders.some(o=>!store.finalStatuses.has(o.status))) issues.push('A submitted or uncertain order needs broker reconciliation.');
        for (const [symbol,qty] of Object.entries(owned)) {
            const actual = positions.find(p=>p.symbol===symbol)?.qty||0;
            if (qty < -1e-7 || (qty>1e-7 && Math.abs(qty-actual)>1e-7)) issues.push(symbol+': broker quantity differs from confirmed app fills. Review external trades or corporate actions.');
        }
        const cash = numeric(account.cash,'cash'); const equity = numeric(account.equity,'equity');
        const cashBuyingPower = numeric(account.non_marginable_buying_power,'cash buying power');
        if (cash<0 || equity<=0 || cashBuyingPower<0) issues.push('Cash-only investing requires positive equity and non-negative cash balances.');
        return {state,client,accountKey,account,clock,orders,owned,positions,openOrders,cash,equity,cashBuyingPower,issues,readStartedAt};
    }
    async function overview() {
        const state=await store.settings(); const config=configuration(env);
        const base={configuration:config,version:state.version,policy:state.policy,orders:(await store.orders()).map(cleanOrder),decisions:await store.decisions()};
        if (!config.configured) return {...base,connected:false,blockers:['Add separate live credentials on the server.'],positions:[]};
        try {
            const s=await snapshot();
            return {...base,connected:true,accountLabel:'••••'+String(env.ALPACA_LIVE_ACCOUNT_ID).slice(-4),
                cash:s.cash,equity:s.equity,cashBuyingPower:s.cashBuyingPower,marketOpen:s.clock.is_open,
                positions:s.positions,orders:s.orders.map(cleanOrder),blockers:s.issues,checkedAt:now().toISOString()};
        } catch(e) { return {...base,connected:false,blockers:[e.code?.startsWith('LIVE_')?e.message:'The live broker is unavailable.'],positions:[]}; }
    }
    async function preview({decisionKey=null,symbol=null,side=null}={}) {
        const s=await snapshot(); const p=s.state.policy;
        const blockers=[...s.issues];
        if (!p.budget || !p.targets.length) blockers.push('Save a capital budget and target allocation.');
        const unmanagedValue=s.positions.filter(h=>!s.owned[h.symbol]).reduce((n,h)=>n+h.value,0);
        const allocationCapital=Math.min(p.budget,Math.max(0,s.equity-unmanagedValue));
        if (!(allocationCapital>0)) blockers.push('No funded capital is available within the ceiling after protecting unrelated holdings.');
        const symbols=[...new Set([...p.targets.map(t=>t.symbol),...Object.keys(s.owned).filter(k=>s.owned[k]>1e-7)])].sort();
        const rows=[]; const capitalMarks=new Map(); let managedValue=0;
        for (const ticker of symbols) {
            let asset;
            try { asset=await s.client.getAsset(ticker); }
            catch(e) {
                if (e.brokerStatus===404) { blockers.push(ticker+': unavailable at Alpaca. Review this symbol; mutual funds are not automatically substituted.'); continue; }
                throw e;
            }
            if (asset?.symbol!==ticker || asset.class!=='us_equity' || asset.status!=='active' || asset.tradable!==true || asset.exchange==='OTC') {
                blockers.push(ticker+': not an active tradable US stock or ETF. No automatic fund substitution is performed.'); continue;
            }
            let q;
            try { q=await getProvenQuote({client:s.client,symbol:ticker,now:now(),feed:'iex'}); }
            catch { blockers.push(ticker+': a fresh Alpaca bid/ask quote is unavailable.'); continue; }
            const spread=(q.askPrice-q.bidPrice)/q.bidPrice*10000;
            if (q.bidPrice<1 || spread>p.maxSpreadBps) { blockers.push(ticker+': price or spread exceeds the approved limits.'); continue; }
            const held=s.positions.find(h=>h.symbol===ticker); const owned=s.owned[ticker]||0;
            if (held && Math.abs(held.qty-owned)>1e-7) { blockers.push(ticker+': existing holdings are not fully owned by this app.'); continue; }
            const target=p.targets.find(t=>t.symbol===ticker)?.weightPct||0;
            const currentValue=owned*q.bidPrice;
            // Use the same conservative ask mark as execution for capital limits.
            const capitalValue=owned*q.askPrice;
            capitalMarks.set(ticker,capitalValue); managedValue+=capitalValue;
            const targetValue=allocationCapital*target/100;
            const delta=targetValue-currentValue;
            const direction=delta>=0?'buy':'sell';
            const limitPrice=direction==='buy'?ceilToTick(q.askPrice*1.001):floorToTick(q.bidPrice*0.999);
            const fractional=p.fractional && asset.fractionable===true;
            const factor=fractional?1e6:1;
            const positionHeadroom=Math.max(0,allocationCapital*p.maxPositionPct/100-capitalValue);
            const rawQty=Math.min(Math.abs(delta)/limitPrice,p.maxOrderValue/limitPrice,direction==='sell'?Math.min(owned,held?.qty||0):positionHeadroom/limitPrice);
            const qty=Math.floor((rawQty+1e-10)*factor)/factor;
            const notional=round(qty*limitPrice);
            const driftPct=allocationCapital?Math.abs(delta)/allocationCapital*100:0;
            rows.push({symbol:ticker,side:direction,qty,limitPrice,notional,currentQty:owned,currentValue:round(currentValue),targetWeightPct:target,
                targetValue:round(targetValue),driftPct:round(driftPct),actionable:qty>0 && notional>=p.minTradeValue && driftPct>=p.driftPct,
                quoteAt:q.sourceTimestamp,feed:q.feed,fractional});
        }
        const spendable=Math.max(0,Math.min(s.cash,s.cashBuyingPower,allocationCapital*(1-p.reservePct/100)-managedValue));
        const candidates=rows.filter(r=>r.actionable && (!symbol || r.symbol===symbol) && (!side || r.side===side))
            .sort((a,b)=>(a.side==='sell'?0:1)-(b.side==='sell'?0:1)||b.notional-a.notional||a.symbol.localeCompare(b.symbol));
        const next=candidates[0]||null;
        if (next?.side==='buy' && rows.some(r=>r.actionable && r.side==='sell')) blockers.push('Complete and reconcile the sell adjustments before requesting a buy.');
        if (next?.side==='buy' && next.qty*next.limitPrice>spendable+1e-8) blockers.push('This buy would exceed cash-only funding or the required reserve. Sell and reconcile first.');
        if (next?.side==='buy' && (capitalMarks.get(next.symbol)+next.qty*next.limitPrice)>allocationCapital*p.maxPositionPct/100+0.01) blockers.push('This buy would exceed the maximum position weight.');
        if (symbol && !next) blockers.push('This decision is outside the approved target drift or minimum trade.');
        const plan={id:crypto.randomUUID(),accountKey:s.accountKey,policyVersion:s.state.version,stateSequence:s.state.sequence,createdAt:now().toISOString(),
            expiresAt:new Date(now().getTime()+60000).toISOString(),decisionKey,rows,nextOrder:next,blockers:[...new Set(blockers)],
            managedValue:round(managedValue),spendableCash:round(spendable),unmanagedValue:round(unmanagedValue),allocationCapital:round(allocationCapital),
            brokerQuantities:s.positions.map(h=>[h.symbol,h.qty]).sort((a,b)=>a[0].localeCompare(b[0]))};
        await store.savePlan(plan);
        return publicPlan(plan);
    }
    function publicPlan(plan) { const {accountKey,brokerQuantities,...safe}=plan; void accountKey; void brokerQuantities; return safe; }
    async function executeReviewed(planId,{confirmation,automatic=false}={}) {
        const row=await store.getPlan(planId);
        if (!row) throw fail('LIVE_PLAN_NOT_FOUND','Preview a live order first.',404);
        const plan=JSON.parse(row.plan_json); const order=plan.nextOrder;
        const existing=(await store.orders()).find(o=>o.plan_id===plan.id || (plan.decisionKey && o.decision_key===plan.decisionKey));
        if (existing) return {order:cleanOrder(existing),replayed:true};
        if (plan.decisionKey) await require('./research_decisions').validateStored(plan.decisionKey,order?.symbol,now());
        if (!order || plan.blockers.length) throw fail('LIVE_PLAN_BLOCKED','Resolve the preview blockers before submitting.');
        if (!automatic && confirmation!==`${order.side.toUpperCase()} ${order.symbol} LIVE`) throw fail('LIVE_CONFIRMATION_REQUIRED','Type the exact live-order confirmation.',400);
        if (!configuration(env).tradingEnabled) throw fail('LIVE_GATE_CLOSED','Server-side live trading is disabled.');
        if (Date.parse(plan.expiresAt)<=now().getTime()) throw fail('LIVE_PLAN_EXPIRED','The preview expired. Refresh prices and review again.');
        const fresh=await snapshot();
        if (fresh.accountKey!==plan.accountKey || fresh.state.version!==plan.policyVersion || fresh.issues.length) throw fail('LIVE_STATE_CHANGED','Broker state, settings or trading readiness changed. Preview again.');
        const quantities=fresh.positions.map(h=>[h.symbol,h.qty]).sort((a,b)=>a[0].localeCompare(b[0]));
        if (JSON.stringify(quantities)!==JSON.stringify(plan.brokerQuantities)) throw fail('LIVE_STATE_CHANGED','Broker holdings changed. Preview again.');
        const assetReadStartedAt=now().getTime();
        const asset=await fresh.client.getAsset(order.symbol);
        if (asset?.symbol!==order.symbol || asset.class!=='us_equity' || asset.status!=='active' || asset.tradable!==true || asset.exchange==='OTC'
            || (!Number.isInteger(order.qty) && asset.fractionable!==true)) throw fail('LIVE_ASSET_CHANGED','The asset is no longer eligible.');
        const q=await getProvenQuote({client:fresh.client,symbol:order.symbol,feed:'iex',now:now()});
        const quoteTimes=[Date.parse(q.sourceTimestamp)];
        if (q.bidPrice<1 || (q.askPrice-q.bidPrice)/q.bidPrice*10000>fresh.state.policy.maxSpreadBps
            || (order.side==='buy'?q.askPrice>order.limitPrice:q.bidPrice<order.limitPrice)) throw fail('LIVE_PRICE_CHANGED','The market moved beyond the approved limit or spread. Preview again.');
        const p=fresh.state.policy;
        let managed=0;
        for (const position of fresh.positions.filter(h=>fresh.owned[h.symbol]>0)) {
            const mark=position.symbol===order.symbol?q:await getProvenQuote({client:fresh.client,symbol:position.symbol,feed:'iex',now:now()});
            quoteTimes.push(Date.parse(mark.sourceTimestamp));
            managed+=position.qty*mark.askPrice;
        }
        const unmanaged=fresh.positions.reduce((n,h)=>n+(!fresh.owned[h.symbol]?h.value:0),0);
        const allocationCapital=Math.min(p.budget,Math.max(0,fresh.equity-unmanaged));
        if (order.side==='buy' && order.qty*order.limitPrice>Math.max(0,Math.min(fresh.cash,fresh.cashBuyingPower,allocationCapital*(1-p.reservePct/100)-managed))+1e-8) throw fail('LIVE_CASH_CHANGED','Cash funding or the reserve changed.');
        if (order.side==='buy' && ((fresh.owned[order.symbol]||0)*q.askPrice+order.qty*order.limitPrice)>allocationCapital*p.maxPositionPct/100+0.01) throw fail('LIVE_POSITION_LIMIT','The current position would exceed the approved weight.');
        if (order.side==='sell' && (order.qty>(fresh.owned[order.symbol]||0)+1e-8 || order.qty>(fresh.positions.find(h=>h.symbol===order.symbol)?.qty||0))) throw fail('LIVE_OWNERSHIP_CHANGED','The sell exceeds app-owned or verified broker shares.');
        const clockReadStartedAt=now().getTime();
        const finalClock=await fresh.client.getClock();
        if (finalClock?.is_open!==true) throw fail('LIVE_MARKET_CLOSED','The regular session closed before submission.');
        const sessionClose=Date.parse(finalClock.next_close);
        if (!Number.isFinite(sessionClose)) throw fail('LIVE_INVALID_BROKER_DATA','The regular-session closing time could not be verified.',503);
        const assertFresh=()=>{
            const checkedAt=now().getTime();
            if (!configuration(env).tradingEnabled) throw fail('LIVE_GATE_CLOSED','Server-side live trading is disabled.');
            requireAccount(fresh.account,fresh.state);
            if (!Number.isFinite(checkedAt) || !Number.isFinite(Date.parse(plan.expiresAt)) || !Number.isFinite(Date.parse(plan.createdAt))
                || Date.parse(plan.expiresAt)<=checkedAt || checkedAt<Date.parse(plan.createdAt)) throw fail('LIVE_PLAN_EXPIRED','The reviewed plan expired before dispatch.');
            if (checkedAt>=sessionClose) throw fail('LIVE_MARKET_CLOSED','The regular session closed before dispatch.');
            const evidence=[fresh.readStartedAt,assetReadStartedAt,clockReadStartedAt,...quoteTimes];
            if (evidence.some(t=>!Number.isFinite(t) || checkedAt<t || checkedAt-t>MAX_EXECUTION_EVIDENCE_AGE_MS)) {
                throw fail('LIVE_EXECUTION_EVIDENCE_STALE','Broker facts or quote evidence expired before dispatch.');
            }
        };
        assertFresh();
        const reserved=await store.reserveOrder(plan,order,{enabled:()=>configuration(env).tradingEnabled
            && now().getTime()-Date.parse(q.sourceTimestamp)<=10000 && now().getTime()>=Date.parse(q.sourceTimestamp),automatic,now});
        if (reserved.replayed) return {order:cleanOrder(reserved.order),replayed:true};
        const local=reserved.order;
        const dispatched=await store.dispatchOrder(plan,local,{automatic,assertFresh,submit:current=>fresh.client.submit({
            symbol:current.symbol,side:current.side,qty:String(current.qty),type:'limit',time_in_force:'day',
            limit_price:String(current.limit_price),extended_hours:false,order_class:'simple',client_order_id:current.client_order_id,
        })});
        if (dispatched.replayed) return {order:cleanOrder(dispatched.order),replayed:true};
        if (dispatched.refused) {
            throw fail('LIVE_ORDER_NOT_SENT','The reserved order was canceled before broker dispatch because its authorization or evidence changed. Preview a new intent.');
        }
        try {
            const outcome=await dispatched.settlement;
            if (outcome.error) throw outcome.error;
            const remote=outcome.value;
            await store.updateOrder(local.id,orderObservation(local,remote));
        } catch(e) {
            let found=null;
            try { found=await fresh.client.getOrderByClientId(local.client_order_id); }
            catch { /* Keep the durable uncertain intent; never generate another order ID. */ }
            if (found) await store.updateOrder(local.id,orderObservation(local,found));
            else {
                const rejected=e.code==='LIVE_BROKER_REFUSED' && [400,401,403,422].includes(e.brokerStatus);
                await store.updateOrder(local.id,{status:rejected?'rejected':'unknown'});
                throw fail(rejected?'LIVE_ORDER_REJECTED':'LIVE_ORDER_UNKNOWN',rejected?'Alpaca rejected the order; the decision is retained.':'The order outcome is uncertain. Reconcile before sending another trade.',503);
            }
        }
        return {order:cleanOrder((await store.orders()).find(o=>o.id===local.id)),replayed:false};
    }
    async function execute(planId,options={}) {
        try {
            const result=await executeReviewed(planId,options);
            if (options.automatic && !result.replayed) emitSecurityEvent('live_execute',{outcome:'success'});
            return result;
        } catch (error) {
            if (options.automatic) emitSecurityEvent('live_execute',{outcome:error.status>=500?'failure':'refused',code:error.code});
            throw error;
        }
    }
    async function decision(input) {
        if (input?.account_id!==1) throw fail('LIVE_INVALID_DECISION','The long-term source account must be 1.',400);
        if (input.policyVersion!==(await store.settings()).version) throw fail('LIVE_POLICY_CHANGED','Read the current live policy before requesting a decision.');
        const research=require('./research_decisions');
        const analysis=await research.validateAnalysis(input.analysis,input.symbol,{now:now()});
        const d=await store.saveDecision(input);
        await require('./research_store').saveDecisionEvidence(d.decision_key,analysis);
        const existing=(await store.orders()).find(o=>o.decision_key===d.decision_key);
        if (existing) return {order:cleanOrder(existing),replayed:true};
        const plan=await preview({decisionKey:d.decision_key,symbol:d.symbol,side:d.side});
        if (plan.policyVersion!==d.policy_version) throw fail('LIVE_POLICY_CHANGED','The live policy changed during the decision.');
        const state=await store.settings();
        if (state.policy.executionMode==='automatic' && !plan.blockers.length) return {plan,...await execute(plan.id,{automatic:true})};
        return {plan,awaitingConfirmation:true};
    }
    async function previewDecision(key) {
        const d=(await store.decisions()).find(d=>d.decision_key===key);
        if (!d) throw fail('LIVE_DECISION_NOT_FOUND','Decision not found.',404);
        if (d.policy_version!==(await store.settings()).version) throw fail('LIVE_POLICY_CHANGED','Ask the strategy agent for fresh analysis under the current policy.');
        await require('./research_decisions').validateStored(key,d.symbol,now());
        return preview({decisionKey:key,symbol:d.symbol,side:d.side});
    }
    async function cancel(id) {
        const state=await store.settings(); const client=clientFactory(); const account=await client.getAccount(); requireAccount(account,state);
        const local=(await store.orders()).find(o=>o.id===id);
        if (!local || local.account_key!==store.hash(account.id)) throw fail('LIVE_ORDER_NOT_FOUND','No app-owned order exists with this ID.',404);
        const remote=await client.getOrderByClientId(local.client_order_id);
        if (!remote) throw fail('LIVE_ORDER_UNKNOWN','The order cannot be proven absent. Review it at Alpaca.');
        await store.updateOrder(local.id,orderObservation(local,remote));
        if (!store.finalStatuses.has(remote.status)) await client.cancel(remote.id);
        const observed=await client.getOrderByClientId(local.client_order_id);
        if (observed) await store.updateOrder(local.id,orderObservation(local,observed));
        return {order:cleanOrder((await store.orders()).find(o=>o.id===local.id))};
    }
    async function simulatorDraft() {
        const account=await sourceDb.getSimAccount(1); const transactions=await sourceDb.listSimTransactions(1);
        if (!account) throw fail('LIVE_SOURCE_UNAVAILABLE','Long-Term simulator account 1 is unavailable.',503);
        const symbols=Object.keys(computeHoldings(transactions)); const prices={}; const marks=[];
        for (const symbol of symbols) {
            const q=await getSourceQuote(symbol); const timestamp=Date.parse(q?.timestamp);
            if (q?.symbol!==symbol || !(q.price>0) || !Number.isFinite(q.price) || q.isDemo || q.is_demo || q.stale || q.meta?.stale || !['alpaca_iex','alpaca_sip','yfinance'].includes(q.data_source)
                || !Number.isFinite(timestamp) || timestamp>now().getTime() || now().getTime()-timestamp>4*86400000) throw fail('LIVE_SOURCE_UNAVAILABLE','A recent simulator valuation is unavailable for '+symbol+'.',503);
            prices[symbol]=q.price; marks.push({symbol,asOf:q.timestamp,source:q.data_source});
        }
        const source=buildSimulatorAccount(transactions,prices);
        if (!source.valuation_complete || !(source.total_value>0) || source.cash<0) throw fail('LIVE_SOURCE_UNAVAILABLE','The simulator needs a complete positive valuation.',503);
        return {sourceAccountId:1,targets:source.positions.map(p=>({symbol:p.symbol,weightPct:Math.floor(p.market_value/source.total_value*10000)/100})),
            sourceCashPct:round(source.cash/source.total_value*100),marks,
            note:'Draft weights only. Review broker symbols, cash reserve and limits before saving. Mutual funds are not automatically replaced. Simulator dividend credits and tax estimates are not live broker transactions.'};
    }
    async function adopt(input) {
        if (typeof input?.symbol!=='string' || !/^[A-Z][A-Z0-9.\-]{0,9}$/.test(input.symbol) || typeof input.qty!=='number' || !Number.isFinite(input.qty) || input.qty<0
            || input.confirmation!==`MANAGE ${input.symbol} ${input.qty} LIVE` || typeof input.reason!=='string' || input.reason.trim().length<10 || input.reason.length>500) throw fail('LIVE_CONFIRMATION_REQUIRED','Review the broker quantity, give a reason, and type the exact MANAGE confirmation.',400);
        const s=await snapshot();
        const actual=s.positions.find(p=>p.symbol===input.symbol)?.qty||0;
        if (!s.state.policy.paused || s.openOrders.length || s.orders.some(o=>!store.finalStatuses.has(o.status)) || actual!==input.qty) throw fail('LIVE_STATE_CHANGED','Pause trading, settle all orders and review the current broker quantity first.');
        const asset=await s.client.getAsset(input.symbol);
        if (asset?.symbol!==input.symbol || asset.class!=='us_equity' || asset.status!=='active' || asset.tradable!==true || asset.exchange==='OTC') throw fail('LIVE_ASSET_CHANGED','Only eligible stocks and ETFs can be adopted.');
        return store.adopt({accountKey:s.accountKey,symbol:input.symbol,brokerQty:actual,expectedOwned:s.owned[input.symbol]||0,policyVersion:s.state.version,reason:input.reason});
    }
    async function pause(expectedVersion) {
        const current=await store.settings();
        return store.savePolicy({...current.policy,paused:true},expectedVersion,'');
    }
    return {overview,preview,execute,decision,previewDecision,cancel,simulatorDraft,adopt,pause,savePolicy:store.savePolicy};
}
module.exports={createLiveInvesting,orderObservation,cleanOrder};
