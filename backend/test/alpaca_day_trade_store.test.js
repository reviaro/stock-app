const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const TEST_DB = path.join(__dirname, 'test_alpaca_day_trade_store.db');
process.env.DB_PATH_OVERRIDE = TEST_DB;
const db = require('../database/db');
const store = require('../services/alpaca_day_trade_store');

const basePlan = {
    symbol: 'NVDA',
    setup: 'opening-range breakout',
    catalyst: 'named and verified same-day catalyst',
    thesis: 'price and participation confirmation',
    invalidation: 'loss of opening range and VWAP',
    planned_entry_low: 176.0,
    planned_entry_high: 176.8,
    planned_stop: 171.25,
    planned_target: 182.0,
    planned_qty: 10,
    planned_risk_dollars: 57.5,
    planned_reward_risk: 3.2,
    planned_account_risk_pct: 0.4,
    exit_deadline: '2026-09-16T15:45:00-04:00',
};

const baseEntryOrder = {
    idempotency_key: 'dt-nvda-entry-1',
    client_order_id: 'dt-nvda-entry-1',
    symbol: 'NVDA',
    side: 'buy',
    qty: 10,
    order_type: 'limit',
    time_in_force: 'day',
    limit_price: 176.5,
    status: 'pending_submission',
    execution_epoch: 'day_trading',
    order_class: 'bracket',
    leg_role: 'entry',
};

before(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await db.initDb();
});

after(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});

beforeEach(async () => {
    const sqlite = db.getDb();
    await new Promise((resolve, reject) => sqlite.serialize(() => {
        sqlite.run('DELETE FROM alpaca_day_trade_plans');
        sqlite.run('DELETE FROM alpaca_paper_orders');
        sqlite.run('DELETE FROM alpaca_paper_fills', (err) => {
            sqlite.close();
            err ? reject(err) : resolve();
        });
    }));
});

test('allows only one nonterminal plan per symbol', async () => {
    const { plan } = await store.createPlanWithEntry(basePlan, baseEntryOrder);
    assert.strictEqual(plan.symbol, 'NVDA');
    assert.strictEqual(plan.state, 'entry_pending');

    await assert.rejects(
        () => store.createPlanWithEntry(basePlan, { ...baseEntryOrder, idempotency_key: 'dt-nvda-entry-2', client_order_id: 'dt-nvda-entry-2' }),
        /nonterminal Day Trading plan already exists/,
    );

    await store.closePlan(plan.id, { confirmedFlatQty: 0, exit_reason: 'stop_loss' });
    const reopened = await store.createPlanWithEntry(basePlan, { ...baseEntryOrder, idempotency_key: 'dt-nvda-entry-3', client_order_id: 'dt-nvda-entry-3' });
    assert.ok(reopened.plan.id > plan.id);
});

test('creates a plan and its entry order intent atomically, rolling back both on failure', async () => {
    const { plan, order } = await store.createPlanWithEntry(basePlan, baseEntryOrder);
    assert.ok(plan.id > 0);
    assert.strictEqual(order.plan_id, plan.id);
    assert.strictEqual(order.leg_role, 'entry');

    const orders = await db.listAlpacaPaperOrderAudits();
    assert.strictEqual(orders.length, 1);
    assert.strictEqual(orders[0].plan_id, plan.id);

    await assert.rejects(
        () => store.createPlanWithEntry(
            { ...basePlan, symbol: 'TSLA' },
            { ...baseEntryOrder, idempotency_key: 'dt-tsla-bad', client_order_id: 'dt-tsla-bad', side: 'sideways' },
        ),
        /invalid Alpaca paper order audit record/,
    );
    const tslaePlan = await store.getActivePlanForSymbol('TSLA');
    assert.strictEqual(tslaePlan, null);
    const allPlans = await store.listPlans();
    assert.strictEqual(allPlans.length, 1);
});

