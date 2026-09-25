'use strict';

/**
 * Shared simulator execution service — the single path through which UI,
 * external agent, and built-in AI obtain evaluated simulator fills.
 *
 * Boundary (docs/plans/2026-09-06-simulator-correctness.md):
 *  - Caller submits a trade INTENTION: { account_id, type, symbol, shares,
 *    client_order_id, fees?, notes?, trade_plan?, journal? }.
 *  - The server validates the account, permitted action, data quality,
 *    resources, and assigns the fill price/date from a server-obtained
 *    execution quote (execution_quote_policy). Caller prices are ignored.
 *  - Idempotency: same account+client_order_id with the same intent replays
 *    the stored result (no duplicate fill). Different intent -> conflict.
 *  - Day-trading (account 2) buys require a structured trade plan.
 *  - Retry-before-quote: a caller that timed out can look up its order by
 *    intent BEFORE we hit the quote provider again.
 */

const db = require('../database/db');
const { obtainExecutionQuote } = require('./execution_quote_policy');
const { obtainValuationQuote } = require('./valuation_quote_policy');
const { getDefaultHybridQuote } = require('./hybrid_market_data');
const { normalizeTradePlan } = require('./trade_journal');

function executionError(status, code, message) {
    return Object.assign(new Error(message), { status, code });
}

function normalizeSymbol(value) {
    const symbol = typeof value === 'string' ? value.trim().toUpperCase() : '';
    return /^[A-Z][A-Z0-9]{0,4}(?:[.-][A-Z]{1,2})?$/.test(symbol) ? symbol : null;
}

function buildIntent(input) {
    return { type: input.type, symbol: input.symbol, shares: input.shares,
        account_id: input.account_id, fees: input.fees, notes: input.notes ?? null,
        trade_plan: input.trade_plan ?? null, journal: input.journal ?? null,
        close_plan_id: input.close_plan_id ?? null, ...(input.run_id != null ? { run_id: input.run_id } : {}) };
}

async function requireSimAccount(accountId) {
    const accounts = await db.listSimAccounts();
    const account = accounts.find((a) => a.id === Number(accountId));
    if (!account) throw executionError(400, 'SIM_ACCOUNT_NOT_FOUND', `unknown simulator account_id ${accountId}`);
    return account;
}

/**
 * Execute an evaluated simulator trade. Returns { result, duplicate: boolean }.
 */
