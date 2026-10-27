const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createV2Execution } = require('../services/alpaca_day_trade_v2_execution');

const NOW = new Date('2026-09-23T15:00:00.000Z');
function intent(patch = {}) {
    return { account_id: 2, client_order_id: 'dt2-preview-example', symbol: 'NVDA',
        setup: 'opening range', catalyst: 'earnings', thesis: 'holds range', invalidation: 'loses range',
        stop: 98, target: 110, exit_deadline: '2026-09-23T19:30:00.000Z',
        max_notional_dollars: 2000, max_risk_dollars: 100, ...patch };
}

function fixture() {
    const state = { mode: 'paper_execute', kill_switch: 0, attention_required: 0, last_reconciled_at: NOW.toISOString() };
    const data = { version: 0, plans: [], fills: [], activeSubmission: false, now: NOW };
    const calls = { reads: 0, writes: 0 };
    const readOnly = (methods) => new Proxy(methods, {
        get(target, key) {
            if (key in target) return target[key];
            return () => { calls.writes += 1; throw new Error(`unexpected mutation: ${String(key)}`); };
        },
    });
    const store = readOnly({
        transaction: async (fn) => fn(store),
        getMonitorState: async () => ({ ...state }),
        assertNoEntrySubmissions: async () => {
            if (data.activeSubmission) throw Object.assign(new Error('active sender'), { code: 'ALPACA_V2_SUBMISSION_IN_PROGRESS' });
        },
        getEntryVersion: async () => data.version,
        getPlanByClientOrderId: async (id) => data.plans.find((plan) => plan.client_order_id === id),
        listPlans: async () => structuredClone(data.plans),
        listFills: async () => structuredClone(data.fills),
    });
    const client = readOnly({
        getAccount: async () => { calls.reads += 1; return { status: 'ACTIVE', cash: '50000', equity: '100000' }; },
        getClock: async () => ({ is_open: true, next_close: '2026-09-23T20:00:00.000Z' }),
        getAsset: async () => ({ class: 'us_equity', status: 'active', tradable: true }),
        getLatestQuote: async () => ({ symbol: 'NVDA', quote: { t: '2026-09-23T14:59:59.000Z', bp: 99.98, bs: 3, ap: 100, as: 2 } }),
        getOrders: async () => [],
        getOrder: async (id) => ({ id, symbol: 'AMD', side: 'buy', filled_qty: '0', legs: [] }),
    });
    const execution = createV2Execution({ store, client, now: () => data.now });
    return { execution, store, client, state, data, calls };
}

test('preview sizes at the authoritative entry bound and makes no persistent or broker mutation', async () => {
    const f = fixture();
    const before = structuredClone(f.data);
    const result = await f.execution.previewEntry(intent());
    assert.equal(result.eligible, true);
    assert.equal(result.qty, 19);
    assert.equal(result.entryPrice, 100.5);
    assert.equal(result.notionalDollars, 1909.5);
    assert.equal(result.riskDollars, 47.5);
    assert.equal(result.quote.askPrice, 100);
    assert.equal(result.quote.feed, 'iex');
    assert.equal(result.quoteExpiresAt, '2026-09-23T15:00:09.000Z');
    assert.equal(result.asOf, NOW.toISOString());
    assert.equal(result.indicative, true);
    assert.deepEqual(result.submission, { qty: 19, max_entry_price: 100.8, max_notional_dollars: 2000, max_risk_dollars: 100 });
    assert.equal(f.calls.reads, 1);
    assert.equal(f.calls.writes, 0);
    assert.deepEqual(f.data, before);
    // Repeating a preview neither consumes its id nor reserves cash.
    assert.deepEqual(await f.execution.previewEntry(intent()), result);
});

test('malformed preview input is rejected before broker reads or store transactions', async () => {
    for (const patch of [{ qty: 1 }, { max_notional_dollars: undefined }, { symbol: null }, { symbol: 'bad/path' }]) {
        const f = fixture();
        f.store.transaction = () => { throw new Error('unexpected database access'); };
        await assert.rejects(f.execution.previewEntry(intent(patch)), (error) => /^ALPACA_V2_/.test(error.code));
        assert.equal(f.calls.reads, 0);
        assert.equal(f.calls.writes, 0);
    }
});

for (const [patch, code] of [
    [{ mode: 'disabled' }, 'ALPACA_V2_EXECUTION_DISABLED'],
    [{ mode: 'shadow' }, 'ALPACA_V2_EXECUTION_DISABLED'],
    [{ kill_switch: 1 }, 'ALPACA_V2_KILL_SWITCH_ACTIVE'],
    [{ attention_required: 1 }, 'ALPACA_V2_ATTENTION_REQUIRED'],
    [{ last_reconciled_at: '2026-09-23T14:00:00.000Z' }, 'ALPACA_V2_MONITOR_STALE'],
]) {
    test(`preview respects ${code} without attempting recovery or broker reads`, async () => {
        const f = fixture(); Object.assign(f.state, patch);
        await assert.rejects(f.execution.previewEntry(intent()), { code });
        assert.equal(f.calls.reads, 0);
        assert.equal(f.calls.writes, 0);
    });
}

