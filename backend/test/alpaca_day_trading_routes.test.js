const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');

const TEST_DB = path.join(__dirname, 'test_alpaca_day_trading_routes.db');
process.env.DB_PATH_OVERRIDE = TEST_DB;
const db = require('../database/db');
const store = require('../services/alpaca_day_trade_store');

function post(port, body, requestPath, headers = {}) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const request = http.request({
            host: '127.0.0.1', port, path: requestPath, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
        }, (response) => {
            let text = '';
            response.on('data', (chunk) => { text += chunk; });
            response.on('end', () => {
                let parsed;
                try { parsed = text ? JSON.parse(text) : null; } catch (_err) { parsed = text; }
                resolve({ status: response.statusCode, body: parsed });
            });
        });
        request.on('error', reject);
        request.end(data);
    });
}

function get(port, requestPath, headers = {}) {
    return new Promise((resolve, reject) => {
        const request = http.request({
            host: '127.0.0.1', port, path: requestPath, method: 'GET', headers,
        }, (response) => {
            let text = '';
            response.on('data', (chunk) => { text += chunk; });
            response.on('end', () => {
                let parsed;
                try { parsed = text ? JSON.parse(text) : null; } catch (_err) { parsed = text; }
                resolve({ status: response.statusCode, body: parsed });
            });
        });
        request.on('error', reject);
        request.end();
    });
}

function createApp(auth = null) {
    delete require.cache[require.resolve('../services/alpaca_paper_service')];
    delete require.cache[require.resolve('../services/alpaca_day_trade_execution')];
    delete require.cache[require.resolve('../routes/alpaca_paper')];
    delete require.cache[require.resolve('../routes/alpaca_day_trading')];
    const app = express();
    app.use(express.json());
    if (auth) app.use((req, _res, next) => { req.auth = auth; next(); });
    app.use('/api/alpaca-paper', require('../routes/alpaca_paper'));
    app.use('/api/alpaca-paper/day-trading', require('../routes/alpaca_day_trading'));
    return app;
}

async function ledgerCounts() {
    const sqlite = db.getDb();
    return new Promise((resolve, reject) => sqlite.get(
        `SELECT (SELECT COUNT(*) FROM transactions) AS portfolio_count,
                (SELECT COUNT(*) FROM sim_transactions) AS simulator_count`,
        (err, row) => { sqlite.close(); err ? reject(err) : resolve(row); },
    ));
}

before(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await db.initDb();
});
after(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });
beforeEach(async () => {
    const sqlite = db.getDb();
    await new Promise((resolve, reject) => sqlite.serialize(() => {
        sqlite.run('DELETE FROM alpaca_day_trade_plans');
        sqlite.run('DELETE FROM alpaca_paper_orders');
        sqlite.run('DELETE FROM alpaca_paper_fills');
        // last_rest_reconciliation_at defaults to "now" so existing entries tests aren't
        // incidentally exercising the new staleness gate below -- the dedicated staleness test
        // overrides this explicitly to an old value.
        sqlite.run(
            "UPDATE alpaca_monitor_state SET submission_lease_holder = NULL, submission_lease_expires_at = NULL, mode = 'disabled', kill_switch = 0, block_entries = 0, last_rest_reconciliation_at = datetime('now') WHERE id = 1",
            (err) => { sqlite.close(); err ? reject(err) : resolve(); },
        );
    }));
});

function enableDayTradingGate() {
    const saved = {
        enabled: process.env.ALPACA_DAY_TRADING_ENTRY_ENABLED,
        token: process.env.ALPACA_DAY_TRADING_ENTRY_TOKEN,
        key: process.env.ALPACA_API_KEY,
        secret: process.env.ALPACA_API_SECRET,
        fetch: global.fetch,
    };
    process.env.ALPACA_DAY_TRADING_ENTRY_ENABLED = 'true';
    process.env.ALPACA_DAY_TRADING_ENTRY_TOKEN = 'test-day-trading-token';
    process.env.ALPACA_API_KEY = 'paper-key';
    process.env.ALPACA_API_SECRET = 'paper-secret';
    return {
        restore() {
            if (saved.enabled == null) delete process.env.ALPACA_DAY_TRADING_ENTRY_ENABLED; else process.env.ALPACA_DAY_TRADING_ENTRY_ENABLED = saved.enabled;
            if (saved.token == null) delete process.env.ALPACA_DAY_TRADING_ENTRY_TOKEN; else process.env.ALPACA_DAY_TRADING_ENTRY_TOKEN = saved.token;
            if (saved.key == null) delete process.env.ALPACA_API_KEY; else process.env.ALPACA_API_KEY = saved.key;
            if (saved.secret == null) delete process.env.ALPACA_API_SECRET; else process.env.ALPACA_API_SECRET = saved.secret;
            global.fetch = saved.fetch;
        },
    };
}

