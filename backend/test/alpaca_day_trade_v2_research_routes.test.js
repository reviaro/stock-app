const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { createTestDatabase } = require('../test-support/test_database');
createTestDatabase();
const db = require('../database/db');
const store = require('../services/alpaca_day_trade_v2_store');
const legacy = require('../services/alpaca_day_trade_store');
const { createV2Router } = require('../routes/alpaca_day_trading_v2');

const OPERATOR = { type: 'session', role: 'operator' };
const AGENT = { type: 'bearer', role: 'alpaca-day-trading-agent' };
const READER = { type: 'loopback', role: 'reader' };
const INITIAL_NOW = '2025-01-10T16:00:00.000Z';
const ENTRY = '2025-01-06T15:00:00.000Z';
const EXIT = '2025-01-06T16:00:00.000Z';
const PRIVATE = /synthetic-private|broker_order_id|client_order_id|execution_id|activity_id|account_number|https?:/i;
let clock;
let broker;

function sql(statement, params = [], query = false) {
    const sqlite = db.getDb();
    return new Promise((resolve, reject) => sqlite[query ? 'all' : 'run'](statement, params, (error, rows) => {
        sqlite.close(closeError => error || closeError ? reject(error || closeError) : resolve(rows));
    }));
}
const rows = (statement, params) => sql(statement, params, true);

function fill(overrides = {}) {
    return { id: 'synthetic-private-entry-execution', order_id: 'synthetic-private-entry-order',
        activity_type: 'FILL', type: 'fill', symbol: 'XYZ', side: 'buy', qty: '10', price: '100', transaction_time: ENTRY, ...overrides };
}
function fakeBroker() {
    const state = { reads: [], activities: [fill(), fill({ id: 'synthetic-private-exit-execution', order_id: 'synthetic-private-stop-order',
        side: 'sell', price: '99', transaction_time: EXIT })], positions: [], openOrders: [], mutations: 0 };
    state.client = {
        getAccountActivities: async (bounds) => {
            state.reads.push({ method: 'activities', ...bounds });
            return state.activities.filter(activity => Date.parse(activity.transaction_time) >= Date.parse(bounds.after)
                && Date.parse(activity.transaction_time) <= Date.parse(bounds.until));
        },
        getPositions: async () => { state.reads.push({ method: 'positions' }); return state.positions; },
        getOrders: async () => { state.reads.push({ method: 'orders' }); return state.openOrders; },
        submitOrder: async () => { state.mutations += 1; throw new Error('unexpected broker mutation'); },
        cancelOrder: async () => { state.mutations += 1; throw new Error('unexpected broker mutation'); },
    };
    return state;
}