test('an outstanding submission blocks preview without crash recovery', async () => {
    const f = fixture(); f.data.activeSubmission = true;
    await assert.rejects(f.execution.previewEntry(intent()), { code: 'ALPACA_V2_SUBMISSION_IN_PROGRESS' });
    assert.equal(f.calls.writes, 0);
    assert.equal(f.calls.reads, 0);
});

test('a previously used client id is never previewed or recovered', async () => {
    const f = fixture(); f.data.plans.push({ client_order_id: intent().client_order_id });
    await assert.rejects(f.execution.previewEntry(intent()), { code: 'ALPACA_V2_DUPLICATE_CLIENT_ORDER_ID' });
    assert.equal(f.calls.writes, 0);
    assert.equal(f.calls.reads, 0);
});

for (const [change, code] of [
    [(f) => { f.state.kill_switch = 1; }, 'ALPACA_V2_KILL_SWITCH_ACTIVE'],
    [(f) => { f.data.version += 1; }, 'ALPACA_V2_CONTROL_STATE_CHANGED'],
    [(f) => { f.data.activeSubmission = true; }, 'ALPACA_V2_SUBMISSION_IN_PROGRESS'],
    [(f) => { f.data.plans.push({ client_order_id: intent().client_order_id }); }, 'ALPACA_V2_DUPLICATE_CLIENT_ORDER_ID'],
]) {
    test(`preview rechecks concurrent state changes: ${code}`, async () => {
        const f = fixture(); const read = f.client.getLatestQuote;
        f.client.getLatestQuote = async () => { change(f); return read(); };
        await assert.rejects(f.execution.previewEntry(intent()), { code });
        assert.equal(f.calls.writes, 0);
    });
}

test('slow broker facts cannot produce an eligible preview even with a fresh quote', async () => {
    const f = fixture(); const read = f.client.getLatestQuote;
    f.client.getLatestQuote = async () => {
        f.data.now = new Date(NOW.getTime() + 10_001);
        const result = await read(); result.quote.t = f.data.now.toISOString(); return result;
    };
    await assert.rejects(f.execution.previewEntry(intent()), { code: 'ALPACA_V2_BROKER_SNAPSHOT_STALE' });
    assert.equal(f.calls.writes, 0);
});

test('preview surfaces price geometry blockers without logging entry attempts', async () => {
    const f = fixture();
    const result = await f.execution.previewEntry(intent({ target: 102 }));
    assert.equal(result.eligible, false);
    assert.equal(result.qty, 0);
    assert.equal(result.submission, null);
    assert.deepEqual(result.blockerCodes, ['ALPACA_V2_REWARD_RISK_TOO_LOW']);
    assert.equal(f.calls.writes, 0);
});

function workingPlan(patch = {}) {
    return { id: 1, symbol: 'AMD', state: 'working', client_order_id: 'dt2-existing-example',
        parent_order_id: 'example-parent', stop_order_id: null, target_order_id: null, exit_order_id: null,
        filled_entry_qty: 0, filled_exit_qty: 0, planned_risk_dollars: 1990, ...patch };
}

test('preview uses broker-verified existing risk and refuses missing risk amounts', async () => {
    const f = fixture(); f.data.plans.push(workingPlan());
    const result = await f.execution.previewEntry(intent());
    assert.equal(result.qty, 3, 'remaining account risk is ten dollars at 2.80 per share at the 100.80 headroom cap');
    f.data.plans[0].planned_risk_dollars = null;
    await assert.rejects(f.execution.previewEntry(intent()), { code: 'ALPACA_V2_OPEN_RISK_UNAVAILABLE' });
    assert.equal(f.calls.writes, 0);
});

test('preview refuses broker fills not reconciled in the local evidence', async () => {
    const f = fixture(); f.data.plans.push(workingPlan());
    f.client.getOrder = async (id) => ({ id, symbol: 'AMD', side: 'buy', filled_qty: '1', filled_avg_price: '100', legs: [] });
    await assert.rejects(f.execution.previewEntry(intent()), { code: 'ALPACA_V2_DAILY_PNL_UNAVAILABLE' });
    assert.equal(f.calls.writes, 0);
});

test('preview fails closed on broker lookup failure and never attempts submission', async () => {
    const f = fixture(); f.client.getAccount = async () => { throw new Error('private broker response'); };
    await assert.rejects(f.execution.previewEntry(intent()), { code: 'ALPACA_V2_BROKER_UNAVAILABLE' });
    assert.equal(f.calls.writes, 0);
});