test('deduplicates fills by their Alpaca activity id regardless of delivery channel', async () => {
    const { plan, order } = await store.createPlanWithEntry(basePlan, baseEntryOrder);
    const fill = {
        activity_id: 'act-1', broker_order_id: order.idempotency_key, plan_id: plan.id,
        symbol: 'NVDA', side: 'buy', qty: 10, price: 176.52,
        executed_at: '2026-09-16T13:31:00Z', fill_type: 'fill', source: 'websocket',
    };
    await store.recordFill(fill);
    await store.recordFill({ ...fill, source: 'rest_reconciliation' });

    const fills = await store.listFillsForPlan(plan.id);
    assert.strictEqual(fills.length, 1);
    assert.strictEqual(fills[0].source, 'websocket');
});

test('aggregates partial fills into filled quantity and a volume-weighted average price', async () => {
    const { plan, order } = await store.createPlanWithEntry(basePlan, baseEntryOrder);
    await store.recordFill({
        activity_id: 'act-partial-1', broker_order_id: order.idempotency_key, plan_id: plan.id,
        symbol: 'NVDA', side: 'buy', qty: 4, price: 176.50,
        executed_at: '2026-09-16T13:30:00Z', fill_type: 'partial_fill', source: 'websocket',
    });
    await store.recordFill({
        activity_id: 'act-partial-2', broker_order_id: order.idempotency_key, plan_id: plan.id,
        symbol: 'NVDA', side: 'buy', qty: 6, price: 176.55,
        executed_at: '2026-09-16T13:30:05Z', fill_type: 'fill', source: 'websocket',
    });

    const summary = await store.computeFilledSummaryForPlan(plan.id);
    assert.strictEqual(summary.entry.qty, 10);
    assert.ok(Math.abs(summary.entry.avgPrice - 176.53) < 0.001);
});

test('keeps entry (buy) and exit (sell) fills as independent summaries on the same plan', async () => {
    const { plan, order } = await store.createPlanWithEntry(basePlan, baseEntryOrder);
    await store.recordFill({
        activity_id: 'act-entry', broker_order_id: order.idempotency_key, plan_id: plan.id,
        symbol: 'NVDA', side: 'buy', qty: 10, price: 176.50,
        executed_at: '2026-09-16T13:30:00Z', fill_type: 'fill', source: 'websocket',
    });
    await store.recordFill({
        activity_id: 'act-exit', broker_order_id: 'broker-stop-1', plan_id: plan.id,
        symbol: 'NVDA', side: 'sell', qty: 10, price: 182.00,
        executed_at: '2026-09-16T14:10:00Z', fill_type: 'fill', source: 'websocket',
    });

    const summary = await store.computeFilledSummaryForPlan(plan.id);
    assert.strictEqual(summary.entry.qty, 10);
    assert.strictEqual(summary.entry.avgPrice, 176.50);
    assert.strictEqual(summary.exit.qty, 10);
    assert.strictEqual(summary.exit.avgPrice, 182.00);
});

test('excludes busted fills and corrected fills from the effective filled summary', async () => {
    const { plan, order } = await store.createPlanWithEntry(basePlan, baseEntryOrder);
    await store.recordFill({
        activity_id: 'act-orig', broker_order_id: order.idempotency_key, plan_id: plan.id,
        symbol: 'NVDA', side: 'buy', qty: 10, price: 180.00,
        executed_at: '2026-09-16T13:30:00Z', fill_type: 'fill', source: 'websocket',
    });
    await store.recordFill({
        activity_id: 'act-correction', broker_order_id: order.idempotency_key, plan_id: plan.id,
        symbol: 'NVDA', side: 'buy', qty: 10, price: 176.50,
        executed_at: '2026-09-16T13:30:00Z', fill_type: 'fill', source: 'rest_reconciliation',
        correction_of: 'act-orig',
    });
    await store.recordFill({
        activity_id: 'act-busted', broker_order_id: order.idempotency_key, plan_id: plan.id,
        symbol: 'NVDA', side: 'buy', qty: 3, price: 999,
        executed_at: '2026-09-16T13:31:00Z', fill_type: 'fill', source: 'websocket',
        is_bust: true,
    });

    const summary = await store.computeFilledSummaryForPlan(plan.id);
    assert.strictEqual(summary.entry.qty, 10);
    assert.strictEqual(summary.entry.avgPrice, 176.50);
});