function request(server, method, requestPath, body) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? null : JSON.stringify(body);
        const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path: requestPath,
            headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, res => {
            let text = '';
            res.on('data', chunk => { text += chunk; });
            res.on('end', () => {
                let body;
                try { body = JSON.parse(text); } catch { body = null; }
                resolve({ status: res.statusCode, body, text });
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}
async function serve(auth, action) {
    const app = express();
    app.use(express.json());
    if (auth) app.use((req, _res, next) => { req.auth = auth; next(); });
    app.use('/v2', createV2Router({ store, createClient: () => broker.client, now: () => new Date(clock) }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    try { return await action(server); } finally { await new Promise(resolve => server.close(resolve)); }
}
function experiment(overrides = {}) {
    return { name: 'Prospective stall observation', setupId: 'opening_range', strategyVersion: 'v3', kind: 'stall_exit',
        parameters: { afterMinutes: 30, minimumProgressR: 0.25 }, durationDays: 14, minTrades: 30, costBps: 5, ...overrides };
}
async function seedLegacy() {
    const { plan } = await legacy.createPlanWithEntry({ symbol: 'XYZ', setup: 'synthetic breakout', catalyst: 'synthetic event', thesis: 'synthetic thesis',
        invalidation: 'synthetic threshold', planned_entry_low: 100, planned_entry_high: 100, planned_stop: 98, planned_target: 104,
        planned_qty: 10, planned_risk_dollars: 20, planned_reward_risk: 2, planned_account_risk_pct: 0.5, exit_deadline: '2025-01-06T20:45:00Z' },
    { idempotency_key: 'synthetic-private-entry-key', client_order_id: 'synthetic-private-entry-key', symbol: 'XYZ', side: 'buy', qty: 10,
        order_type: 'limit', time_in_force: 'day', limit_price: 100, status: 'filled', execution_epoch: 'day_trading', order_class: 'bracket', leg_role: 'entry' });
    await sql(`UPDATE alpaca_day_trade_plans SET entry_parent_broker_order_id = 'synthetic-private-entry-order',
        protective_stop_broker_order_id = 'synthetic-private-stop-order', created_at = ? WHERE id = ?`, [ENTRY, plan.id]);
    await legacy.recordFill({ activity_id: 'synthetic-private-entry-execution', broker_order_id: 'synthetic-private-entry-order', plan_id: plan.id,
        symbol: 'XYZ', side: 'buy', qty: 10, price: 100, executed_at: ENTRY, fill_type: 'fill', source: 'websocket' });
    return plan.id;
}
function applyBody(preview, id, extra = {}) {
    return { reviewToken: preview.body.data.reviewToken, selectedPlanIds: [id], attributionPlanIds: [], confirm: 'APPLY_HISTORY_REPAIR', ...extra };
}

before(async () => { await db.initDb(); });
beforeEach(async () => {
    const tables = ['alpaca_day_trade_events', 'alpaca_dt_v2_events', 'alpaca_dt_v2_observations', 'alpaca_dt_v2_experiments',
        'alpaca_paper_fills', 'alpaca_paper_orders', 'alpaca_day_trade_plans', 'alpaca_dt_v2_fills', 'alpaca_dt_v2_plans'];
    const triggers = await rows("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%_no_delete'");
    for (const trigger of triggers) await sql(`DROP TRIGGER ${trigger.name}`);
    for (const table of tables) await sql(`DELETE FROM ${table}`);
    for (const trigger of triggers) await sql(trigger.sql);
    await sql("UPDATE alpaca_monitor_state SET mode = 'disabled', submission_lease_holder = NULL, submission_lease_expires_at = NULL WHERE id = 1");
    await store.updateMonitorState({ mode: 'disabled', kill_switch: 0, attention_required: 0 });
    clock = INITIAL_NOW;
    broker = fakeBroker();
});

test('history and experiment writes require an operator before any broker read or database write', async () => {
    for (const auth of [undefined, READER, AGENT]) await serve(auth, async server => {
        for (const endpoint of ['/experiments', '/history/preview', '/history/apply', '/history/disable-legacy']) {
            const response = await request(server, 'POST', `/v2${endpoint}`, { ...experiment(), confirm: 'DISABLE_LEGACY' });
            assert.equal(response.status, 403, endpoint);
            assert.equal(response.body.code, 'ALPACA_V2_OPERATOR_REQUIRED');
        }
    });
    assert.equal(broker.reads.length, 0);
    assert.equal((await store.listExperiments()).length, 0);
    assert.equal((await legacy.listEvents()).length, 0);
});

test('experiments are forward registered, immutable, and readable without exposing private identifiers', async () => {
    let definition;
    await serve(OPERATOR, async server => {
        const invalid = await request(server, 'POST', '/v2/experiments', experiment({ created_at: ENTRY }));
        assert.equal(invalid.status, 400);
        const response = await request(server, 'POST', '/v2/experiments', experiment({ name: 'Study https://synthetic-private.example/api' }));
        assert.equal(response.status, 201, response.text);
        definition = response.body.data;
        assert.equal(definition.createdAt, INITIAL_NOW);
        assert.equal(definition.endsAt, '2025-01-24T16:00:00.000Z');
        assert.equal(definition.results.eligibleCount, 0);
        assert.equal(definition.results.status, 'collecting');
        assert.doesNotMatch(response.text, PRIVATE);
        assert.equal((await request(server, 'PATCH', `/v2/experiments/${definition.id}`, { costBps: 0 })).status, 404);
    });
    await assert.rejects(sql('UPDATE alpaca_dt_v2_experiments SET cost_bps = 0 WHERE id = ?', [definition.id]), /immutable/);
    await assert.rejects(sql('DELETE FROM alpaca_dt_v2_experiments WHERE id = ?', [definition.id]), /immutable/);
    await serve(READER, async server => {
        const response = await request(server, 'GET', '/v2/experiments');
        assert.equal(response.status, 200);
        assert.equal(response.body.data.experiments[0].costBps, 5);
        assert.doesNotMatch(response.text, PRIVATE);
    });
    assert.equal(broker.reads.length, 0);
});

test('history preview and apply bind ranges, fills, and flatness to server broker reads', async () => {
    const id = await seedLegacy();
    await serve(OPERATOR, async server => {
        const preview = await request(server, 'POST', '/v2/history/preview', { brokerActivities: [], coverage: { after: '1990-01-01', complete: true } });
        assert.equal(preview.status, 200, preview.text);
        assert.equal(preview.body.data.repairs[0].after.realizedPnl, -10);
        assert.equal((await legacy.getPlan(id)).state, 'entry_pending');
        assert.equal((await legacy.listEvents()).length, 0);
        assert.doesNotMatch(preview.text, PRIVATE);
        const originalRead = broker.reads.find(read => read.method === 'activities');
        assert.equal(originalRead.after, '2025-01-05T15:00:00.000Z');
        clock = '2025-01-10T16:00:20.000Z';
        const response = await request(server, 'POST', '/v2/history/apply', applyBody(preview, id, {
            brokerActivities: [fill({ price: '999' })], positions: [{ symbol: 'FAKE' }],
            coverage: { after: '1990-01-01', until: '1991-01-01', complete: true }, snapshotAt: '1991-01-01',
        }));
        assert.equal(response.status, 200, response.text);
        assert.equal(response.body.data.repairedPlanCount, 1);
        assert.equal((await legacy.getPlan(id)).realized_pnl, -10);
        const reads = broker.reads.filter(read => read.method === 'activities');
        assert.equal(reads[1].after, originalRead.after);
        assert.equal(reads[1].until, originalRead.until);
        assert.equal(reads[2].after, originalRead.until);
        assert.equal(reads[2].until, clock);
        assert.doesNotMatch(response.text, PRIVATE);
    });
    assert.equal(broker.mutations, 0);
});

test('client-provided empty positions cannot override newly open broker exposure', async () => {
    const id = await seedLegacy();
    await serve(OPERATOR, async server => {
        const preview = await request(server, 'POST', '/v2/history/preview', {});
        broker.positions = [{ symbol: 'XYZ', qty: '1' }];
        const response = await request(server, 'POST', '/v2/history/apply', applyBody(preview, id, { positions: [], openOrders: [] }));
        assert.equal(response.status, 409);
        assert.equal(response.body.code, 'ALPACA_HISTORY_BROKER_NOT_FLAT');
        assert.equal((await legacy.getPlan(id)).state, 'entry_pending');
    });
});

test('expired or unknown previews fail before fetching broker evidence', async () => {
    const id = await seedLegacy();
    await serve(OPERATOR, async server => {
        const preview = await request(server, 'POST', '/v2/history/preview', {});
        const reads = broker.reads.length;
        clock = '2025-01-10T16:05:00.000Z';
        for (const body of [applyBody(preview, id), applyBody(preview, id, { reviewToken: 'a'.repeat(64) })]) {
            const response = await request(server, 'POST', '/v2/history/apply', body);
            assert.equal(response.status, 409);
            assert.equal(response.body.code, 'ALPACA_HISTORY_STALE_PREVIEW');
        }
        assert.equal(broker.reads.length, reads);
        assert.equal((await legacy.listEvents()).length, 0);
    });
});

for (const malformed of [false, true]) test(`apply refuses ${malformed ? 'malformed' : 'new'} broker activity after the reviewed cutoff`, async () => {
    const id = await seedLegacy();
    await serve(OPERATOR, async server => {
        const preview = await request(server, 'POST', '/v2/history/preview', {});
        clock = '2025-01-10T16:00:20.000Z';
        const original = broker.client.getAccountActivities;
        broker.client.getAccountActivities = async bounds => bounds.after === INITIAL_NOW
            ? [fill({ transaction_time: malformed ? 'invalid timestamp' : '2025-01-10T16:00:10.000Z' })] : original(bounds);
        const response = await request(server, 'POST', '/v2/history/apply', applyBody(preview, id));
        assert.equal(response.status, 409, response.text);
        assert.equal(response.body.code, 'ALPACA_HISTORY_BROKER_STATE_CHANGED');
        assert.equal((await legacy.getPlan(id)).state, 'entry_pending');
        assert.equal((await legacy.listFillsForPlan(id)).length, 1);
    });
});

test('repeating pagination is bounded and cannot become complete repair evidence', async () => {
    const id = await seedLegacy();
    let pages = 0;
    broker.client.getAccountActivities = async () => { pages += 1; return Array.from({ length: 100 }, () => fill()); };
    await serve(OPERATOR, async server => {
        const preview = await request(server, 'POST', '/v2/history/preview', {});
        assert.equal(preview.status, 200);
        assert.ok(preview.body.data.applyBlockers.includes('ALPACA_HISTORY_INCOMPLETE_BROKER_HISTORY'));
        assert.equal(pages, 2);
        const response = await request(server, 'POST', '/v2/history/apply', applyBody(preview, id));
        assert.equal(response.status, 409);
        assert.equal(response.body.code, 'ALPACA_HISTORY_INCOMPLETE_BROKER_HISTORY');
        assert.equal(pages, 4);
    });
});

test('broker errors return fixed phrases without leaking raw response details', async () => {
    broker.client.getAccountActivities = async () => { throw new Error('synthetic-private account_number https://synthetic-private.example'); };
    await serve(OPERATOR, async server => {
        const response = await request(server, 'POST', '/v2/history/preview', {});
        assert.equal(response.status, 503);
        assert.equal(response.body.code, 'ALPACA_HISTORY_BROKER_UNAVAILABLE');
        assert.doesNotMatch(response.text, PRIVATE);
    });
});

test('stable metadata matching inherited object names remains valid in public analytics', async () => {
    const { plan } = await store.createPlan({ client_order_id: 'synthetic-private-v2', symbol: 'XYZ', setup: 'test', catalyst: 'test', thesis: 'test', invalidation: 'test',
        setup_id: 'constructor', strategy_version: 'toString', catalyst_class: 'constructor',
        planned_qty: 10, planned_entry_price: 100, planned_stop: 98, planned_target: 104, planned_risk_dollars: 20,
        exit_deadline: EXIT });
    await store.recordFill({ execution_id: 'synthetic-private-buy', plan_id: plan.id, order_id: 'synthetic-private-parent', symbol: 'XYZ',
        side: 'buy', role: 'entry', qty: 10, price: 100, executed_at: ENTRY, source: 'rest' });
    await store.recordFill({ execution_id: 'synthetic-private-sell', plan_id: plan.id, order_id: 'synthetic-private-stop', symbol: 'XYZ',
        side: 'sell', role: 'bracket_exit', qty: 10, price: 99, executed_at: EXIT, source: 'rest' });
    await store.updatePlan(plan.id, { state: 'closed', exit_reason: 'stop_loss', filled_entry_qty: 10, filled_exit_qty: 10,
        avg_entry_price: 100, avg_exit_price: 99, realized_pnl: -10, closed_at: EXIT });
    await serve(READER, async server => {
        const response = await request(server, 'GET', '/v2/journal');
        assert.equal(response.status, 200, response.text);
        assert.equal(response.body.data.analytics.bySetup.constructor.count, 1);
        assert.equal(response.body.data.analytics.byStrategyVersion.toString.realizedPnl, -10);
        assert.doesNotMatch(response.text, PRIVATE);
    });
});
