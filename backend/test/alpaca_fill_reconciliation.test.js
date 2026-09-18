const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const TEST_DB = path.join(__dirname, 'test_alpaca_fill_reconciliation.db');
process.env.DB_PATH_OVERRIDE = TEST_DB;
const db = require('../database/db');
const store = require('../services/alpaca_day_trade_store');
const {
    normalizeRestFillActivity,
    normalizeWebSocketFillEvent,
    discoverProtectiveLegs,
    reconcileFills,
    buildObservation,
    recordWebSocketFill,
} = require('../services/alpaca_fill_reconciliation');

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
        sqlite.run(
            "UPDATE alpaca_monitor_state SET submission_lease_holder = NULL, submission_lease_expires_at = NULL, activity_cursor = NULL, last_rest_reconciliation_at = NULL, health_code = NULL, health_error = NULL WHERE id = 1",
            (err) => { sqlite.close(); err ? reject(err) : resolve(); },
        );
    }));
});

const basePlan = {
    symbol: 'NVDA', setup: 'opening-range breakout', catalyst: 'catalyst', thesis: 'thesis', invalidation: 'invalidation',
    planned_entry_low: 100.50, planned_entry_high: 100.50, planned_stop: 98.00, planned_target: 104.00,
    planned_qty: 10, planned_risk_dollars: 25, planned_reward_risk: 1.4, planned_account_risk_pct: 0.00025,
    exit_deadline: '2026-09-17T19:45:00.000Z',
};

const baseEntryOrder = {
    idempotency_key: 'dt-nvda-entry-1', client_order_id: 'dt-nvda-entry-1',
    symbol: 'NVDA', side: 'buy', qty: 10, order_type: 'limit', time_in_force: 'day', limit_price: 100.50,
    stop_price: 98.00, take_profit_price: 104.00,
    status: 'filled', execution_epoch: 'day_trading', order_class: 'bracket', leg_role: 'entry',
};

async function seedPlanWithEntry(overrides = {}) {
    const { plan, order } = await store.createPlanWithEntry(
        { ...basePlan, ...(overrides.plan || {}) },
        { ...baseEntryOrder, ...(overrides.order || {}) },
    );
    await db.updateAlpacaDayTradePlan(plan.id, { entry_parent_broker_order_id: 'broker-parent-1' });
    return { plan: { ...plan, entry_parent_broker_order_id: 'broker-parent-1' }, order };
}

test('normalizeRestFillActivity maps Alpaca\'s FILL activity fields to the canonical fill shape', () => {
    const fill = normalizeRestFillActivity({
        id: '20260917-fill-1', order_id: 'broker-parent-1', symbol: 'nvda', side: 'buy',
        qty: '10', price: '100.49', transaction_time: '2026-09-17T13:31:00Z', type: 'fill',
    });
    assert.deepStrictEqual(fill, {
        activity_id: '20260917-fill-1', broker_order_id: 'broker-parent-1', symbol: 'NVDA', side: 'buy',
        qty: 10, price: 100.49, executed_at: '2026-09-17T13:31:00Z', fill_type: 'fill', source: 'rest_reconciliation',
    });
});

test('normalizeRestFillActivity marks a partial_fill activity distinctly from a full fill', () => {
    const fill = normalizeRestFillActivity({
        id: 'fill-2', order_id: 'broker-parent-1', symbol: 'NVDA', side: 'buy',
        qty: '4', price: '100.49', transaction_time: '2026-09-17T13:31:05Z', type: 'partial_fill',
    });
    assert.strictEqual(fill.fill_type, 'partial_fill');
});

test('normalizeWebSocketFillEvent maps a trade_updates fill event to the same canonical shape', () => {
    const fill = normalizeWebSocketFillEvent({
        event: 'fill', execution_id: '20260917-fill-1',
        order: { id: 'broker-parent-1', symbol: 'NVDA', side: 'buy' },
        price: '100.49', qty: '10', position_qty: '10', timestamp: '2026-09-17T13:31:00Z',
    });
    assert.deepStrictEqual(fill, {
        activity_id: '20260917-fill-1', broker_order_id: 'broker-parent-1', symbol: 'NVDA', side: 'buy',
        qty: 10, price: 100.49, executed_at: '2026-09-17T13:31:00Z', fill_type: 'fill', source: 'websocket',
    });
});