function mockAlpacaBroker({
    cash = '50000.00', equity = '100000.00', openOrders = [],
    submitResult = { id: 'private-broker-order-id', status: 'accepted' }, submitError = null, submitStatus = 200,
} = {}) {
    const requests = [];
    const currentOpenOrders = [...openOrders];
    // Captured once, before any request: generating this lazily inside the fetch handler would
    // make it later than the `now` the route already captured as executeDayTradeEntry's default
    // parameter (evaluated synchronously at call time, before the quote fetch's several awaits),
    // making the quote look like it's from the future.
    const quoteTimestamp = new Date().toISOString();
    global.fetch = async (url, options = {}) => {
        requests.push({ url, options });
        if (url.endsWith('/v2/account')) {
            return { ok: true, json: async () => ({ status: 'ACTIVE', trading_blocked: false, account_blocked: false, cash, equity }) };
        }
        if (url.endsWith('/v2/assets/NVDA')) return { ok: true, json: async () => ({ class: 'us_equity', status: 'active', tradable: true }) };
        if (url.endsWith('/v2/clock')) {
            // The real /entries route never accepts a `now` override (correctly -- a live
            // request should always use real wall-clock time), so this can't be pinned to a
            // fixed calendar date the way other test files pin `now` itself: a hardcoded
            // "today" next_close silently goes stale and starts tripping the entry cutoff once
            // real time crosses it, exactly as happened mid-session in the worker tests.
            // Always 6 hours out from whenever the test actually runs instead.
            return { ok: true, json: async () => ({ is_open: true, next_close: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString() }) };
        }
        if (url.includes('/v2/orders?status=open')) return { ok: true, json: async () => currentOpenOrders };
        if (url.includes('/v2/stocks/NVDA/quotes/latest')) {
            return {
                ok: true,
                json: async () => ({
                    symbol: 'NVDA',
                    quote: { t: quoteTimestamp, bp: 99.98, bs: 2, ap: 100.00, as: 1, c: ['R'], z: 'C' },
                }),
            };
        }
        if (url.endsWith('/v2/orders') && options.method === 'POST') {
            if (submitError) throw submitError;
            if (submitStatus !== 200) return { ok: false, status: submitStatus, json: async () => ({}) };
            currentOpenOrders.push({ ...JSON.parse(options.body), status: 'accepted' });
            return { ok: true, json: async () => submitResult };
        }
        throw new Error(`unexpected broker request: ${url}`);
    };
    return { requests };
}

function fullSectionSevenIntent(overrides = {}) {
    return {
        account_id: 2,
        client_order_id: 'dt-20260917-nvda-opening-breakout-v1',
        symbol: 'NVDA',
        qty: 100,
        setup: 'opening-range breakout',
        catalyst: 'named and verified same-day catalyst',
        thesis: 'price and participation confirmation',
        invalidation: 'loss of opening range and VWAP',
        stop_price: 98.00,
        target_price: 104.00,
        exit_deadline: '2026-09-17T19:45:00.000Z',
        ...overrides,
    };
}

