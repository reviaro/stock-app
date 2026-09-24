const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');

const TEST_DB = path.join(__dirname, 'test_alpaca_day_trade_v2_analytics.db');
process.env.DB_PATH_OVERRIDE = TEST_DB;
const db = require('../database/db');
const store = require('../services/alpaca_day_trade_v2_store');
const { computeV2Analytics, PRELIMINARY_SAMPLE_SIZE } = require('../services/alpaca_day_trade_v2_analytics');

function plan(overrides) {
    return {
        id: 1, symbol: 'NVDA', setup: 'orb', catalyst: 'Earnings', state: 'closed', exit_reason: 'take_profit',
        planned_risk_dollars: 25, realized_pnl: 0, realized_r: 0, opened_at: '2026-09-23T13:45:00.000Z', closed_at: '2026-09-23T14:15:00.000Z',
        ...overrides,
    };
}

const PLANS = [
    plan({ id: 1, realized_pnl: 36, realized_r: 1.44 }),
    plan({ id: 2, catalyst: ' earnings ', exit_reason: 'stop_loss', realized_pnl: -25, realized_r: -1, opened_at: '2026-09-23T15:00:00.000Z', closed_at: '2026-09-23T15:30:00.000Z' }),
    plan({ id: 3, setup: 'vwap reclaim', catalyst: 'upgrade', exit_reason: 'time_exit', realized_pnl: -10, realized_r: -0.4, opened_at: '2026-09-23T18:30:00.000Z', closed_at: '2026-09-23T19:30:00.000Z' }),
    plan({ id: 4, state: 'active', realized_pnl: null, realized_r: null, closed_at: null }),
    plan({ id: 5, exit_reason: 'operator_resolved', realized_pnl: 100, realized_r: 4 }),
    plan({ id: 6, state: 'cancelled', exit_reason: null, realized_pnl: null, realized_r: null, opened_at: null }),
];

const EVENTS = [
    { event_type: 'decision', reason_code: 'NO_SETUP', occurred_at: '2026-09-23T13:40:00.000Z' },
    { event_type: 'decision', reason_code: 'NO_SETUP', occurred_at: '2026-09-23T14:40:00.000Z' },
    { event_type: 'decision', reason_code: 'SPREAD_TOO_WIDE', occurred_at: '2026-09-23T15:40:00.000Z' },
    { event_type: 'anomaly', reason_code: 'CANCEL_TIMEOUT', occurred_at: '2026-09-23T19:31:00.000Z' },
    { event_type: 'fill', reason_code: null, occurred_at: '2026-09-23T13:45:00.000Z' },
];

test('exact P&L and R figures over closed v2 trades only', () => {
    const a = computeV2Analytics({ plans: PLANS, events: EVENTS });
    assert.strictEqual(a.closedTradeCount, 3);
    assert.strictEqual(a.wins, 1);
    assert.strictEqual(a.losses, 2);
    assert.strictEqual(a.winRate, 0.3333);
    assert.strictEqual(a.grossProfit, 36);
    assert.strictEqual(a.grossLoss, 35);
    assert.strictEqual(a.profitFactor, 1.0286);
    assert.strictEqual(a.averageWin, 36);
    assert.strictEqual(a.averageLoss, -17.5);
    assert.strictEqual(a.expectancyDollars, 0.33);
    assert.strictEqual(a.expectancyR, 0.0133);
    assert.strictEqual(a.realizedPnl, 1);
    assert.strictEqual(a.maxConsecutiveLosses, 2);
    assert.strictEqual(a.averageHoldMinutes, 40);
});

test('profit factor is null, not Infinity, with no losing trades; an empty sample yields nulls', () => {
    const onlyWin = computeV2Analytics({ plans: [plan({ realized_pnl: 10, realized_r: 0.4 })], events: [] });
    assert.strictEqual(onlyWin.profitFactor, null);
    const empty = computeV2Analytics({ plans: [], events: [] });
    assert.strictEqual(empty.closedTradeCount, 0);
    assert.strictEqual(empty.winRate, null);
    assert.strictEqual(empty.expectancyDollars, null);
    assert.strictEqual(empty.expectancyR, null);
});