test('normalizeWebSocketFillEvent returns null for a non-fill trade_updates event', () => {
    assert.strictEqual(normalizeWebSocketFillEvent({ event: 'canceled', order: {} }), null);
});

test('the same execution delivered by both channels produces exactly one stored fill', async () => {
    const { plan } = await seedPlanWithEntry();
    const restShaped = normalizeRestFillActivity({
        id: 'shared-execution-1', order_id: 'broker-parent-1', symbol: 'NVDA', side: 'buy',
        qty: '10', price: '100.49', transaction_time: '2026-09-17T13:31:00Z', type: 'fill',
    });
    const wsShaped = normalizeWebSocketFillEvent({
        event: 'fill', execution_id: 'shared-execution-1',
        order: { id: 'broker-parent-1', symbol: 'NVDA', side: 'buy' },
        price: '100.49', qty: '10', position_qty: '10', timestamp: '2026-09-17T13:31:00Z',
    });

    await store.recordFill({ ...wsShaped, plan_id: plan.id });
    await store.recordFill({ ...restShaped, plan_id: plan.id });

    const fills = await store.listFillsForPlan(plan.id);
    assert.strictEqual(fills.length, 1);
    assert.strictEqual(fills[0].source, 'websocket', 'first delivery wins; the later duplicate must not overwrite it');
});

test('Alpaca REST composite activity ids dedupe against the WebSocket execution id', async () => {
    const { plan } = await seedPlanWithEntry();
    const executionId = '9a049121-8591-402a-988a-99557c0c1610';
    const wsShaped = normalizeWebSocketFillEvent({
        event: 'fill', execution_id: executionId,
        order: { id: 'broker-parent-1', symbol: 'NVDA', side: 'buy' },
        price: '100.49', qty: '10', position_qty: '10', timestamp: '2026-09-18T17:12:05.250715853Z',
    });
    const restShaped = normalizeRestFillActivity({
        id: `20260918131205250::${executionId}`,
        order_id: 'broker-parent-1', symbol: 'NVDA', side: 'buy', qty: '10', price: '100.49',
        transaction_time: '2026-09-18T17:12:05.250716Z', type: 'fill',
    });

    await store.recordFill({ ...wsShaped, plan_id: plan.id });
    await store.recordFill({ ...restShaped, plan_id: plan.id });

    const fills = await store.listFillsForPlan(plan.id);
    assert.strictEqual(restShaped.activity_id, executionId);
    assert.strictEqual(fills.length, 1);
    assert.strictEqual(fills[0].activity_id, executionId);
    assert.strictEqual(fills[0].source, 'websocket');
});

test('REST activity ids preserve malformed or undocumented composite prefixes verbatim', () => {
    const executionId = '9a049121-8591-402a-988a-99557c0c1610';
    for (const id of [`not-a-timestamp::${executionId}`, `20260918::${executionId}`]) {
        const fill = normalizeRestFillActivity({
            id, order_id: 'broker-parent-1', symbol: 'NVDA', side: 'buy',
            qty: '10', price: '100.49', transaction_time: '2026-09-18T17:12:05.250716Z', type: 'fill',
        });
        assert.strictEqual(fill.activity_id, id);
    }
});

test('cross-channel deduplication is symmetric when REST arrives before WebSocket', async () => {
    const { plan } = await seedPlanWithEntry();
    const executionId = '9a049121-8591-402a-988a-99557c0c1610';
    const restShaped = normalizeRestFillActivity({
        id: `20260918131205250::${executionId}`,
        order_id: 'broker-parent-1', symbol: 'NVDA', side: 'buy', qty: '10', price: '100.49',
        transaction_time: '2026-09-18T17:12:05.250716Z', type: 'fill',
    });
    const wsShaped = normalizeWebSocketFillEvent({
        event: 'fill', execution_id: executionId,
        order: { id: 'broker-parent-1', symbol: 'NVDA', side: 'buy' },
        price: '100.49', qty: '10', position_qty: '10', timestamp: '2026-09-18T17:12:05.250715853Z',
    });

    await store.recordFill({ ...restShaped, plan_id: plan.id });
    await store.recordFill({ ...wsShaped, plan_id: plan.id });

    const fills = await store.listFillsForPlan(plan.id);
    assert.strictEqual(fills.length, 1);
    assert.strictEqual(fills[0].activity_id, executionId);
    assert.strictEqual(fills[0].source, 'rest_reconciliation', 'first delivery wins without later overwrite');
});

