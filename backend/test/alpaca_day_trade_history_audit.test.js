const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createTestDatabase } = require('../test-support/test_database');
createTestDatabase();
const db = require('../database/db');
const store = require('../services/alpaca_day_trade_store');
const { attemptCloseFromFills } = require('../services/alpaca_day_trade_journal');
const { computeJournalAnalytics } = require('../services/trade_journal');
const { createHistoryAuditService, collectBrokerHistory, effectiveV1HistoryFills } = require('../services/alpaca_day_trade_history_audit');

const NOW = new Date('2025-01-10T16:00:00.000Z');
const ENTRY = '2025-01-06T15:00:00.000Z';
const EXIT = '2025-01-06T16:00:00.000Z';
const EXECUTION = '10000000-0000-4000-8000-000000000001';
const EXIT_EXECUTION = '10000000-0000-4000-8000-000000000002';
const service = createHistoryAuditService({ now: () => NOW });

function exec(sql, params = []) {
    const sqlite = db.getDb();
    return new Promise((resolve, reject) => sqlite.run(sql, params, error => sqlite.close(closeError => error || closeError ? reject(error || closeError) : resolve())));
}
function all(sql, params = []) {
    const sqlite = db.getDb();
    return new Promise((resolve, reject) => sqlite.all(sql, params, (error, rows) => sqlite.close(closeError => error || closeError ? reject(error || closeError) : resolve(rows))));
}
function activity(overrides = {}) {
    return { id: EXECUTION, activity_type: 'FILL', order_id: 'example-entry', symbol: 'XYZ', side: 'buy', qty: '10', price: '100', transaction_time: ENTRY, type: 'fill', ...overrides };
}
function evidence(overrides = {}) {
    return { brokerActivities: [activity(), activity({ id: EXIT_EXECUTION, order_id: 'example-stop', side: 'sell', price: '99', transaction_time: EXIT })],
        coverage: { after: '2025-01-05T00:00:00.000Z', until: NOW.toISOString(), complete: true },
        positions: [], openOrders: [], snapshotAt: NOW.toISOString(), ...overrides };
}
async function seed({ entry = true } = {}) {
    const { plan } = await store.createPlanWithEntry({ symbol: 'XYZ', setup: 'test breakout', catalyst: 'synthetic event', thesis: 'synthetic thesis',
        invalidation: 'synthetic threshold', planned_entry_low: 100, planned_entry_high: 100, planned_stop: 98, planned_target: 104,
        planned_qty: 10, planned_risk_dollars: 20, planned_reward_risk: 2, planned_account_risk_pct: 0.5, exit_deadline: '2025-01-06T20:45:00Z' },
    { idempotency_key: 'example-entry-key', client_order_id: 'example-entry-key', symbol: 'XYZ', side: 'buy', qty: 10,
        order_type: 'limit', time_in_force: 'day', limit_price: 100, status: 'filled', execution_epoch: 'day_trading', order_class: 'bracket', leg_role: 'entry' });
    await exec(`UPDATE alpaca_day_trade_plans SET entry_parent_broker_order_id = 'example-entry', protective_stop_broker_order_id = 'example-stop',
        protective_target_broker_order_id = 'example-target', created_at = ?, opened_at = NULL WHERE id = ?`, [ENTRY, plan.id]);
    if (entry) await localFill(plan.id);
    return plan.id;
}
async function localFill(planId, overrides = {}) {
    return store.recordFill({ activity_id: EXECUTION, broker_order_id: 'example-entry', plan_id: planId,
        symbol: 'XYZ', side: 'buy', qty: 10, price: 100, executed_at: ENTRY, fill_type: 'fill', source: 'websocket', ...overrides });
}
function request(preview, planId, facts = evidence(), overrides = {}) {
    return { ...facts, reviewToken: preview.reviewToken, selectedPlanIds: [planId], attributionPlanIds: [], confirm: 'APPLY_HISTORY_REPAIR', ...overrides };
}

