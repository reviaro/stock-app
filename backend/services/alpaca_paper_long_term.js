'use strict';

const { createLongTermInvesting } = require('./alpaca_long_term_investing');
const store = require('./alpaca_paper_long_term_store');
const { createPaperClient, getPaperConfiguration, reconcilePaperOrderAudits } = require('./alpaca_paper_service');
const handover = require('./alpaca_paper_handover');
const db = require('../database/db');
const v1 = require('./alpaca_day_trade_store');
const v2 = require('./alpaca_day_trade_v2_store');
const fail = (code, message, status = 409) => Object.assign(new Error(message), { code, status });

function configuration(env = process.env) {
    if (env.SAMPLE_DATA === '1') return {configured:false,accountBound:false,tradingEnabled:false,environment:'paper',assetScope:'US stocks and ETFs',executionModes:['confirm','automatic']};
    let config;
    try { config = getPaperConfiguration(env); }
    catch { throw fail('PAPER_ENDPOINT_INVALID', 'Paper investing requires the fixed Alpaca paper endpoint.'); }
    return {configured:config.configured,accountBound:Boolean(env.ALPACA_PAPER_ACCOUNT_ID),
        tradingEnabled:env.ALPACA_PAPER_ORDER_ENTRY_ENABLED === 'true',environment:'paper',
        assetScope:'US stocks and ETFs',executionModes:['confirm','automatic']};
}

function createPaperInvestingClient({ env = process.env, ...options } = {}) {
    if (!configuration(env).configured) throw fail('PAPER_NOT_CONFIGURED', 'Add Alpaca paper credentials on the server.', 503);
    const client = createPaperClient({env,...options});
    const call = async fn => {
        try { return await fn(); }
        catch (error) {
            throw Object.assign(fail(error.code === 'ALPACA_BROKER_REJECTED' ? 'PAPER_BROKER_REFUSED' : 'PAPER_BROKER_UNAVAILABLE',
                'The paper broker request could not be completed. Reconcile orders before retrying.', 503), {brokerStatus:error.status});
        }
    };
    return {
        getAccount:()=>call(()=>client.getAccount()),getClock:()=>call(()=>client.getClock()),
        getPositions:()=>call(()=>client.getPositions()),getOrders:()=>call(()=>client.getOrders({status:'open',nested:true})),
        getAsset:symbol=>call(()=>client.getAsset(symbol)),getLatestQuote:(symbol,options)=>call(()=>client.getLatestQuote(symbol,options)),
        getOrder:id=>call(()=>client.getOrder(id,{nested:true})),
        getOrderByClientOrderId:id=>call(()=>client.getOrderByClientOrderId(id)),
        getOrderByClientId:id=>call(async()=>(await client.getOrderByClientOrderId(id)).order),
        submit:order=>call(()=>client.submitOrder(order)),cancel:id=>call(()=>client.cancelOrder(id)),
    };
}

async function legacyBlockers({ legacyV1 = v1, legacyV2 = v2, auditStore = db } = {}) {
    const [first, second, firstPlans, secondPlans, audits, submissions] = await Promise.all([
        legacyV1.getMonitorState(),legacyV2.getMonitorState(),legacyV1.listPlans(),legacyV2.listNonterminalPlans(),
        auditStore.listAlpacaPaperOrderAudits(),legacyV2.listEntrySubmissions(),
    ]);
    const blockers=[];
    let transferred = new Set();
    if (legacyV1 === v1 && legacyV2 === v2) {
        try { transferred = await handover.transferredPlans(await store.handovers(),(await store.settings()).accountKey); }
        catch { blockers.push('Legacy fill evidence changed after ownership transfer. Review the paper holdings before continuing.'); }
    }
    if (first?.mode !== 'disabled' || second?.mode !== 'disabled') blockers.push('Disable the retired day-trading monitors before using long-term paper investing.');
    const leaseExpiry = Date.parse(first?.submission_lease_expires_at);
    const activeLease = first?.submission_lease_holder && (!Number.isFinite(leaseExpiry) || leaseExpiry > Date.now());
    if (activeLease || submissions.length) blockers.push('A legacy paper submission is still unresolved. Reconcile it before continuing.');
    if (firstPlans.some(plan=>!['closed','cancelled','error'].includes(plan.state) && !transferred.has('v1:'+plan.id)) || secondPlans.some(plan=>!transferred.has('v2:'+plan.id))) blockers.push('Legacy day-trading positions or plans need reconciliation or explicit ownership transfer before long-term paper investing can take ownership.');
    const terminal = new Set(['filled','canceled','cancelled','rejected','expired','suspended','stopped','submission_rejected','submission_not_found']);
    if (audits.some(order=>!terminal.has(String(order.status).toLowerCase()))) blockers.push('Reconcile outstanding legacy paper orders before long-term investing.');
    return blockers;
}