// The path a live trade_updates event actually takes: already normalized by the stream module
// before this is ever called, so this owns only what reconcileFills' own REST loop does inline
// for each activity -- the legacy-order skip and the owning-plan lookup -- reusing those exact
// helpers rather than a second implementation that could drift from the REST path's rules.
test('recordWebSocketFill records a normalized event against its owning plan', async () => {
    const { plan } = await seedPlanWithEntry();
    const normalized = normalizeWebSocketFillEvent({
        event: 'fill', execution_id: 'ws-execution-1',
        order: { id: 'broker-parent-1', symbol: 'NVDA', side: 'buy' },
        price: '100.49', qty: '10', position_qty: '10', timestamp: '2026-09-17T13:31:00Z',
    });

    const result = await recordWebSocketFill(normalized, { store });
    assert.strictEqual(result.recorded, true);

    const fills = await store.listFillsForPlan(plan.id);
    assert.strictEqual(fills.length, 1);
    assert.strictEqual(fills[0].source, 'websocket');
    assert.strictEqual(fills[0].activity_id, 'ws-execution-1');
});

test('recordWebSocketFill never records a legacy (non-Day-Trading) order\'s event', async () => {
    await store.createOrderAudit({
        idempotency_key: 'ltr-legacy-1', symbol: 'AAPL', side: 'buy', qty: 5,
        order_type: 'limit', time_in_force: 'day', limit_price: 190, status: 'pending_submission', execution_epoch: 'legacy_long_term',
    });
    await db.updateAlpacaPaperOrderAudit('ltr-legacy-1', { status: 'filled', broker_order_id: 'broker-legacy-1' });
    const normalized = normalizeWebSocketFillEvent({
        event: 'fill', execution_id: 'ws-execution-legacy-1',
        order: { id: 'broker-legacy-1', symbol: 'AAPL', side: 'buy' },
        price: '190', qty: '5', position_qty: '5', timestamp: '2026-09-17T13:31:00Z',
    });

    const result = await recordWebSocketFill(normalized, { store });
    assert.strictEqual(result.recorded, false);

    const audits = await store.listOrderAudits();
    const legacyAudit = audits.find((a) => a.broker_order_id === 'broker-legacy-1');
    assert.ok(legacyAudit, 'sanity: the legacy audit row exists');
});

test('discoverProtectiveLegs persists the stop and target broker order ids from a nested bracket lookup', async () => {
    const { plan } = await seedPlanWithEntry();
    const client = {
        getOrder: async (id, opts) => {
            assert.strictEqual(id, 'broker-parent-1');
            assert.deepStrictEqual(opts, { nested: true });
            return {
                id: 'broker-parent-1',
                legs: [
                    { id: 'broker-stop-1', type: 'stop', side: 'sell', status: 'held' },
                    { id: 'broker-target-1', type: 'limit', side: 'sell', status: 'held' },
                ],
            };
        },
    };

    const result = await discoverProtectiveLegs(plan, { client });
    assert.strictEqual(result.protective_stop_broker_order_id, 'broker-stop-1');
    assert.strictEqual(result.protective_target_broker_order_id, 'broker-target-1');

    const reread = await store.getPlan(plan.id);
    assert.strictEqual(reread.protective_stop_broker_order_id, 'broker-stop-1');
    assert.strictEqual(reread.protective_target_broker_order_id, 'broker-target-1');
});

test('discoverProtectiveLegs leaves the plan unresolved (not a false "no legs") when legs is still null', async () => {
    const { plan } = await seedPlanWithEntry();
    const client = { getOrder: async () => ({ id: 'broker-parent-1', legs: null }) };

    const result = await discoverProtectiveLegs(plan, { client });
    assert.strictEqual(result, null);

    const reread = await store.getPlan(plan.id);
    assert.strictEqual(reread.protective_stop_broker_order_id, null);
    assert.strictEqual(reread.protective_target_broker_order_id, null);
});