// The worker already refuses to act on existing plans while the switch is tripped (Task 13);
// the switch's actual purpose -- stop trading for the rest of the session -- only holds if the
// one route that starts *new* trades honors it too. Previously it only checked `mode`.
// Unlike kill_switch (a one-way trip, checked regardless of mode), block_entries and the
// monitor-liveness check only mean anything once entries could otherwise succeed at all --
// mode !== 'paper_execute' already refuses via the existing policy path (ALPACA_ENTRIES_DISABLED)
// with nothing new to add.
// If the monitor isn't actively ticking, block_entries can't be trusted -- a worker that
// crashed while block_entries happened to read false would otherwise let entries through with
// nothing watching the resulting position. Failing closed on staleness, not just on the literal
// flag, is what actually makes the flag meaningful.
test('POST /orders (the generic order route) is refused once Day Trading owns the account (mode paper_execute), without any broker request', async () => {
    const store = require('../services/alpaca_day_trade_store');
    await store.updateMonitorState({ mode: 'paper_execute' });
    const broker = mockAlpacaBroker();
    process.env.ALPACA_PAPER_ORDER_ENTRY_ENABLED = 'true';
    process.env.ALPACA_PAPER_ORDER_ENTRY_TOKEN = 'irrelevant';
    const app = createApp();
    const server = app.listen(0);
    const result = await post(
        server.address().port,
        { idempotency_key: 'buy-nvda-bypass', symbol: 'NVDA', side: 'buy', qty: 1, type: 'limit', limit_price: 100, time_in_force: 'day' },
        '/api/alpaca-paper/orders',
        { 'X-Alpaca-Paper-Order-Token': 'irrelevant' },
    );
    await new Promise((resolve) => server.close(resolve));
    delete process.env.ALPACA_PAPER_ORDER_ENTRY_ENABLED;
    delete process.env.ALPACA_PAPER_ORDER_ENTRY_TOKEN;

    assert.strictEqual(result.status, 403);
    assert.strictEqual(broker.requests.length, 0, 'the generic order route must not reach the broker once Day Trading owns the account');
});

test('POST /orders stays available while Day Trading has not taken over the account (mode not paper_execute), even if its own HTTP gate is enabled', async () => {
    const gate = enableDayTradingGate(); // enables the DT route's own token gate, not `mode`
    mockAlpacaBroker();
    process.env.ALPACA_PAPER_ORDER_ENTRY_ENABLED = 'true';
    process.env.ALPACA_PAPER_ORDER_ENTRY_TOKEN = 'paper-order-token';
    const app = createApp();
    const server = app.listen(0);
    const result = await post(
        server.address().port,
        { idempotency_key: 'buy-nvda-still-allowed', symbol: 'NVDA', side: 'buy', qty: 1, type: 'limit', limit_price: 100, time_in_force: 'day' },
        '/api/alpaca-paper/orders',
        { 'X-Alpaca-Paper-Order-Token': 'paper-order-token' },
    );
    await new Promise((resolve) => server.close(resolve));
    gate.restore();
    delete process.env.ALPACA_PAPER_ORDER_ENTRY_ENABLED;
    delete process.env.ALPACA_PAPER_ORDER_ENTRY_TOKEN;

    assert.notStrictEqual(result.status, 403, 'the DT route\'s own access gate must not, by itself, disable the unrelated generic order route');
});

function mockKillSwitchClearBroker({ positionQty = 0, legsCovered = true, activities = [] } = {}) {
    global.fetch = async (url) => {
        if (url.endsWith('/v2/clock')) {
            return { ok: true, json: async () => ({ is_open: true, next_close: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString() }) };
        }
        if (url.includes('/v2/positions/')) {
            if (positionQty === 0) return { ok: false, status: 404, json: async () => ({}) };
            return { ok: true, json: async () => ({ symbol: 'NVDA', qty: String(positionQty), side: positionQty < 0 ? 'short' : 'long' }) };
        }
        if (url.includes('/v2/orders/broker-parent-1')) {
            return {
                ok: true,
                json: async () => ({
                    id: 'broker-parent-1', status: 'filled', qty: 10, filled_qty: 10, submitted_at: '2026-09-17T13:30:00.000Z',
                    legs: legsCovered ? [
                        { id: 'stop-1', type: 'stop', side: 'sell', qty: Math.abs(positionQty) || 10, filled_qty: 0, status: 'held' },
                        { id: 'target-1', type: 'limit', side: 'sell', qty: Math.abs(positionQty) || 10, filled_qty: 0, status: 'held' },
                    ] : null,
                }),
            };
        }
        if (url.includes('/v2/account/activities/FILL')) return { ok: true, json: async () => activities };
        throw new Error(`unexpected broker request in this test: ${url}`);
    };
}