before(async () => { await db.initDb(); });
beforeEach(async () => {
    await exec('DROP TRIGGER IF EXISTS test_history_failure');
    for (const table of ['alpaca_day_trade_events', 'alpaca_dt_v2_events']) {
        await exec(`DROP TRIGGER IF EXISTS ${table}_no_delete`);
        await exec(`DELETE FROM ${table}`);
        await exec(`CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'immutable'); END`);
    }
    for (const table of ['alpaca_paper_fills', 'alpaca_paper_orders', 'alpaca_day_trade_plans', 'alpaca_dt_v2_fills', 'alpaca_dt_v2_plans']) await exec(`DELETE FROM ${table}`);
    await exec("UPDATE alpaca_monitor_state SET mode = 'disabled', submission_lease_holder = NULL, submission_lease_expires_at = NULL WHERE id = 1");
    await exec("UPDATE alpaca_dt_v2_monitor_state SET mode = 'disabled' WHERE id = 1");
});

test('preview is read-only and explicit apply atomically imports a known exit, repairs caches, and journals the decision', async () => {
    const id = await seed();
    const preview = await service.preview(evidence());
    assert.equal(preview.repairs.length, 1);
    assert.equal(preview.repairs[0].requiresAttributionReview, false);
    assert.equal(preview.repairs[0].after.realizedPnl, -10);
    assert.equal(preview.repairs[0].after.exitReason, 'stop_loss');
    assert.equal((await store.getPlan(id)).state, 'entry_pending');
    assert.equal((await store.listFillsForPlan(id)).length, 1);
    assert.equal((await store.listEvents()).length, 0);
    const result = await service.apply(request(preview, id));
    assert.equal(result.repairedPlanCount, 1);
    assert.equal(result.importedFillCount, 1);
    const repaired = await store.getPlan(id);
    assert.equal(repaired.state, 'closed');
    assert.equal(repaired.opened_at, ENTRY);
    assert.equal(repaired.closed_at, EXIT);
    assert.equal(repaired.filled_entry_qty, 10);
    assert.equal(repaired.filled_exit_qty, 10);
    assert.equal(repaired.realized_pnl, -10);
    assert.equal((await store.listEvents()).length, 2);
    assert.equal((await service.apply(request(preview, id))).replayed, true);
    assert.equal((await store.listFillsForPlan(id)).length, 2);
});

test('unknown-order ownership requires a separate explicit selection and leaves the exit reason unknown', async () => {
    const id = await seed();
    const facts = evidence(); facts.brokerActivities[1].order_id = 'unrecorded-order';
    const preview = await service.preview(facts);
    assert.equal(preview.repairs[0].requiresAttributionReview, true);
    assert.equal(preview.repairs[0].after.exitReason, null);
    await assert.rejects(service.apply(request(preview, id, facts)), { code: 'ALPACA_HISTORY_ATTRIBUTION_CONFIRMATION_REQUIRED' });
    await service.apply(request(preview, id, facts, { attributionPlanIds: [id] }));
    assert.equal((await store.getPlan(id)).exit_reason, null);
    assert.match((await store.listEvents(id))[0].detail_json, /operator_confirmed/);
});

test('prior or overlapping same-symbol exposure prevents inferred ownership', async () => {
    await seed();
    const facts = evidence(); facts.brokerActivities[1].order_id = 'unrecorded-order';
    facts.brokerActivities.unshift(activity({ id: 'earlier-execution', order_id: 'earlier-order', transaction_time: '2025-01-05T16:00:00Z' }));
    const preview = await service.preview(facts);
    assert.equal(preview.repairs.length, 0);
    assert.ok(preview.issues.some(issue => issue.code === 'PRIOR_SYMBOL_EXPOSURE_REVIEW_REQUIRED'));
});