test('reconcileFills imports partial then full entry fills with a correct volume-weighted average', async () => {
    const { plan } = await seedPlanWithEntry();
    const client = {
        getOrder: async () => ({ id: 'broker-parent-1', legs: [
            { id: 'broker-stop-1', type: 'stop', side: 'sell' },
            { id: 'broker-target-1', type: 'limit', side: 'sell' },
        ] }),
        getAccountActivities: async () => [
            { id: 'fill-a', order_id: 'broker-parent-1', symbol: 'NVDA', side: 'buy', qty: '4', price: '100.40', transaction_time: '2026-09-17T13:31:00Z', type: 'partial_fill' },
            { id: 'fill-b', order_id: 'broker-parent-1', symbol: 'NVDA', side: 'buy', qty: '6', price: '100.60', transaction_time: '2026-09-17T13:31:05Z', type: 'fill' },
        ],
        getPosition: async () => ({ symbol: 'NVDA', side: 'long', qty: '10' }),
    };

    await reconcileFills({ client, store });

    const summary = await store.computeFilledSummaryForPlan(plan.id);
    assert.strictEqual(summary.entry.qty, 10);
    // (4*100.40 + 6*100.60) / 10 = 100.52
    assert.strictEqual(summary.entry.avgPrice, 100.52);
});

test('reconcileFills maps a stop-loss exit fill to exit_reason stop_loss and computes realized P&L/R', async () => {
    const { plan } = await seedPlanWithEntry();
    const client = {
        getOrder: async () => ({ id: 'broker-parent-1', legs: [
            { id: 'broker-stop-1', type: 'stop', side: 'sell' },
            { id: 'broker-target-1', type: 'limit', side: 'sell' },
        ] }),
        getAccountActivities: async () => [
            { id: 'fill-entry', order_id: 'broker-parent-1', symbol: 'NVDA', side: 'buy', qty: '10', price: '100.50', transaction_time: '2026-09-17T13:31:00Z', type: 'fill' },
            { id: 'fill-exit', order_id: 'broker-stop-1', symbol: 'NVDA', side: 'sell', qty: '10', price: '98.00', transaction_time: '2026-09-17T14:00:00Z', type: 'fill' },
        ],
        getPosition: async () => null, // flat: the stop fully closed the position
    };

    await reconcileFills({ client, store });

    const closed = await store.getPlan(plan.id);
    assert.strictEqual(closed.state, 'closed');
    assert.strictEqual(closed.exit_reason, 'stop_loss');
    // (98.00 - 100.50) * 10 = -25
    assert.strictEqual(closed.realized_pnl, -25);
    assert.strictEqual(closed.realized_r, -1);
});

test('reconcileFills maps a take-profit exit fill to exit_reason take_profit', async () => {
    const { plan } = await seedPlanWithEntry();
    const client = {
        getOrder: async () => ({ id: 'broker-parent-1', legs: [
            { id: 'broker-stop-1', type: 'stop', side: 'sell' },
            { id: 'broker-target-1', type: 'limit', side: 'sell' },
        ] }),
        getAccountActivities: async () => [
            { id: 'fill-entry', order_id: 'broker-parent-1', symbol: 'NVDA', side: 'buy', qty: '10', price: '100.50', transaction_time: '2026-09-17T13:31:00Z', type: 'fill' },
            { id: 'fill-exit', order_id: 'broker-target-1', symbol: 'NVDA', side: 'sell', qty: '10', price: '104.00', transaction_time: '2026-09-17T15:00:00Z', type: 'fill' },
        ],
        getPosition: async () => null,
    };

    await reconcileFills({ client, store });

    const closed = await store.getPlan(plan.id);
    assert.strictEqual(closed.exit_reason, 'take_profit');
    assert.strictEqual(closed.realized_pnl, 35);
});