test('breakdowns by setup, catalyst class, time window, and session date exclude unclosed and operator-resolved plans', () => {
    const a = computeV2Analytics({ plans: PLANS, events: EVENTS });
    assert.deepStrictEqual(Object.keys(a.bySetup).sort(), ['orb', 'vwap reclaim']);
    assert.strictEqual(a.bySetup.orb.count, 2);
    assert.strictEqual(a.bySetup.orb.realizedPnl, 11);
    assert.strictEqual(a.bySetup.orb.winRate, 0.5);
    assert.strictEqual(a.bySetup.orb.expectancyR, 0.22);
    assert.strictEqual(a.byCatalyst.earnings.count, 2);
    assert.deepStrictEqual(Object.fromEntries(Object.entries(a.byWindow).map(([k, v]) => [k, v.count])), { open: 1, midday: 1, late: 1 });
    assert.strictEqual(a.bySessionDate['2026-09-23'].count, 3);
});

test('NO TRADE decisions and attention incidents are reported separately and never touch trade expectancy', () => {
    const a = computeV2Analytics({ plans: PLANS, events: EVENTS });
    assert.deepStrictEqual(a.noTrade, { count: 3, byReason: { NO_SETUP: 2, SPREAD_TOO_WIDE: 1 } });
    assert.deepStrictEqual(a.attention, { count: 1, byCode: { CANCEL_TIMEOUT: 1 } });
    const withoutEvents = computeV2Analytics({ plans: PLANS, events: [] });
    assert.strictEqual(withoutEvents.expectancyDollars, a.expectancyDollars);
    assert.strictEqual(withoutEvents.closedTradeCount, a.closedTradeCount);
    assert.strictEqual(a.excludedOperatorResolved, 1);
});

test('the sample is flagged preliminary until it is large enough, with an explicit warning', () => {
    const a = computeV2Analytics({ plans: PLANS, events: EVENTS });
    assert.ok(PRELIMINARY_SAMPLE_SIZE >= 30);
    assert.strictEqual(a.sample.preliminary, true);
    assert.match(a.sample.note, /preliminary/i);
    const many = Array.from({ length: PRELIMINARY_SAMPLE_SIZE }, (_, i) => plan({ id: i + 1, realized_pnl: 1, realized_r: 0.04 }));
    assert.strictEqual(computeV2Analytics({ plans: many, events: [] }).sample.preliminary, false);
});

// ---- journal route integration: v1 data never reaches v2 analytics ----

let server;
before(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await db.initDb();
    const app = express();
    app.use(express.json());
    app.use('/v2', require('../routes/alpaca_day_trading_v2').createV2Router({ store, createClient: () => { throw new Error('no broker'); } }));
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
});
after(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});

function get(p) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: server.address().port, path: p }, (res) => {
            let text = '';
            res.on('data', (c) => { text += c; });
            res.on('end', () => resolve(JSON.parse(text)));
        }).on('error', reject);
    });
}

test('the v2 journal analytics exclude closed v1 history and unclosed v2 plans', async () => {
    const v1 = require('../services/alpaca_day_trade_store');
    const { plan: legacy } = await v1.createPlanWithEntry(
        { symbol: 'AMD', setup: 'orb', catalyst: 'c', thesis: 't', invalidation: 'i', planned_entry_low: 10, planned_entry_high: 10, planned_stop: 9, planned_target: 12, planned_qty: 1, planned_risk_dollars: 1, planned_reward_risk: 2, planned_account_risk_pct: 0.001, exit_deadline: '2026-09-17T19:45:00.000Z' },
        { idempotency_key: 'dt-legacy-1', client_order_id: 'dt-legacy-1', symbol: 'AMD', side: 'buy', qty: 1, order_type: 'limit', time_in_force: 'day', limit_price: 10, status: 'filled', execution_epoch: 'day_trading', order_class: 'bracket', leg_role: 'entry' },
    );
    await db.updateAlpacaDayTradePlan(legacy.id, { state: 'closed', realized_pnl: 500, realized_r: 5 });

    const { plan: open } = await store.createPlan({
        client_order_id: 'dt2-20260923-nvda-orb', symbol: 'NVDA', setup: 'orb', catalyst: 'c', thesis: 't', invalidation: 'i',
        planned_qty: 10, planned_entry_price: 100.5, planned_stop: 98, planned_target: 104, planned_risk_dollars: 25, exit_deadline: '2026-09-23T19:30:00.000Z',
    });
    assert.ok(open.id);
    const journal = await get('/v2/journal');
    assert.strictEqual(journal.status, 'success');
    assert.strictEqual(journal.data.analytics.closedTradeCount, 0);
    assert.strictEqual(journal.data.analytics.realizedPnl, 0);
});