async function seedActivePlan() {
    const { plan } = await store.createPlanWithEntry(
        {
            symbol: 'NVDA', setup: 's', catalyst: 'c', thesis: 't', invalidation: 'i',
            planned_entry_low: 100.50, planned_entry_high: 100.50, planned_stop: 98.00, planned_target: 104.00,
            planned_qty: 10, planned_risk_dollars: 25, planned_reward_risk: 1.4, planned_account_risk_pct: 0.00025,
            exit_deadline: '2026-09-17T19:45:00.000Z',
        },
        {
            idempotency_key: 'dt-nvda-entry-1', client_order_id: 'dt-nvda-entry-1', symbol: 'NVDA', side: 'buy',
            qty: 10, order_type: 'limit', time_in_force: 'day', limit_price: 100.50,
            status: 'filled', execution_epoch: 'day_trading', order_class: 'bracket', leg_role: 'entry',
        },
    );
    await db.updateAlpacaDayTradePlan(plan.id, { entry_parent_broker_order_id: 'broker-parent-1' });
    return plan;
}

// --- Read routes: full dashboard visibility, no need to check Alpaca's own site ---

test('GET /day-trading/monitor-health requires only dashboard auth, no Day Trading token', async () => {
    delete process.env.ALPACA_DAY_TRADING_ENTRY_ENABLED;
    delete process.env.ALPACA_DAY_TRADING_ENTRY_TOKEN;
    await store.updateMonitorState({ mode: 'shadow', kill_switch: true, health_code: 'STALE_RECONCILIATION', health_error: 'too old' });
    const app = createApp();
    const server = app.listen(0);
    const result = await get(server.address().port, '/api/alpaca-paper/day-trading/monitor-health');
    await new Promise((resolve) => server.close(resolve));

    assert.strictEqual(result.status, 200, JSON.stringify(result.body));
    assert.strictEqual(result.body.data.mode, 'shadow');
    assert.strictEqual(result.body.data.killSwitch, true);
    assert.strictEqual(result.body.data.healthCode, 'STALE_RECONCILIATION');
});

test('GET /day-trading/monitor-health never contacts the broker, so it stays answerable during an outage', async () => {
    await store.updateMonitorState({ mode: 'shadow' });
    global.fetch = async (url) => { throw new Error(`must never be called: ${url}`); };
    const app = createApp();
    const server = app.listen(0);
    const result = await get(server.address().port, '/api/alpaca-paper/day-trading/monitor-health');
    await new Promise((resolve) => server.close(resolve));

    assert.strictEqual(result.status, 200, JSON.stringify(result.body));
});

function mockSnapshotBroker({
    cash = '50000.00', equity = '100000.00', positions = [],
} = {}) {
    process.env.ALPACA_API_KEY = 'paper-key';
    process.env.ALPACA_API_SECRET = 'paper-secret';
    global.fetch = async (url) => {
        if (url.endsWith('/v2/account')) return { ok: true, json: async () => ({ status: 'ACTIVE', cash, equity, buying_power: '200000.00' }) };
        if (url.endsWith('/v2/clock')) return { ok: true, json: async () => ({ is_open: true, timestamp: '2026-09-17T14:00:00Z', next_open: '2026-09-18T13:30:00Z', next_close: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString() }) };
        if (url.endsWith('/v2/positions')) return { ok: true, json: async () => positions };
        throw new Error(`unexpected broker request in this test: ${url}`);
    };
}

test('GET /day-trading/snapshot requires only dashboard auth', async () => {
    mockSnapshotBroker();
    const app = createApp();
    const server = app.listen(0);
    const result = await get(server.address().port, '/api/alpaca-paper/day-trading/snapshot');
    await new Promise((resolve) => server.close(resolve));

    assert.strictEqual(result.status, 200, JSON.stringify(result.body));
    assert.strictEqual(result.body.data.account.cash, '50000.00');
    assert.strictEqual(result.body.data.clock.isOpen, true);
});

test('GET /day-trading/snapshot flags a broker position with no matching plan as untracked', async () => {
    mockSnapshotBroker({
        positions: [{ symbol: 'AAPL', qty: '3', avg_entry_price: '200', current_price: '205', market_value: '615', unrealized_pl: '15', unrealized_plpc: '0.024', side: 'long' }],
    });
    const app = createApp();
    const server = app.listen(0);
    const result = await get(server.address().port, '/api/alpaca-paper/day-trading/snapshot');
    await new Promise((resolve) => server.close(resolve));

    assert.strictEqual(result.status, 200, JSON.stringify(result.body));
    assert.strictEqual(result.body.data.positions.length, 1);
    assert.strictEqual(result.body.data.positions[0].tracked, false, 'a position with no matching nonterminal plan must be flagged untracked, not rendered as if managed');
});