test('intervening unknown buys and incomplete round trips are not repair candidates', async () => {
    await seed();
    const facts = evidence();
    facts.brokerActivities.splice(1, 0, activity({ id: 'other-buy', order_id: 'other-entry', qty: '1', transaction_time: '2025-01-06T15:30:00Z' }));
    assert.equal((await service.preview(facts)).repairs.length, 0);
    assert.equal((await service.preview(evidence({ brokerActivities: [activity()] }))).repairs.length, 0);
});

test('an exit already ingested by v2 cannot be attributed to legacy history without a v2 order link', async () => {
    await seed();
    const facts = evidence(); facts.brokerActivities[1].order_id = 'unrecorded-order';
    await exec(`INSERT INTO alpaca_dt_v2_fills (execution_id, order_id, symbol, side, qty, price, executed_at, source)
        VALUES (?, 'unrecorded-order', 'XYZ', 'sell', 10, 99, ?, 'rest')`, [EXIT_EXECUTION, EXIT]);
    const preview = await service.preview(facts);
    assert.equal(preview.repairs.length, 0);
    assert.ok(preview.issues.some(issue => issue.code === 'AMBIGUOUS_OR_UNBALANCED_HISTORY'));
});

test('a balanced prefix cannot hide additional known-order or plan-linked executions', async () => {
    const id = await seed();
    const extra = activity({ id: 'later-exit', order_id: 'example-stop', side: 'sell', price: '99', transaction_time: '2025-01-06T17:00:00Z' });
    const facts = evidence(); facts.brokerActivities.push(extra);
    assert.equal((await service.preview(facts)).repairs.length, 0);
    extra.order_id = 'another-exit';
    await localFill(id, { activity_id: extra.id, broker_order_id: extra.order_id, side: 'sell', price: 99, executed_at: extra.transaction_time });
    assert.equal((await service.preview(facts)).repairs.length, 0);
});

test('busted orphan fills cannot be revived by inferred linkage', async () => {
    await seed();
    const facts = evidence(); facts.brokerActivities[1].order_id = 'unrecorded-order';
    await localFill(null, { activity_id: EXIT_EXECUTION, broker_order_id: 'unrecorded-order', side: 'sell', price: 99, executed_at: EXIT, is_bust: true });
    assert.equal((await service.preview(facts)).repairs.length, 0);
    assert.equal((await all('SELECT plan_id, is_bust FROM alpaca_paper_fills WHERE activity_id = ?', [EXIT_EXECUTION]))[0].plan_id, null);
});

test('canonical duplicate deliveries remain stored but never double count effective shares or P&L', async () => {
    const id = await seed();
    await localFill(id, { activity_id: `20250106150000000::${EXECUTION}`, source: 'rest_reconciliation' });
    assert.equal((await store.computeFilledSummaryForPlan(id)).entry.qty, 10);
    const preview = await service.preview(evidence());
    assert.equal(preview.summary.v1.duplicateRows, 1);
    await service.apply(request(preview, id));
    assert.equal((await store.listFillsForPlan(id)).length, 3);
    assert.equal((await store.getPlan(id)).realized_pnl, -10);
});

test('conflicting duplicate facts fail closed without deleting either delivery', async () => {
    const id = await seed();
    await localFill(id, { activity_id: `20250106150000000::${EXECUTION}`, price: 101 });
    await assert.rejects(store.computeFilledSummaryForPlan(id), { code: 'ALPACA_HISTORY_FILL_CONFLICT' });
    assert.equal((await service.preview(evidence())).repairs.length, 0);
    assert.equal((await store.listFillsForPlan(id)).length, 2);
});