test('persists the monitor restart cursor across independent reads', async () => {
    await store.updateMonitorState({ activity_cursor: 'cursor-abc-123', mode: 'shadow' });
    const state = await store.getMonitorState();
    assert.strictEqual(state.activity_cursor, 'cursor-abc-123');
    assert.strictEqual(state.mode, 'shadow');

    await store.updateMonitorState({ last_websocket_event_at: '2026-09-16T13:32:00Z' });
    const reread = await store.getMonitorState();
    assert.strictEqual(reread.activity_cursor, 'cursor-abc-123', 'an unrelated update must not reset the restart cursor');
    assert.strictEqual(reread.last_websocket_event_at, '2026-09-16T13:32:00Z');
});

test('refuses to close a plan without an explicitly confirmed zero broker position', async () => {
    const { plan } = await store.createPlanWithEntry(basePlan, baseEntryOrder);
    await assert.rejects(
        () => store.closePlan(plan.id, { confirmedFlatQty: 3, exit_reason: 'stop_loss' }),
        /confirmed zero broker position/,
    );
    let row = await store.getPlan(plan.id);
    assert.strictEqual(row.state, 'entry_pending');

    await store.closePlan(plan.id, { confirmedFlatQty: 0, exit_reason: 'stop_loss', realized_pnl: -57.5, realized_r: -1 });
    row = await store.getPlan(plan.id);
    assert.strictEqual(row.state, 'closed');
    assert.strictEqual(row.exit_reason, 'stop_loss');
    assert.ok(row.closed_at);
});

test('refuses to close an already-closed plan a second time', async () => {
    const { plan } = await store.createPlanWithEntry(basePlan, baseEntryOrder);
    await store.closePlan(plan.id, { confirmedFlatQty: 0, exit_reason: 'stop_loss', realized_pnl: -57.5, realized_r: -1 });
    const firstClose = await store.getPlan(plan.id);

    await assert.rejects(
        () => store.closePlan(plan.id, { confirmedFlatQty: 0, exit_reason: 'take_profit', realized_pnl: 999, realized_r: 5 }),
        /already in a terminal state/,
    );

    const afterSecondAttempt = await store.getPlan(plan.id);
    assert.deepStrictEqual(afterSecondAttempt, firstClose);
});

test('the plan-update statement itself refuses to re-close an already-terminal plan, independent of any prior read', async () => {
    const { plan } = await store.createPlanWithEntry(basePlan, baseEntryOrder);
    await db.updateAlpacaDayTradePlan(plan.id, { state: 'closed', exit_reason: 'stop_loss', closed_at: '2026-09-16T14:00:00Z' });

    // Calls db.js directly, bypassing store.closePlan's own read-then-write guard, to prove
    // the UPDATE's WHERE clause is what actually prevents two concurrent "close" writers
    // (e.g. a time-exit sweep and a WebSocket fill event both concluding the plan is done)
    // from racing past a read-only pre-check and overwriting each other.
    await assert.rejects(
        () => db.updateAlpacaDayTradePlan(plan.id, { state: 'closed', exit_reason: 'take_profit', closed_at: '2026-09-16T14:05:00Z' }),
        /not found/,
    );

    const row = await store.getPlan(plan.id);
    assert.strictEqual(row.exit_reason, 'stop_loss');
    assert.strictEqual(row.closed_at, '2026-09-16T14:00:00Z');
});

test('rolls back the plan when the entry order insert fails at the SQL level', async () => {
    await db.createAlpacaPaperOrderAudit({
        idempotency_key: 'dt-preexisting-key', symbol: 'AMD', side: 'buy', qty: 1,
        order_type: 'limit', time_in_force: 'day', limit_price: 100, status: 'pending_submission',
    });

    await assert.rejects(
        () => store.createPlanWithEntry(
            { ...basePlan, symbol: 'AMD' },
            { ...baseEntryOrder, idempotency_key: 'dt-preexisting-key', client_order_id: 'dt-amd-entry-1' },
        ),
        /duplicate Alpaca paper-order idempotency key/,
    );

    const amdPlan = await store.getActivePlanForSymbol('AMD');
    assert.strictEqual(amdPlan, null);
});