function createPaperLongTermInvesting(options = {}) {
    const env = options.env || process.env;
    const paperStore = options.store || store;
    const clientFactory = options.clientFactory || (()=>createPaperInvestingClient({env}));
    const now = options.now || (()=>new Date());
    const guard = options.legacyGuard || legacyBlockers;
    const service = createLongTermInvesting({store,env,configuration,environment:'paper',
        expectedAccountId:()=>env.ALPACA_PAPER_ACCOUNT_ID,requireExpectedAccountId:false,
        clientFactory,...options,legacyGuard:guard});
    const overview = service.overview;
    service.overview = async () => ({...await overview(),legacyHandovers:(await paperStore.handovers()).map(row=>({legacyVersion:row.legacy_version,planId:row.plan_id,symbol:row.symbol,qty:row.transferred_qty}))});
    const requireTransition = async () => {
        const blockers = await guard();
        if (blockers.length) throw fail('PAPER_LEGACY_RECONCILIATION_REQUIRED',blockers.join(' '));
    };
    const savePolicy = service.savePolicy;
    service.savePolicy = async (...args) => { if (args[0]?.paused === false) await requireTransition(); return savePolicy(...args); };
    const adopt = service.adopt;
    service.adopt = async (...args) => { await requireTransition(); return adopt(...args); };
    service.legacyReconcile = async () => {
        const client=clientFactory(),state=await paperStore.settings(),account=await client.getAccount();
        if (!account?.id || (env.ALPACA_PAPER_ACCOUNT_ID && account.id!==env.ALPACA_PAPER_ACCOUNT_ID) || (state.accountKey && state.accountKey!==paperStore.hash(account.id))) throw fail('PAPER_ACCOUNT_MISMATCH','The paper account must match its configured or previously bound account before reconciling history.');
        return reconcilePaperOrderAudits({client,auditStore:options.auditStore || db});
    };
    service.legacyHandover = async input => {
        if (typeof input?.symbol !== 'string' || !/^[A-Z][A-Z0-9.\-]{0,9}$/.test(input.symbol) || typeof input.qty !== 'number' || !Number.isFinite(input.qty) || input.qty <= 0
            || typeof input.reason !== 'string' || input.reason.trim().length < 10 || input.reason.length > 500 || input.confirmation !== `TRANSFER ${input.symbol} ${input.qty} PAPER`) {
            throw fail('PAPER_CONFIRMATION_REQUIRED','Review the quantity and give a reason, then type the exact TRANSFER confirmation.',400);
        }
        const state = await paperStore.settings();
        if (!state.policy.paused) throw fail('PAPER_HANDOVER_BLOCKED','Pause long-term paper investing before transferring legacy holdings.');
        await service.legacyReconcile();
        const readStarted = now().getTime();
        const client = clientFactory();
        const [account,positions,openOrders,asset,plans] = await Promise.all([client.getAccount(),client.getPositions(),client.getOrders(),client.getAsset(input.symbol),handover.getEvidence(input.symbol)]);
        const accountKey = paperStore.hash(account?.id || '');
        const checkAccount = current => {
            if (!current?.id || current.id !== account.id || (env.ALPACA_PAPER_ACCOUNT_ID && current.id !== env.ALPACA_PAPER_ACCOUNT_ID) || (state.accountKey && state.accountKey !== accountKey)
                || current.currency !== 'USD' || current.status !== 'ACTIVE' || current.trading_blocked !== false || current.account_blocked !== false) throw fail('PAPER_ACCOUNT_MISMATCH','The active paper account must match its configured or previously bound account.');
        };
        checkAccount(account);
        const checkPositions = (holdings,orders) => {
            if (!Array.isArray(holdings) || !Array.isArray(orders) || orders.length) throw fail('PAPER_HANDOVER_BLOCKED','Settle or cancel all broker orders, including protective legs, before transferring holdings.');
            const held = holdings.filter(p=>p.symbol===input.symbol);
            if (held.length !== 1 || held[0].side !== 'long' || Number(held[0].qty) !== input.qty) throw fail('PAPER_HANDOVER_BLOCKED','The reviewed quantity must match the current long broker position.');
        };
        checkPositions(positions,openOrders);
        if (asset?.symbol !== input.symbol || asset.class !== 'us_equity' || asset.status !== 'active' || asset.tradable !== true || asset.exchange === 'OTC') throw fail('PAPER_HANDOVER_BLOCKED','Only active tradable stocks and ETFs can be transferred.');
        if (!plans.length || plans.some(plan=>!plan.parentId)) throw fail('PAPER_HANDOVER_BLOCKED','No fully identified legacy holdings are available for transfer. Reconcile their broker orders first.');
        const records = plans.flatMap(plan=>plan.records);
        const terminal = new Set(['filled','canceled','expired','rejected']);
        const verifyOrder = remote => {
            const fills = records.filter(fill=>fill.orderId===remote?.id);
            const qty = fills.reduce((total,fill)=>total+fill.qty,0);
            if (!remote?.id || remote.symbol !== input.symbol || !terminal.has(remote.status) || !Number.isFinite(Number(remote.filled_qty)) || Number(remote.filled_qty) !== qty
                || fills.some(fill=>fill.side!==remote.side)) throw fail('PAPER_HANDOVER_BLOCKED','Broker orders and retained legacy fills must agree, with every protective order settled. Reconcile before transfer.');
            if (remote.legs != null && !Array.isArray(remote.legs)) throw fail('PAPER_HANDOVER_BLOCKED','The broker protective-order evidence is incomplete.');
            for (const leg of remote.legs || []) verifyOrder(leg);
        };
        for (const id of new Set(plans.flatMap(plan=>plan.orderIds))) {
            const remote = await client.getOrder(id);
            if (remote?.id !== id) throw fail('PAPER_HANDOVER_BLOCKED','A legacy broker order could not be verified.');
            verifyOrder(remote);
        }
        const orders = await paperStore.orders();
        const owned = (await paperStore.ownership()).filter(row=>row.account_key===accountKey && row.symbol===input.symbol).reduce((total,row)=>total+row.delta_qty,0)
            + orders.filter(row=>row.account_key===accountKey && row.symbol===input.symbol).reduce((total,row)=>total+(row.side==='buy'?1:-1)*row.filled_qty,0);
        const [finalAccount,finalPositions,finalOrders] = await Promise.all([client.getAccount(),client.getPositions(),client.getOrders()]);
        checkAccount(finalAccount);checkPositions(finalPositions,finalOrders);
        return paperStore.transferLegacy({accountKey,symbol:input.symbol,brokerQty:input.qty,expectedOwned:owned,policyVersion:state.version,reason:input.reason.trim(),plans,now:now().getTime(),
            assertFresh:()=>{
                checkAccount(finalAccount);
                const age=now().getTime()-readStarted;
                if (!Number.isFinite(age) || age < 0 || age > 10000) throw fail('PAPER_HANDOVER_BLOCKED','Broker evidence expired before transfer. Refresh and review again.');
            }});
    };
    return Object.fromEntries(Object.entries(service).map(([key,fn])=>[key,async(...args)=>{
        try { return await fn(...args); }
        catch (error) {
            if (['LIVE_RESEARCH_REQUIRED','LIVE_DECISION_CONFLICT'].includes(error.code)) throw fail(error.code.replace(/^LIVE_/, 'PAPER_'),error.message,error.status);
            throw error;
        }
    }]));
}

module.exports = {createPaperLongTermInvesting,createPaperInvestingClient,configuration,legacyBlockers};