test('reconcileFills does not close the plan while the broker still reports a nonzero position (no premature close)', async () => {
    const { plan } = await seedPlanWithEntry();
    const client = {
        getOrder: async () => ({ id: 'broker-parent-1', legs: [
            { id: 'broker-stop-1', type: 'stop', side: 'sell' },
            { id: 'broker-target-1', type: 'limit', side: 'sell' },
        ] }),
        getAccountActivities: async () => [
            { id: 'fill-entry', order_id: 'broker-parent-1', symbol: 'NVDA', side: 'buy', qty: '10', price: '100.50', transaction_time: '2026-09-17T13:31:00Z', type: 'fill' },
            { id: 'fill-exit-partial', order_id: 'broker-stop-1', symbol: 'NVDA', side: 'sell', qty: '4', price: '98.00', transaction_time: '2026-09-17T14:00:00Z', type: 'partial_fill' },
        ],
        getPosition: async () => ({ symbol: 'NVDA', side: 'long', qty: '6' }), // still 6 shares open
    };

    await reconcileFills({ client, store });

    const stillOpen = await store.getPlan(plan.id);
    assert.notStrictEqual(stillOpen.state, 'closed');
});

test('reconcileFills excludes a busted fill from the realized P&L calculation', async () => {
    const { plan } = await seedPlanWithEntry();
    await store.recordFill({
        activity_id: 'fill-entry', plan_id: plan.id, broker_order_id: 'broker-parent-1', symbol: 'NVDA',
        side: 'buy', qty: 10, price: 100.50, executed_at: '2026-09-17T13:31:00Z', fill_type: 'fill', source: 'rest_reconciliation',
    });
    // A hypothetical busted duplicate report of the same exit at the wrong price -- neither
    // documented Alpaca feed currently marks a fill this way; this proves the pass-through
    // columns are honored by the journal calculation if something (e.g. manual operator
    // correction) ever sets them, not that either feed can produce them automatically today.
    await store.recordFill({
        activity_id: 'fill-exit-busted', plan_id: plan.id, broker_order_id: 'broker-stop-1', symbol: 'NVDA',
        side: 'sell', qty: 10, price: 50.00, executed_at: '2026-09-17T13:59:00Z', fill_type: 'fill', source: 'rest_reconciliation', is_bust: true,
    });
    await store.recordFill({
        activity_id: 'fill-exit-real', plan_id: plan.id, broker_order_id: 'broker-stop-1', symbol: 'NVDA',
        side: 'sell', qty: 10, price: 98.00, executed_at: '2026-09-17T14:00:00Z', fill_type: 'fill', source: 'rest_reconciliation',
    });

    const client = {
        getOrder: async () => ({ id: 'broker-parent-1', legs: [
            { id: 'broker-stop-1', type: 'stop', side: 'sell' },
            { id: 'broker-target-1', type: 'limit', side: 'sell' },
        ] }),
        getAccountActivities: async () => [],
        getPosition: async () => null,
    };

    await reconcileFills({ client, store });

    const closed = await store.getPlan(plan.id);
    assert.strictEqual(closed.realized_pnl, -25, 'the busted fill at price 50 must not affect the realized P&L');
});

test('reconcileFills keeps an unresolved fill (unknown order id) on record and does not lose it past the cursor', async () => {
    const { plan } = await seedPlanWithEntry();
    const client = {
        getOrder: async () => ({ id: 'broker-parent-1', legs: [
            { id: 'broker-stop-1', type: 'stop', side: 'sell' },
            { id: 'broker-target-1', type: 'limit', side: 'sell' },
        ] }),
        getAccountActivities: async () => [
            { id: 'fill-entry', order_id: 'broker-parent-1', symbol: 'NVDA', side: 'buy', qty: '10', price: '100.50', transaction_time: '2026-09-17T13:31:00Z', type: 'fill' },
            { id: 'fill-unknown', order_id: 'broker-order-nobody-recognizes', symbol: 'NVDA', side: 'sell', qty: '3', price: '99.00', transaction_time: '2026-09-17T13:32:00Z', type: 'fill' },
        ],
        getPosition: async () => ({ symbol: 'NVDA', side: 'long', qty: '10' }),
    };

    await reconcileFills({ client, store });

    const fills = await store.listFillsForPlan(plan.id);
    assert.strictEqual(fills.length, 1, 'only the linkable fill belongs to this plan');

    const sqlite = db.getDb();
    const orphan = await new Promise((resolve, reject) => sqlite.get(
        'SELECT * FROM alpaca_paper_fills WHERE activity_id = ?', ['fill-unknown'],
        (err, row) => { sqlite.close(); err ? reject(err) : resolve(row); },
    ));
    assert.ok(orphan, 'the unlinkable fill must still be recorded, with plan_id null, not dropped');
    assert.strictEqual(orphan.plan_id, null);
});