test('GET /day-trading/snapshot flags a broker position matching an active plan as tracked, with its plan id', async () => {
    const plan = await seedActivePlan();
    mockSnapshotBroker({
        positions: [{ symbol: 'NVDA', qty: '10', avg_entry_price: '100.50', current_price: '101', market_value: '1010', unrealized_pl: '5', unrealized_plpc: '0.005', side: 'long' }],
    });
    const app = createApp();
    const server = app.listen(0);
    const result = await get(server.address().port, '/api/alpaca-paper/day-trading/snapshot');
    await new Promise((resolve) => server.close(resolve));

    assert.strictEqual(result.status, 200, JSON.stringify(result.body));
    assert.strictEqual(result.body.data.positions[0].tracked, true);
    assert.strictEqual(result.body.data.positions[0].planId, plan.id);
});

test('GET /day-trading/snapshot includes a risk block computed against equity, with the account-2 policy limits for reference', async () => {
    await seedActivePlan();
    mockSnapshotBroker();
    const app = createApp();
    const server = app.listen(0);
    const result = await get(server.address().port, '/api/alpaca-paper/day-trading/snapshot');
    await new Promise((resolve) => server.close(resolve));

    assert.strictEqual(result.status, 200, JSON.stringify(result.body));
    const { risk } = result.body.data;
    assert.strictEqual(risk.totalOpenRiskDollars, 25);
    assert.strictEqual(risk.totalOpenRiskPct, 0.00025);
    assert.deepStrictEqual(risk.limits, {
        maxPositionPct: 0.25, minCashPct: 0.10, maxRiskPerTradePct: 0.01, maxTotalOpenRiskPct: 0.02, maxDailyLossPct: 0.02,
    });
});

test('GET /day-trading/snapshot reports daily P&L as unavailable, honestly, when the session date has never been recorded', async () => {
    await seedActivePlan();
    mockSnapshotBroker();
    const app = createApp();
    const server = app.listen(0);
    const result = await get(server.address().port, '/api/alpaca-paper/day-trading/snapshot');
    await new Promise((resolve) => server.close(resolve));

    assert.strictEqual(result.status, 200, JSON.stringify(result.body));
    assert.strictEqual(result.body.data.risk.dailyRealizedPnl, null);
    assert.ok(result.body.data.risk.dailyPnlUnavailableReason);
});

test('GET /day-trading/snapshot never leaks broker order ids or credentials', async () => {
    await seedActivePlan();
    mockSnapshotBroker({
        positions: [{ symbol: 'NVDA', qty: '10', avg_entry_price: '100.50', current_price: '101', market_value: '1010', unrealized_pl: '5', unrealized_plpc: '0.005', side: 'long' }],
    });
    process.env.ALPACA_API_KEY = 'paper-key';
    process.env.ALPACA_API_SECRET = 'paper-secret';
    const app = createApp();
    const server = app.listen(0);
    const result = await get(server.address().port, '/api/alpaca-paper/day-trading/snapshot');
    await new Promise((resolve) => server.close(resolve));

    assert.strictEqual(result.status, 200, JSON.stringify(result.body));
    assert.doesNotMatch(JSON.stringify(result.body), /broker-parent-1|paper-key|paper-secret/i);
});

test('GET /day-trading/plans lists plans with their cached fill summary and realized outcome', async () => {
    const plan = await seedActivePlan();
    await db.updateAlpacaDayTradePlan(plan.id, {
        state: 'closed', exit_reason: 'stop_loss', realized_pnl: -25, realized_r: -1,
        filled_entry_qty: 10, avg_entry_price: 100.50, filled_exit_qty: 10, avg_exit_price: 98.00,
        closed_at: '2026-09-17T14:00:00Z',
    });
    const app = createApp();
    const server = app.listen(0);
    const result = await get(server.address().port, '/api/alpaca-paper/day-trading/plans');
    await new Promise((resolve) => server.close(resolve));

    assert.strictEqual(result.status, 200, JSON.stringify(result.body));
    assert.strictEqual(result.body.data.length, 1);
    assert.strictEqual(result.body.data[0].symbol, 'NVDA');
    assert.strictEqual(result.body.data[0].realizedPnl, -25);
    assert.strictEqual(result.body.data[0].exitReason, 'stop_loss');
});

