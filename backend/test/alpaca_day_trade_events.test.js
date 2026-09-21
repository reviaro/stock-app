const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const TEST_DB = path.join(__dirname, 'test_alpaca_day_trade_events.db');
process.env.DB_PATH_OVERRIDE = TEST_DB;
const db = require('../database/db');
const store = require('../services/alpaca_day_trade_store');
const { executeDayTradeEntry } = require('../services/alpaca_day_trade_execution');
const { recordWebSocketFill, reconcileFills } = require('../services/alpaca_fill_reconciliation');

before(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await db.initDb();
});
after(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });
beforeEach(async () => {});

test('semantic events are immutable and idempotent only for the same canonical payload', async () => {
    const input = {
        event_key: 'decision:2026-09-21:nvda:none', plan_id: null, event_type: 'strategy_decision',
        action: 'no_trade', outcome: 'skipped', reason: 'setup_not_confirmed',
        detail: { nested: { z: 2, a: 1 }, token: 'must-not-survive', broker_order_id: 'private-id' },
        occurred_at: '2026-09-21T13:30:00.000Z',
    };
    const first = await store.appendEvent(input);
    const replay = await store.appendEvent({ ...input, detail: { broker_order_id: 'different-private-id', nested: { a: 1, z: 2 }, token: 'other' } });
    assert.strictEqual(first.inserted, true);
    assert.strictEqual(replay.inserted, false);
    assert.deepStrictEqual(JSON.parse(first.event.detail_json), { nested: { a: 1, z: 2 } });

    await assert.rejects(
        () => store.appendEvent({ ...input, reason: 'different_reason' }),
        (err) => err.code === 'ALPACA_EVENT_KEY_CONFLICT',
    );

    const sqlite = db.getDb();
    await assert.rejects(() => new Promise((resolve, reject) => sqlite.run(
        "UPDATE alpaca_day_trade_events SET reason = 'tampered' WHERE event_key = ?", [input.event_key],
        (err) => err ? reject(err) : resolve(),
    )), /immutable/i);
    sqlite.close();
});

test('reviewPlan updates review fields and appends revision history atomically with idempotent revisions', async () => {
    const { plan } = await store.createPlanWithEntry({
        symbol: 'NVDA', setup: 'breakout', catalyst: 'earnings', thesis: 'momentum', invalidation: 'VWAP loss',
        planned_entry_low: 100, planned_entry_high: 100, planned_stop: 98, planned_target: 104,
        planned_qty: 10, planned_risk_dollars: 20, planned_reward_risk: 2, planned_account_risk_pct: 0.0002,
        exit_deadline: '2026-09-21T19:45:00.000Z',
    }, {
        idempotency_key: 'dt-review-plan', client_order_id: 'dt-review-plan', symbol: 'NVDA', side: 'buy', qty: 10,
        order_type: 'limit', time_in_force: 'day', limit_price: 100, status: 'filled', execution_epoch: 'day_trading',
        order_class: 'bracket', leg_role: 'entry',
    });
    const review = { revision_key: 'review-v1', thesis_valid: false, mfe: 1.5, mae: -0.8, review_notes: 'Waited too long.' };
    const first = await store.reviewPlan(plan.id, review);
    const replay = await store.reviewPlan(plan.id, review);
    assert.strictEqual(first.inserted, true);
    assert.strictEqual(replay.inserted, false);
    const reread = await store.getPlan(plan.id);
    assert.strictEqual(reread.thesis_valid, 0);
    assert.strictEqual(reread.mfe, 1.5);
    assert.strictEqual(reread.mae, -0.8);
    assert.strictEqual(reread.review_notes, 'Waited too long.');
    await assert.rejects(() => store.reviewPlan(plan.id, { ...review, review_notes: 'changed' }), (err) => err.code === 'ALPACA_EVENT_KEY_CONFLICT');
});