test('reconcileFills stops advancing the cursor at the first activity that fails to normalize, so a re-run can recover it', async () => {
    const { plan } = await seedPlanWithEntry();
    const activities = [
        { id: 'fill-good-1', order_id: 'broker-parent-1', symbol: 'NVDA', side: 'buy', qty: '4', price: '100.40', transaction_time: '2026-09-17T13:31:00Z', type: 'partial_fill' },
        { id: 'fill-malformed', order_id: 'broker-parent-1', symbol: 'NVDA', side: 'buy', qty: 'not-a-number', price: '100.60', transaction_time: '2026-09-17T13:31:05Z', type: 'fill' },
        { id: 'fill-good-2', order_id: 'broker-parent-1', symbol: 'NVDA', side: 'buy', qty: '6', price: '100.60', transaction_time: '2026-09-17T13:31:10Z', type: 'fill' },
    ];
    const client = {
        getOrder: async () => ({ id: 'broker-parent-1', legs: [
            { id: 'broker-stop-1', type: 'stop', side: 'sell' },
            { id: 'broker-target-1', type: 'limit', side: 'sell' },
        ] }),
        getAccountActivities: async () => activities,
        getPosition: async () => ({ symbol: 'NVDA', side: 'long', qty: '4' }),
    };

    await reconcileFills({ client, store });

    const summary = await store.computeFilledSummaryForPlan(plan.id);
    assert.strictEqual(summary.entry.qty, 4, 'only the activity before the malformed one was imported');

    const state = await store.getMonitorState();
    assert.strictEqual(state.activity_cursor, '2026-09-17T13:31:00Z', 'the cursor must not pass the malformed activity');
    assert.strictEqual(state.health_code, 'RECONCILIATION_STALLED', 'an aborted pass must be observable, not just inferable from a stopped cursor');
    assert.strictEqual(state.last_rest_reconciliation_at, null, 'a stalled pass must not be recorded as a successful reconciliation');

    // A re-run (e.g. after an operator fixes/skips the bad record upstream) must still see
    // fill-good-2, which it would not if the cursor had advanced past it.
    activities.splice(1, 1); // remove the malformed one, simulating the upstream fix
    await reconcileFills({ client, store });
    const secondSummary = await store.computeFilledSummaryForPlan(plan.id);
    assert.strictEqual(secondSummary.entry.qty, 10);

    const healthyState = await store.getMonitorState();
    assert.strictEqual(healthyState.health_code, null, 'a clean completed pass must clear a prior stalled health code');
    assert.ok(healthyState.last_rest_reconciliation_at, 'a clean completed pass must refresh the reconciliation timestamp');
});

test('reconcileFills refreshes last_rest_reconciliation_at even when there are zero new activities to import', async () => {
    await seedPlanWithEntry();
    const client = {
        getOrder: async () => ({ id: 'broker-parent-1', legs: [] }),
        getAccountActivities: async () => [], // a quiet period: nothing new since the last check
        getPosition: async () => null,
    };

    const before = await store.getMonitorState();
    assert.strictEqual(before.last_rest_reconciliation_at, null);

    await reconcileFills({ client, store });

    const after = await store.getMonitorState();
    assert.ok(after.last_rest_reconciliation_at, 'checking and finding nothing new is still a successful reconciliation');
    assert.strictEqual(after.health_code, null);
});