test('canonical bust and correction evidence applies across duplicate formats', () => {
    const common = { broker_order_id: 'sample', symbol: 'XYZ', side: 'buy', qty: 10, price: 100 };
    const original = { ...common, activity_id: EXECUTION };
    const duplicate = { ...common, activity_id: `20250106150000000::${EXECUTION}` };
    assert.deepEqual(effectiveV1HistoryFills([original, { ...duplicate, is_bust: 1 }]), []);
    const replacement = { ...common, activity_id: 'replacement', price: 99, correction_of: duplicate.activity_id };
    assert.deepEqual(effectiveV1HistoryFills([original, duplicate, replacement]), [replacement]);
});

test('stale local state or changed broker facts invalidate the reviewed token', async () => {
    const id = await seed();
    const preview = await service.preview(evidence());
    await exec("UPDATE alpaca_day_trade_plans SET review_notes = 'new review' WHERE id = ?", [id]);
    await assert.rejects(service.apply(request(preview, id)), { code: 'ALPACA_HISTORY_STALE_PREVIEW' });
    const refreshed = await service.preview(evidence());
    const changed = evidence(); changed.brokerActivities[1].price = '98';
    await assert.rejects(service.apply(request(refreshed, id, changed)), { code: 'ALPACA_HISTORY_STALE_PREVIEW' });
});

test('a later but fresh broker snapshot with unchanged evidence preserves the reviewed token', async () => {
    const id = await seed();
    const facts = evidence({ snapshotAt: new Date(NOW.getTime() - 20_000).toISOString() });
    const preview = await service.preview(facts);
    assert.equal((await service.apply(request(preview, id, evidence()))).applied, true);
});

test('journal insertion failure rolls back imported fills and the plan update', async () => {
    const id = await seed();
    const preview = await service.preview(evidence());
    await exec("CREATE TRIGGER test_history_failure BEFORE INSERT ON alpaca_day_trade_events BEGIN SELECT RAISE(ABORT, 'synthetic history failure'); END");
    await assert.rejects(service.apply(request(preview, id)), /synthetic history failure/);
    assert.equal((await store.getPlan(id)).state, 'entry_pending');
    assert.equal((await store.listFillsForPlan(id)).length, 1);
});

for (const [name, change, code] of [
    ['incomplete pagination', facts => { facts.coverage.complete = false; }, 'INCOMPLETE_BROKER_HISTORY'],
    ['open positions', facts => { facts.positions = [{ symbol: 'XYZ', qty: '1' }]; }, 'BROKER_NOT_FLAT'],
    ['open orders', facts => { facts.openOrders = [{ symbol: 'XYZ' }]; }, 'BROKER_NOT_FLAT'],
    ['stale broker snapshot', facts => { facts.snapshotAt = '2025-01-09T16:00:00Z'; }, 'STALE_BROKER_SNAPSHOT'],
]) {
    test(`apply blocks ${name} without mutating history`, async () => {
        const id = await seed(); const facts = evidence(); change(facts);
        const preview = await service.preview(facts);
        await assert.rejects(service.apply(request(preview, id, facts)), { code: `ALPACA_HISTORY_${code}` });
        assert.equal((await store.listFillsForPlan(id)).length, 1);
    });
}

test('enabled monitors and active sender leases block apply', async () => {
    const id = await seed();
    await exec("UPDATE alpaca_monitor_state SET mode = 'paper_execute' WHERE id = 1");
    let preview = await service.preview(evidence());
    await assert.rejects(service.apply(request(preview, id)), { code: 'ALPACA_HISTORY_MONITORS_ENABLED' });
    await exec("UPDATE alpaca_monitor_state SET mode = 'disabled', submission_lease_holder = 'synthetic-sender' WHERE id = 1");
    preview = await service.preview(evidence());
    await assert.rejects(service.apply(request(preview, id)), { code: 'ALPACA_HISTORY_ACTIVE_EXECUTION' });
});