test('GET /day-trading/plans filters by state', async () => {
    await seedActivePlan();
    const app = createApp();
    const server = app.listen(0);
    const openResult = await get(server.address().port, '/api/alpaca-paper/day-trading/plans?state=entry_pending');
    const closedResult = await get(server.address().port, '/api/alpaca-paper/day-trading/plans?state=closed');
    await new Promise((resolve) => server.close(resolve));

    assert.strictEqual(openResult.body.data.length, 1);
    assert.strictEqual(closedResult.body.data.length, 0);
});

test('GET /day-trading/plans/:id returns full detail including the fill history', async () => {
    const plan = await seedActivePlan();
    await store.recordFill({
        activity_id: 'fill-1', plan_id: plan.id, broker_order_id: 'broker-parent-1', symbol: 'NVDA',
        side: 'buy', qty: 10, price: 100.50, executed_at: '2026-09-17T13:31:00Z', fill_type: 'fill', source: 'rest_reconciliation',
    });
    const app = createApp();
    const server = app.listen(0);
    const result = await get(server.address().port, `/api/alpaca-paper/day-trading/plans/${plan.id}`);
    await new Promise((resolve) => server.close(resolve));

    assert.strictEqual(result.status, 200, JSON.stringify(result.body));
    assert.strictEqual(result.body.data.plan.symbol, 'NVDA');
    assert.strictEqual(result.body.data.fills.length, 1);
    assert.strictEqual(result.body.data.fills[0].price, 100.50);
});

test('GET /day-trading/plans/:id returns 404 for an unknown plan', async () => {
    const app = createApp();
    const server = app.listen(0);
    const result = await get(server.address().port, '/api/alpaca-paper/day-trading/plans/999999');
    await new Promise((resolve) => server.close(resolve));

    assert.strictEqual(result.status, 404);
});

test('GET /day-trading/plans/:id includes the live entry/stop/target order legs for a nonterminal plan', async () => {
    const plan = await seedActivePlan();
    mockKillSwitchClearBroker({ positionQty: 10, legsCovered: true });
    process.env.ALPACA_API_KEY = 'paper-key';
    process.env.ALPACA_API_SECRET = 'paper-secret';
    const app = createApp();
    const server = app.listen(0);
    const result = await get(server.address().port, `/api/alpaca-paper/day-trading/plans/${plan.id}`);
    await new Promise((resolve) => server.close(resolve));

    assert.strictEqual(result.status, 200, JSON.stringify(result.body));
    const { liveOrders } = result.body.data;
    assert.strictEqual(liveOrders.unavailable, false);
    assert.strictEqual(liveOrders.entry.status, 'filled');
    assert.strictEqual(liveOrders.entry.filledQty, 10);
    assert.strictEqual(liveOrders.stopLeg.status, 'held');
    assert.strictEqual(liveOrders.targetLeg.status, 'held');
});

test('GET /day-trading/plans/:id reports live orders as unavailable, not silently absent, when the broker cannot be reached', async () => {
    const plan = await seedActivePlan();
    process.env.ALPACA_API_KEY = 'paper-key';
    process.env.ALPACA_API_SECRET = 'paper-secret';
    global.fetch = async () => { throw new Error('network down'); };
    const app = createApp();
    const server = app.listen(0);
    const result = await get(server.address().port, `/api/alpaca-paper/day-trading/plans/${plan.id}`);
    await new Promise((resolve) => server.close(resolve));

    assert.strictEqual(result.status, 200, JSON.stringify(result.body));
    assert.strictEqual(result.body.data.liveOrders.unavailable, true);
});

test('GET /day-trading/plans/:id has no live orders for a terminal plan, and never calls the broker for one', async () => {
    const plan = await seedActivePlan();
    await db.updateAlpacaDayTradePlan(plan.id, { state: 'closed', closed_at: '2026-09-17T14:00:00Z' });
    global.fetch = async (url) => { throw new Error(`unexpected broker request in this test: ${url}`); };
    const app = createApp();
    const server = app.listen(0);
    const result = await get(server.address().port, `/api/alpaca-paper/day-trading/plans/${plan.id}`);
    await new Promise((resolve) => server.close(resolve));

    assert.strictEqual(result.status, 200, JSON.stringify(result.body));
    assert.strictEqual(result.body.data.liveOrders, null);
});

