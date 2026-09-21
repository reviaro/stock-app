const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');

const TEST_DB = path.join(__dirname, 'test_alpaca_day_trade_event_routes.db');
process.env.DB_PATH_OVERRIDE = TEST_DB;
process.env.ALPACA_DAY_TRADING_ENTRY_ENABLED = 'true';
process.env.ALPACA_DAY_TRADING_ENTRY_TOKEN = 'journal-token';
const db = require('../database/db');
const store = require('../services/alpaca_day_trade_store');
let server;

function request(method, requestPath, body = null, headers = {}) {
    return new Promise((resolve, reject) => {
        const data = body == null ? null : JSON.stringify(body);
        const req = http.request({ host: '127.0.0.1', port: server.address().port, path: requestPath, method, headers: {
            ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers,
        } }, (res) => {
            let text = '';
            res.on('data', (chunk) => { text += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

before(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await db.initDb();
    const app = express();
    app.use(express.json());
    app.use('/api/alpaca-paper/day-trading', require('../routes/alpaca_day_trading'));
    server = app.listen(0);
});
after(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    delete process.env.ALPACA_DAY_TRADING_ENTRY_ENABLED;
    delete process.env.ALPACA_DAY_TRADING_ENTRY_TOKEN;
});

const auth = { 'X-Alpaca-Day-Trading-Token': 'journal-token' };

test('POST /decisions records an authenticated scoped NO TRADE decision idempotently without a plan', async () => {
    const body = { account_id: 2, decision_key: '2026-09-21:nvda:opening', reason: 'setup_not_confirmed', details: { symbol: 'NVDA', api_secret: 'nope' } };
    const first = await request('POST', '/api/alpaca-paper/day-trading/decisions', body, auth);
    const replay = await request('POST', '/api/alpaca-paper/day-trading/decisions', body, auth);
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    assert.strictEqual(replay.status, 200);
    const events = await store.listEvents();
    const decision = events.find((event) => event.event_key === `decision:${body.decision_key}`);
    assert.ok(decision);
    assert.strictEqual(decision.plan_id, null);
    assert.strictEqual(decision.action, 'no_trade');
    assert.doesNotMatch(decision.detail_json, /api_secret|nope/);
});

test('POST /plans/:id/review preserves revisions and GET /journal returns sanitized analytics, trades, and chronological events', async () => {
    const { plan } = await store.createPlanWithEntry({
        symbol: 'AMD', setup: 'reclaim', catalyst: 'product launch', thesis: 'relative strength', invalidation: 'low break',
        planned_entry_low: 150, planned_entry_high: 150, planned_stop: 148, planned_target: 154,
        planned_qty: 5, planned_risk_dollars: 10, planned_reward_risk: 2, planned_account_risk_pct: 0.0001,
        exit_deadline: '2026-09-21T19:45:00.000Z',
    }, {
        idempotency_key: 'dt-amd-journal', client_order_id: 'dt-amd-journal', symbol: 'AMD', side: 'buy', qty: 5,
        order_type: 'limit', time_in_force: 'day', limit_price: 150, status: 'filled', execution_epoch: 'day_trading', order_class: 'bracket', leg_role: 'entry',
    });
    const review = await request('POST', `/api/alpaca-paper/day-trading/plans/${plan.id}/review`, {
        account_id: 2, revision_key: 'review-1', thesis_valid: true, mfe: 1.8, mae: -0.4, review_notes: 'Followed the plan.',
    }, auth);
    assert.strictEqual(review.status, 201, JSON.stringify(review.body));

    const journal = await request('GET', '/api/alpaca-paper/day-trading/journal');
    assert.strictEqual(journal.status, 200);
    assert.ok(journal.body.data.analytics);
    assert.ok(Array.isArray(journal.body.data.trades));
    assert.ok(Array.isArray(journal.body.data.events));
    assert.ok(journal.body.data.events.some((event) => event.eventType === 'review'));
    const serialized = JSON.stringify(journal.body);
    assert.doesNotMatch(serialized, /broker_order_id|brokerOrderId|client_order_id|idempotency_key|request_payload|broker_payload|api_secret/i);
});

test('mode changes are journaled with before and after values', async () => {
    const response = await request('POST', '/api/alpaca-paper/day-trading/mode', { account_id: 2, mode: 'shadow', confirm: true }, auth);
    assert.strictEqual(response.status, 200);
    const events = await store.listEvents();
    const event = events.find((row) => row.event_type === 'mode_change' && row.outcome === 'shadow');
    assert.ok(event);
    assert.deepStrictEqual(JSON.parse(event.detail_json), { from: 'disabled', to: 'shadow' });
});

test('an authenticated entry preflight refusal is journaled without private request data', async () => {
    await store.updateMonitorState({ kill_switch: true });
    const response = await request('POST', '/api/alpaca-paper/day-trading/entries', {
        account_id: 2, client_order_id: 'dt-route-refusal', symbol: 'NVDA', qty: 1,
        setup: 'breakout', catalyst: 'news', thesis: 'strength', invalidation: 'range loss',
        stop_price: 98, target_price: 104, exit_deadline: '2026-09-21T19:45:00.000Z', api_secret: 'never-log-this',
    }, auth);
    assert.strictEqual(response.status, 403);
    const event = (await store.listEvents()).find((row) => row.event_key === 'entry:dt-route-refusal:route_rejection:ALPACA_KILL_SWITCH_ACTIVE');
    assert.ok(event);
    assert.strictEqual(event.reason, 'ALPACA_KILL_SWITCH_ACTIVE');
    assert.doesNotMatch(event.detail_json, /never-log-this|api_secret/);
    await store.updateMonitorState({ kill_switch: false });
});