async function executeSimulatorTradeIntent(input) {
    const type = input?.type;
    if (!['buy', 'sell'].includes(type)) {
        throw executionError(400, 'SIM_INVALID_ORDER', 'type must be buy or sell');
    }
    const symbol = normalizeSymbol(input?.symbol);
    if (!symbol) throw executionError(400, 'SIM_INVALID_ORDER', 'invalid symbol');
    const shares = Number(input?.shares);
    if (!Number.isFinite(shares) || shares <= 0) {
        throw executionError(400, 'SIM_INVALID_ORDER', 'shares must be a positive finite number');
    }
    const clientOrderId = input?.client_order_id == null ? null : String(input.client_order_id).trim();
    if (!clientOrderId || clientOrderId.length > 200) {
        throw executionError(400, 'SIM_INVALID_ORDER', 'client_order_id is required (1-200 chars)');
    }
    const fees = input?.fees == null ? 0 : Number(input.fees);
    if (!Number.isFinite(fees) || fees < 0) {
        throw executionError(400, 'SIM_INVALID_ORDER', 'fees must be finite and nonnegative');
    }
    const accountId = Number(input?.account_id);
    if (!Number.isInteger(accountId) || accountId <= 0) {
        throw executionError(400, 'SIM_INVALID_ORDER', 'explicit positive account_id is required');
    }
    const account = await requireSimAccount(accountId);
    const intent = buildIntent({ ...input, type, symbol, shares, fees, account_id: accountId });

    // Day-trading entries require a structured plan (enforced by the atomic op too).
    if (type === 'buy' && account.slug === 'day-trading') {
        const plan = input?.trade_plan;
        if (!plan || typeof plan !== 'object') {
            throw executionError(400, 'SIM_PLAN_REQUIRED', 'day-trading buys require a structured trade plan');
        }
    }

    // Retry-before-quote: a prior identical order replays without a new quote.
    const saved = await db.getSimOrder(accountId, clientOrderId);
    if (saved) {
        if (saved.intent_hash !== db.canonicalIntentHash(intent)) {
            throw executionError(409, 'SIM_ORDER_CONFLICT', 'client_order_id already used with a different intent');
        }
        return { result: saved.result, duplicate: true };
    }

    // Server-owned quote: the ONLY source of fill price and date.
    const quoteResult = await obtainExecutionQuote(symbol, { getHybridQuote: getDefaultHybridQuote });
    if (!quoteResult.valid) {
        throw executionError(503, 'SIM_QUOTE_REJECTED', `execution quote rejected: ${quoteResult.code}`);
    }
    const quote = quoteResult.quote;
    const today = new Date().toISOString().slice(0, 10);

    const order = {
        transaction: {
            account_id: accountId,
            type,
            symbol,
            shares,
            price: quote.price,
            txn_date: today,
            fees,
            notes: input?.notes ?? null,
        },
        client_order_id: clientOrderId,
        intent,
        quote,
        valuation_quotes: { [symbol]: quote },
    };
    // Fetch marks before the lock; revalidate them under the lock. A concurrent
    // new holding missing from this set causes a fail-closed entry rejection.
    const { computeHoldings } = require('./simulator_ledger');
    const holdings = computeHoldings(await db.listSimTransactions(accountId));
    await Promise.all(Object.keys(holdings).filter((held) => held !== symbol).map(async (held) => {
        const mark = await obtainValuationQuote(held, { getHybridQuote: getDefaultHybridQuote });
        if (mark.valid) order.valuation_quotes[held] = mark.quote;
    }));
    if (type === 'buy' && input?.trade_plan) {
        order.trade_plan = normalizeTradePlan({
            ...input.trade_plan,
            account_id: accountId,
            symbol,
            planned_entry: quote.price,
            shares,
        });
    }
    if (type === 'sell' && input?.close_plan_id != null) {
        order.close_plan_id = Number(input.close_plan_id);
    }
    if (type === 'sell' && input?.journal) {
        order.closure = input.journal;
    }

    let result;
    try {
        result = await db.executeSimTradeAtomic(order);
    } catch (err) {
        if (err && err.code === 'SIM_ORDER_CONFLICT') err.status = 409;
        else if (err && err.code === 'SIM_INSUFFICIENT_CASH') err.status = 400;
        else if (err && err.code === 'SIM_INSUFFICIENT_SHARES') err.status = 400;
        else if (err && err.code === 'SIM_PLAN_REQUIRED') err.status = 400;
        else if (err && err.code === 'SIM_INVALID_TRANSACTION') err.status = 400;
        else if (err && err.code === 'SIM_INVALID_ORDER') err.status = 400;
        else if (err && err.code === 'SIM_INVALID_INTENT') err.status = 400;
        throw err;
    }
    return { result, duplicate: false };
}

async function executeSimulatorTrade(input) {
    try { return await executeSimulatorTradeIntent(input); }
    catch (err) {
        const accountId = Number(input?.account_id);
        if (Number.isSafeInteger(accountId) && accountId > 0 && ['buy', 'sell'].includes(input?.type)) {
            const controls = require('./simulator_controls');
            try {
                await controls.transaction(async (conn) => {
                    if (!await controls.get(conn, 'SELECT id FROM simulator_sleeves WHERE id=?', [accountId])) return;
                    const active = await controls.activeRun(conn, accountId);
                    await controls.run(conn, `INSERT INTO sim_decision_events(account_id,run_id,decision_key,action,outcome,detail_json,created_at)
                        VALUES (?,?,?,?,?,?,?)`, [accountId, active?.id || null, `rejected:${require('node:crypto').randomUUID()}`,
                        input.type, 'rejected', JSON.stringify({ client_order_id: input.client_order_id ?? null, symbol: input.symbol ?? null,
                            shares: input.shares ?? null, code: err.code || 'SIM_EXECUTION_ERROR', reason: err.message }), new Date().toISOString()]);
                });
            } catch (auditError) { console.error('[simulator] rejection audit failed:', auditError.message); }
        }
        throw err;
    }
}

module.exports = {
    executeSimulatorTrade,
    executionError,
};