test('legacy disable is one-way, requires flat evidence, and journals only its first change', async () => {
    await exec("UPDATE alpaca_monitor_state SET mode = 'paper_execute' WHERE id = 1");
    await assert.rejects(service.disableLegacy({ ...evidence(), confirm: 'wrong' }), { code: 'ALPACA_HISTORY_CONFIRMATION_REQUIRED' });
    await assert.rejects(service.disableLegacy({ ...evidence({ positions: [{}] }), confirm: 'DISABLE_LEGACY' }), { code: 'ALPACA_HISTORY_BROKER_NOT_FLAT' });
    const result = await service.disableLegacy({ ...evidence(), confirm: 'DISABLE_LEGACY' });
    assert.equal(result.alreadyDisabled, false);
    assert.equal((await store.getMonitorState()).mode, 'disabled');
    assert.equal((await service.disableLegacy({ ...evidence(), confirm: 'DISABLE_LEGACY' })).alreadyDisabled, true);
    assert.equal((await store.listEvents()).length, 1);
});

test('v2 missing closed-history executions are visible even with no active plans', async () => {
    await exec(`INSERT INTO alpaca_dt_v2_plans (client_order_id, symbol, setup, catalyst, thesis, invalidation,
        planned_qty, planned_entry_price, planned_stop, planned_target, planned_risk_dollars, exit_deadline, state, parent_order_id)
        VALUES ('example-v2', 'XYZ', 'test', 'test', 'test', 'test', 10, 100, 98, 104, 20, ?, 'closed', 'example-entry')`, [EXIT]);
    const preview = await service.preview(evidence());
    assert.ok(preview.issues.some(issue => issue.version === 'v2' && issue.code === 'BROKER_FILLS_MISSING_LOCALLY'));
    assert.ok(preview.issues.some(issue => issue.version === 'v2' && issue.code === 'PLAN_FILL_SUMMARY_MISMATCH'));
    assert.equal(preview.repairs.length, 0);
});

test('broker flatness alone cannot close an unbalanced v1 fill history', async () => {
    const id = await seed();
    await localFill(id, { activity_id: EXIT_EXECUTION, broker_order_id: 'example-stop', side: 'sell', qty: 4, price: 99, executed_at: EXIT });
    await attemptCloseFromFills(await store.getPlan(id), { client: { getPosition: async () => null } });
    assert.equal((await store.getPlan(id)).state, 'entry_pending');
});

test('unknown closed P&L and R are excluded rather than converted to zero', () => {
    const result = computeJournalAnalytics([
        { status: 'closed', setup: 'test', realized_pnl: null, realized_r: null },
        { status: 'closed', setup: 'test', realized_pnl: 20, realized_r: null },
        { status: 'closed', setup: 'test', realized_pnl: -10, realized_r: -0.5 },
    ]);
    assert.equal(result.closed_trade_count, 2);
    assert.equal(result.expectancy, 5);
    assert.equal(result.average_r, -0.5);
});

test('pagination reports repeated cursors and page caps as incomplete', async () => {
    const client = { getAccountActivities: async () => [activity()] };
    const range = { after: evidence().coverage.after, until: NOW.toISOString(), pageSize: 1 };
    assert.equal((await collectBrokerHistory(client, { ...range, maxPages: 1 })).coverage.complete, false);
    assert.equal((await collectBrokerHistory(client, range)).coverage.complete, false);
    let calls = 0;
    const complete = await collectBrokerHistory({ getAccountActivities: async () => calls++ ? [] : [activity()] }, range);
    assert.equal(complete.coverage.complete, true);
    assert.equal(complete.pages, 2);
    assert.equal(complete.brokerActivities.length, 1);
});

test('preview and journal contain no broker identifiers or raw payloads', async () => {
    const id = await seed();
    const preview = await service.preview(evidence());
    const visible = JSON.stringify(preview);
    assert.equal(visible.includes('example-entry'), false);
    assert.equal(visible.includes(EXECUTION), false);
    await service.apply(request(preview, id));
    const events = await all('SELECT detail_json FROM alpaca_day_trade_events');
    assert.equal(JSON.stringify(events).includes('example-entry'), false);
});