test('an overfilled plan is moved to error and does not stall reconciliation for other plans', async () => {
    const { plan: badPlan } = await seedPlanWithEntry({
        order: { idempotency_key: 'dt-nvda-entry-1', client_order_id: 'dt-nvda-entry-1' },
    });
    await db.updateAlpacaDayTradePlan(badPlan.id, { entry_parent_broker_order_id: 'broker-parent-1' });
    // Corrupt the fill history directly: more entry qty than the plan ever ordered.
    await store.recordFill({
        activity_id: 'overfill-1', plan_id: badPlan.id, broker_order_id: 'broker-parent-1', symbol: 'NVDA',
        side: 'buy', qty: 999, price: 100.50, executed_at: '2026-09-17T13:31:00Z', fill_type: 'fill', source: 'rest_reconciliation',
    });

    const { plan: goodPlan } = await seedPlanWithEntry({
        plan: { symbol: 'MSFT' },
        order: {
            idempotency_key: 'dt-msft-entry-1', client_order_id: 'dt-msft-entry-1', symbol: 'MSFT',
        },
    });
    await db.updateAlpacaDayTradePlan(goodPlan.id, { entry_parent_broker_order_id: 'broker-parent-2' });

    const client = {
        getOrder: async (id) => ({ id, legs: [
            { id: `${id}-stop`, type: 'stop', side: 'sell' },
            { id: `${id}-target`, type: 'limit', side: 'sell' },
        ] }),
        getAccountActivities: async () => [
            { id: 'good-entry', order_id: 'broker-parent-2', symbol: 'MSFT', side: 'buy', qty: '10', price: '100.50', transaction_time: '2026-09-17T13:31:00Z', type: 'fill' },
            { id: 'good-exit', order_id: 'broker-parent-2-stop', symbol: 'MSFT', side: 'sell', qty: '10', price: '98.00', transaction_time: '2026-09-17T14:00:00Z', type: 'fill' },
        ],
        getPosition: async () => null,
    };

    await reconcileFills({ client, store });

    const rereadBad = await store.getPlan(badPlan.id);
    assert.strictEqual(rereadBad.state, 'error');
    assert.match(rereadBad.review_notes, /exceed the planned quantity/i);

    const rereadGood = await store.getPlan(goodPlan.id);
    assert.strictEqual(rereadGood.state, 'closed', 'the good plan must still close despite the other plan\'s corruption');
});

test('a partial exit closes with a volume-weighted exit price once a later pass confirms the position is flat', async () => {
    const { plan } = await seedPlanWithEntry();
    let position = { symbol: 'NVDA', side: 'long', qty: '6' };
    const client = {
        getOrder: async () => ({ id: 'broker-parent-1', legs: [
            { id: 'broker-stop-1', type: 'stop', side: 'sell' },
            { id: 'broker-target-1', type: 'limit', side: 'sell' },
        ] }),
        getAccountActivities: async () => [
            { id: 'fill-entry', order_id: 'broker-parent-1', symbol: 'NVDA', side: 'buy', qty: '10', price: '100.50', transaction_time: '2026-09-17T13:31:00Z', type: 'fill' },
            { id: 'fill-exit-1', order_id: 'broker-stop-1', symbol: 'NVDA', side: 'sell', qty: '4', price: '98.00', transaction_time: '2026-09-17T14:00:00Z', type: 'partial_fill' },
        ],
        getPosition: async () => position,
    };

    await reconcileFills({ client, store });
    let stillOpen = await store.getPlan(plan.id);
    assert.notStrictEqual(stillOpen.state, 'closed');

    // Second pass: the remainder fills at a different price, and the broker now confirms flat.
    client.getAccountActivities = async () => [
        { id: 'fill-entry', order_id: 'broker-parent-1', symbol: 'NVDA', side: 'buy', qty: '10', price: '100.50', transaction_time: '2026-09-17T13:31:00Z', type: 'fill' },
        { id: 'fill-exit-1', order_id: 'broker-stop-1', symbol: 'NVDA', side: 'sell', qty: '4', price: '98.00', transaction_time: '2026-09-17T14:00:00Z', type: 'partial_fill' },
        { id: 'fill-exit-2', order_id: 'broker-stop-1', symbol: 'NVDA', side: 'sell', qty: '6', price: '97.50', transaction_time: '2026-09-17T14:00:05Z', type: 'fill' },
    ];
    position = null;

    await reconcileFills({ client, store });
    const closed = await store.getPlan(plan.id);
    assert.strictEqual(closed.state, 'closed');
    assert.strictEqual(closed.exit_reason, 'stop_loss');
    // (4*98.00 + 6*97.50) / 10 = 97.70; pnl = (97.70 - 100.50) * 10 = -28
    assert.strictEqual(closed.avg_exit_price, 97.70);
    assert.strictEqual(closed.realized_pnl, -28);
});