test('GET /day-trading/plans/:id never leaks the broker order id through live order legs', async () => {
    const plan = await seedActivePlan();
    mockKillSwitchClearBroker({ positionQty: 10, legsCovered: true });
    process.env.ALPACA_API_KEY = 'paper-key';
    process.env.ALPACA_API_SECRET = 'paper-secret';
    const app = createApp();
    const server = app.listen(0);
    const result = await get(server.address().port, `/api/alpaca-paper/day-trading/plans/${plan.id}`);
    await new Promise((resolve) => server.close(resolve));

    assert.strictEqual(result.status, 200, JSON.stringify(result.body));
    assert.doesNotMatch(JSON.stringify(result.body), /broker-parent-1|stop-1|target-1/);
});

test('GET /day-trading/journal returns analytics computed from closed plans', async () => {
    const plan = await seedActivePlan();
    await db.updateAlpacaDayTradePlan(plan.id, {
        state: 'closed', exit_reason: 'take_profit', realized_pnl: 35, realized_r: 1.4, closed_at: '2026-09-17T15:00:00Z',
    });
    const app = createApp();
    const server = app.listen(0);
    const result = await get(server.address().port, '/api/alpaca-paper/day-trading/journal');
    await new Promise((resolve) => server.close(resolve));

    assert.strictEqual(result.status, 200, JSON.stringify(result.body));
    assert.strictEqual(result.body.data.analytics.closed_trade_count, 1);
    assert.strictEqual(result.body.data.analytics.total_pnl, 35);
    assert.ok(Array.isArray(result.body.data.trades));
    assert.ok(Array.isArray(result.body.data.events));
});

// v2 retirement boundary: every v1 mutation is refused with one explicit code, and none of
// them may construct a broker client or reach fetch -- even with every legacy gate open and an
// authenticated operator session.
const V1_RETIRED_POSTS = [
    ['/api/alpaca-paper/day-trading/entries', () => fullSectionSevenIntent()],
    ['/api/alpaca-paper/day-trading/decisions', () => ({ account_id: 2, decision_key: 'retired-check', reason: 'x' })],
    ['/api/alpaca-paper/day-trading/mode', () => ({ mode: 'paper_execute', confirm: true })],
    ['/api/alpaca-paper/day-trading/resolve-missing', () => ({ idempotency_key: 'k', confirm_not_found: true })],
    ['/api/alpaca-paper/day-trading/kill-switch/clear', () => ({ confirm: true })],
    ['/api/alpaca-paper/day-trading/plans/1/review', () => ({ account_id: 2, revision_key: 'r', thesis_valid: true })],
];

for (const [requestPath, body] of V1_RETIRED_POSTS) {
    test(`v1 POST ${requestPath} is retired (ALPACA_V1_RETIRED) and never contacts the broker`, async () => {
        const gate = enableDayTradingGate();
        const broker = mockAlpacaBroker();
        const app = createApp({ type: 'session', role: 'operator', username: 'op' });
        const server = app.listen(0);
        const result = await post(server.address().port, body(), requestPath, { 'X-Alpaca-Day-Trading-Token': 'test-day-trading-token' });
        await new Promise((resolve) => server.close(resolve));
        gate.restore();

        assert.strictEqual(result.status, 410, JSON.stringify(result.body));
        assert.strictEqual(result.body.code, 'ALPACA_V1_RETIRED');
        assert.strictEqual(broker.requests.length, 0, 'a retired v1 route must never reach the broker');
        const state = await store.getMonitorState();
        assert.strictEqual(state.mode, 'disabled', 'a retired v1 route must not write monitor state');
        assert.strictEqual(Boolean(state.kill_switch), false);
    });
}

test('v1 read-only history GETs stay available after retirement', async () => {
    const app = createApp();
    const server = app.listen(0);
    const [plans, journal, health] = await Promise.all([
        get(server.address().port, '/api/alpaca-paper/day-trading/plans'),
        get(server.address().port, '/api/alpaca-paper/day-trading/journal'),
        get(server.address().port, '/api/alpaca-paper/day-trading/monitor-health'),
    ]);
    await new Promise((resolve) => server.close(resolve));
    assert.strictEqual(plans.status, 200);
    assert.strictEqual(journal.status, 200);
    assert.strictEqual(health.status, 200);
});