test('executeDayTradeEntry records intent, submission start, acknowledgement, and replay semantic events', async () => {
    const now = new Date('2026-09-21T14:00:00.000Z');
    const client = {
        getAccount: async () => ({ status: 'ACTIVE', trading_blocked: false, account_blocked: false, cash: '50000', equity: '100000' }),
        getAsset: async () => ({ class: 'us_equity', status: 'active', tradable: true }),
        getClock: async () => ({ is_open: true, next_close: '2026-09-21T20:00:00.000Z' }),
        getOrders: async () => [],
        getLatestQuote: async () => ({ symbol: 'MSFT', quote: { t: now.toISOString(), bp: 99.98, bs: 10, ap: 100, as: 10 } }),
        submitOrder: async () => ({ id: 'private-broker-id', status: 'accepted' }),
    };
    const args = {
        intent: { symbol: 'MSFT', qty: 10, setup: 'breakout', catalyst: 'news', thesis: 'strength', invalidation: 'range loss', stop_price: 98, target_price: 104, exit_deadline: '2026-09-21T19:45:00.000Z' },
        clientOrderId: 'dt-msft-event-lifecycle', client, holderId: 'test-holder', now,
        policy: { ...require('../services/alpaca_day_trade_order_policy').DEFAULT_DAY_TRADE_POLICY, entriesEnabled: true },
    };
    const first = await executeDayTradeEntry(args);
    const replay = await executeDayTradeEntry(args);
    assert.strictEqual(first.order.status, 'accepted');
    assert.strictEqual(replay.replayed, true);
    const events = await store.listEvents(first.plan.id);
    assert.deepStrictEqual(events.map((event) => event.event_type), ['entry_intent', 'entry_submission', 'entry_outcome', 'entry_replay']);
    assert.doesNotMatch(JSON.stringify(events), /private-broker-id/);
});

test('fill ingestion maps management orders through order audits and creates one semantic event across WS and REST', async () => {
    const { plan } = await store.createPlanWithEntry({
        symbol: 'TSLA', setup: 'breakout', catalyst: 'delivery report', thesis: 'strength', invalidation: 'range loss',
        planned_entry_low: 200, planned_entry_high: 200, planned_stop: 196, planned_target: 208,
        planned_qty: 4, planned_risk_dollars: 16, planned_reward_risk: 2, planned_account_risk_pct: 0.00016,
        exit_deadline: '2026-09-21T19:45:00.000Z',
    }, {
        idempotency_key: 'dt-tsla-entry-events', client_order_id: 'dt-tsla-entry-events', symbol: 'TSLA', side: 'buy', qty: 4,
        order_type: 'limit', time_in_force: 'day', limit_price: 200, status: 'filled', execution_epoch: 'day_trading', order_class: 'bracket', leg_role: 'entry',
    });
    await store.createOrderAudit({
        idempotency_key: 'dt-timeexit-tsla-events', client_order_id: 'dt-timeexit-tsla-events', symbol: 'TSLA', side: 'sell', qty: 4,
        order_type: 'market', time_in_force: 'day', status: 'accepted', execution_epoch: 'day_trading', order_class: 'simple', leg_role: 'time_exit', plan_id: plan.id,
    });
    await store.updateOrderAudit('dt-timeexit-tsla-events', { status: 'accepted', broker_order_id: 'private-management-order' });
    const fill = { activity_id: 'cross-channel-fill', broker_order_id: 'private-management-order', symbol: 'TSLA', side: 'sell', qty: 4, price: 205, executed_at: '2026-09-21T19:46:00.000Z', fill_type: 'fill', source: 'websocket' };
    const first = await recordWebSocketFill(fill, { store });
    const second = await recordWebSocketFill({ ...fill, source: 'rest_reconciliation' }, { store });
    assert.strictEqual(first.inserted, true);
    assert.strictEqual(second.inserted, false);
    const fills = await store.listFillsForPlan(plan.id);
    assert.strictEqual(fills.length, 1);
    const events = (await store.listEvents(plan.id)).filter((event) => event.event_type === 'fill');
    assert.strictEqual(events.length, 1);
    assert.doesNotMatch(events[0].detail_json, /private-management-order/);
});