test('reconcileFills never processes a legacy (non-Day-Trading) order\'s activity', async () => {
    await db.createAlpacaPaperOrderAudit({
        idempotency_key: 'ltr-legacy-1', symbol: 'AAPL', side: 'buy', qty: 5, order_type: 'limit',
        time_in_force: 'day', limit_price: 200, status: 'pending_submission', execution_epoch: 'legacy_long_term',
    });
    await db.updateAlpacaPaperOrderAudit('ltr-legacy-1', { status: 'filled', broker_order_id: 'legacy-broker-order-1' });
    const client = {
        getOrder: async () => ({ id: 'broker-parent-1', legs: [
            { id: 'broker-stop-1', type: 'stop', side: 'sell' },
            { id: 'broker-target-1', type: 'limit', side: 'sell' },
        ] }),
        getAccountActivities: async () => [
            { id: 'legacy-fill-1', order_id: 'legacy-broker-order-1', symbol: 'AAPL', side: 'buy', qty: '5', price: '200.00', transaction_time: '2026-09-17T13:31:00Z', type: 'fill' },
        ],
        getPosition: async () => null,
    };

    await reconcileFills({ client, store });

    const sqlite = db.getDb();
    const row = await new Promise((resolve, reject) => sqlite.get(
        'SELECT * FROM alpaca_paper_fills WHERE activity_id = ?', ['legacy-fill-1'],
        (err, r) => { sqlite.close(); err ? reject(err) : resolve(r); },
    ));
    assert.strictEqual(row, undefined, 'a legacy execution-epoch order\'s activity must never be imported');
});

test('buildObservation assembles a fresh per-tick observation from the broker, splitting legs by type', async () => {
    const { plan } = await seedPlanWithEntry();
    const client = {
        getClock: async () => ({ is_open: true, next_close: '2026-09-17T20:00:00.000Z' }),
        getPosition: async () => ({ qty: 10, side: 'long' }),
        getOrder: async (id, opts) => {
            assert.strictEqual(id, 'broker-parent-1');
            assert.deepStrictEqual(opts, { nested: true });
            return {
                id, status: 'filled', qty: 10, filled_qty: 10, submitted_at: '2026-09-17T13:30:00.000Z',
                legs: [
                    { id: 'broker-stop-1', type: 'stop', side: 'sell', qty: 10, filled_qty: 0, status: 'held' },
                    { id: 'broker-target-1', type: 'limit', side: 'sell', qty: 10, filled_qty: 0, status: 'held' },
                ],
            };
        },
    };
    const now = () => new Date('2026-09-17T14:00:00.000Z');

    const observation = await buildObservation(plan, { client, policy: { some: 'policy' }, now });

    assert.strictEqual(observation.brokerUnavailable, false);
    assert.strictEqual(observation.position.qty, 10);
    assert.strictEqual(observation.entryOrder.status, 'filled');
    assert.strictEqual(observation.entryOrder.filled_qty, 10);
    assert.strictEqual(observation.stopLeg.id, 'broker-stop-1');
    assert.strictEqual(observation.targetLeg.id, 'broker-target-1');
    assert.strictEqual(observation.clock.is_open, true);
    assert.deepStrictEqual(observation.now, now());
    assert.deepStrictEqual(observation.policy, { some: 'policy' });
});

test('buildObservation fails closed (brokerUnavailable: true) when any broker call throws, without crashing', async () => {
    const { plan } = await seedPlanWithEntry();
    const client = {
        getClock: async () => ({ is_open: true, next_close: '2026-09-17T20:00:00.000Z' }),
        getPosition: async () => { throw new Error('network blip'); },
        getOrder: async () => ({ id: 'broker-parent-1', legs: [] }),
    };
    const logs = [];

    const observation = await buildObservation(plan, {
        client, policy: {}, now: () => new Date('2026-09-17T14:00:00.000Z'), log: (entry) => logs.push(entry),
    });

    assert.strictEqual(observation.brokerUnavailable, true);
    assert.strictEqual(observation.position, null);
    assert.strictEqual(logs.length, 1, 'the caught error must be logged, not silently swallowed');
    assert.match(logs[0].observationError, /network blip/);
});
