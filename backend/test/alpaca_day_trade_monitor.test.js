const { test } = require('node:test');
const assert = require('node:assert');

const { decidePlanAction, DEFAULT_MONITOR_POLICY } = require('../services/alpaca_day_trade_monitor');

const NOW = new Date('2026-09-17T14:00:00.000Z'); // 10:00 ET, well inside the trading day
const NEXT_CLOSE = '2026-09-17T20:00:00.000Z'; // 16:00 ET
const CLOCK = { is_open: true, next_close: NEXT_CLOSE };
const FRESH_MONITOR_STATE = { mode: 'paper_execute', kill_switch: false, last_rest_reconciliation_at: '2026-09-17T13:59:30.000Z' };

const basePlan = { id: 1, symbol: 'NVDA', state: 'active', planned_qty: 10 };

function observation(overrides = {}) {
    return {
        plan: basePlan,
        position: { qty: 10, side: 'long' },
        brokerUnavailable: false,
        entryOrder: { status: 'filled', qty: 10, filled_qty: 10, submitted_at: '2026-09-17T13:30:00.000Z' },
        stopLeg: { status: 'held', qty: 10, filled_qty: 0 },
        targetLeg: { status: 'held', qty: 10, filled_qty: 0 },
        clock: CLOCK,
        monitorState: FRESH_MONITOR_STATE,
        now: NOW,
        policy: DEFAULT_MONITOR_POLICY,
        ...overrides,
    };
}

test('healthy bracket: both legs open and covering the exact remaining position -> no action', () => {
    const decision = decidePlanAction(observation());
    assert.strictEqual(decision.action, 'none');
    assert.strictEqual(decision.blockEntries, false);
    assert.strictEqual(decision.activateKillSwitch, false);
});

test('missing leg: the stop leg is absent while a position remains open -> repair by attaching protection', () => {
    const decision = decidePlanAction(observation({ stopLeg: null }));
    assert.strictEqual(decision.action, 'attach_protective_oco');
    assert.strictEqual(decision.details.qty, 10);
    assert.strictEqual(decision.blockEntries, true);
});

test('partial parent timeout: entry partially filled and unresolved beyond the configured timeout -> cancel the remainder', () => {
    const decision = decidePlanAction(observation({
        plan: { ...basePlan, state: 'entry_pending' },
        position: { qty: 4, side: 'long' },
        entryOrder: { status: 'partially_filled', qty: 10, filled_qty: 4, submitted_at: '2026-09-17T13:57:00.000Z' },
        stopLeg: null,
        targetLeg: null,
        now: new Date('2026-09-17T14:00:00.000Z'), // 3 minutes after submission, over the 2-minute default timeout
    }));
    assert.strictEqual(decision.action, 'cancel_unfilled_remainder');
    assert.strictEqual(decision.blockEntries, true);
});

test('a still-partial entry within the timeout window takes no action yet', () => {
    const decision = decidePlanAction(observation({
        plan: { ...basePlan, state: 'entry_pending' },
        position: { qty: 4, side: 'long' },
        entryOrder: { status: 'partially_filled', qty: 10, filled_qty: 4, submitted_at: '2026-09-17T13:59:30.000Z' },
        stopLeg: null,
        targetLeg: null,
        now: new Date('2026-09-17T14:00:00.000Z'), // 30 seconds in, under the 2-minute default timeout
    }));
    assert.strictEqual(decision.action, 'none');
    assert.strictEqual(decision.healthCode, null);
});

test('an unparseable entry submission time does not read as "infinitely old" and trigger an immediate cancel', () => {
    const decision = decidePlanAction(observation({
        plan: { ...basePlan, state: 'entry_pending' },
        position: { qty: 4, side: 'long' },
        entryOrder: { status: 'partially_filled', qty: 10, filled_qty: 4, submitted_at: null },
        stopLeg: null,
        targetLeg: null,
    }));
    assert.strictEqual(decision.action, 'none');
    assert.strictEqual(decision.healthCode, 'ENTRY_TIMESTAMP_UNAVAILABLE');
});

test('the real system\'s actual steady state -- plan.state stuck at entry_pending forever, entry fully filled and covered -- reads as a healthy bracket', () => {
    const decision = decidePlanAction(observation({
        plan: { ...basePlan, state: 'entry_pending' }, // Task 8 never advances this; nothing must depend on it changing
        entryOrder: { status: 'filled', qty: 10, filled_qty: 10, submitted_at: '2026-09-17T13:30:00.000Z' },
    }));
    assert.strictEqual(decision.action, 'none');
    assert.strictEqual(decision.healthCode, null);
});

test('OCO repair: the unfilled remainder was canceled, leaving a filled position with no protection yet -> attach OCO to the exact filled quantity', () => {
    const decision = decidePlanAction(observation({
        plan: { ...basePlan, state: 'entry_pending' },
        position: { qty: 4, side: 'long' },
        entryOrder: { status: 'canceled', qty: 10, filled_qty: 4, submitted_at: '2026-09-17T13:50:00.000Z' },
        stopLeg: null,
        targetLeg: null,
    }));
    assert.strictEqual(decision.action, 'attach_protective_oco');
    assert.strictEqual(decision.details.qty, 4);
});

test('stop fill: the broker position is flat after the stop filled -> no monitor action (fill reconciliation closes the plan)', () => {
    const decision = decidePlanAction(observation({
        position: { qty: 0, side: 'long' },
        stopLeg: { status: 'filled', qty: 10, filled_qty: 10 },
        targetLeg: { status: 'canceled', qty: 10, filled_qty: 0 },
    }));
    assert.strictEqual(decision.action, 'none');
    assert.strictEqual(decision.healthCode, null);
});

test('target partial fill: the target filled 4 of 10, leaving 6 open, but the stop still shows the stale full quantity -> re-protect the true remainder', () => {
    const decision = decidePlanAction(observation({
        position: { qty: 6, side: 'long' },
        stopLeg: { status: 'held', qty: 10, filled_qty: 0 },
        targetLeg: { status: 'partially_filled', qty: 10, filled_qty: 4 },
    }));
    assert.strictEqual(decision.action, 'attach_protective_oco');
    assert.strictEqual(decision.details.qty, 6);
});

test('both exits fill: an impossible double-fill leaves a short position -> treated as an unexpected short, buy to cover and trip the kill switch', () => {
    const decision = decidePlanAction(observation({
        position: { qty: -10, side: 'short' },
        stopLeg: { status: 'filled', qty: 10, filled_qty: 10 },
        targetLeg: { status: 'filled', qty: 10, filled_qty: 10 },
    }));
    assert.strictEqual(decision.action, 'buy_to_cover');
    assert.strictEqual(decision.details.qty, 10);
    assert.strictEqual(decision.activateKillSwitch, true);
    assert.strictEqual(decision.blockEntries, true);
});

test('unexpected short from any other cause (e.g. a manual sell) gets the identical fail-closed treatment', () => {
    const decision = decidePlanAction(observation({
        position: { qty: -3, side: 'short' },
        stopLeg: { status: 'held', qty: 10, filled_qty: 0 },
        targetLeg: { status: 'held', qty: 10, filled_qty: 0 },
    }));
    assert.strictEqual(decision.action, 'buy_to_cover');
    assert.strictEqual(decision.details.qty, 3);
    assert.strictEqual(decision.activateKillSwitch, true);
});

test('outage: the broker could not be reached this tick -> take no action, block entries, and surface why', () => {
    const decision = decidePlanAction(observation({ brokerUnavailable: true }));
    assert.strictEqual(decision.action, 'none');
    assert.strictEqual(decision.blockEntries, true);
    assert.strictEqual(decision.healthCode, 'BROKER_UNAVAILABLE');
});

test('stale local state: the last successful reconciliation is older than the configured bound -> block entries without acting on possibly-outdated data', () => {
    const decision = decidePlanAction(observation({
        stopLeg: null, // would otherwise trigger a repair -- staleness must suppress that
        monitorState: { ...FRESH_MONITOR_STATE, last_rest_reconciliation_at: '2026-09-17T13:50:00.000Z' }, // 10 minutes old
    }));
    assert.strictEqual(decision.action, 'none');
    assert.strictEqual(decision.blockEntries, true);
    assert.strictEqual(decision.healthCode, 'STALE_RECONCILIATION');
});

test('submits the time exit once the configured pre-close window opens and a position remains', () => {
    const decision = decidePlanAction(observation({
        now: new Date('2026-09-17T19:46:00.000Z'), // 14 minutes before the 20:00 close, inside the 15-minute window
        monitorState: { ...FRESH_MONITOR_STATE, last_rest_reconciliation_at: '2026-09-17T19:45:45.000Z' },
    }));
    assert.strictEqual(decision.action, 'submit_time_exit');
    assert.strictEqual(decision.details.qty, 10);
    assert.strictEqual(decision.blockEntries, true);
});

test('3:45 race: the stop fills at the same moment the time-exit window opens -> the flat position wins, no market sell is submitted', () => {
    const decision = decidePlanAction(observation({
        now: new Date('2026-09-17T19:46:00.000Z'), // inside the time-exit window
        monitorState: { ...FRESH_MONITOR_STATE, last_rest_reconciliation_at: '2026-09-17T19:45:45.000Z' },
        position: { qty: 0, side: 'long' },
        stopLeg: { status: 'filled', qty: 10, filled_qty: 10 },
        targetLeg: { status: 'canceled', qty: 10, filled_qty: 0 },
    }));
    assert.strictEqual(decision.action, 'none');
    assert.strictEqual(decision.healthCode, null, 'must be flat-position none, not a stale-reconciliation none');
});

test('3:55 not-flat violation: the safety-sweep deadline has passed and a position is still open -> flatten and trip the kill switch', () => {
    const decision = decidePlanAction(observation({
        now: new Date('2026-09-17T19:56:00.000Z'), // 4 minutes before close, past the 5-minute safety-sweep bound
        monitorState: { ...FRESH_MONITOR_STATE, last_rest_reconciliation_at: '2026-09-17T19:55:45.000Z' },
    }));
    assert.strictEqual(decision.action, 'flatten');
    assert.strictEqual(decision.details.qty, 10);
    assert.strictEqual(decision.activateKillSwitch, true);
    assert.strictEqual(decision.blockEntries, true);
    assert.strictEqual(decision.healthCode, 'SAFETY_SWEEP_VIOLATION');
});

test('a position the caller could not read cleanly this tick is flattened rather than repaired, since safe repair cannot be proven', () => {
    const decision = decidePlanAction(observation({
        position: { qty: 10, side: 'long', ambiguous: true },
        stopLeg: null,
    }));
    assert.strictEqual(decision.action, 'flatten');
    assert.strictEqual(decision.healthCode, 'REPAIR_UNPROVEN');
    assert.strictEqual(decision.blockEntries, true);
});

test('M1: exit_deadline on the PREVIOUS ET date, now at 09:35 ET, clock.is_open true, covered bracket -> submit_time_exit, healthCode CARRIED_POSITION', () => {
    const decision = decidePlanAction(observation({
        plan: { ...basePlan, exit_deadline: '2026-09-16T19:45:00.000Z' }, // yesterday ET
        now: new Date('2026-09-17T13:35:00.000Z'), // 09:35 ET today
        clock: { is_open: true, next_close: '2026-09-17T20:00:00.000Z' },
        monitorState: { ...FRESH_MONITOR_STATE, last_rest_reconciliation_at: '2026-09-17T13:34:50.000Z' },
    }));
    assert.strictEqual(decision.action, 'submit_time_exit');
    assert.strictEqual(decision.healthCode, 'CARRIED_POSITION');
    assert.strictEqual(decision.blockEntries, true);
    assert.strictEqual(decision.details.qty, 10);
});

test('M1b: same-day exit_deadline (15:45 ET) passed at 15:46 ET, market open, before the sweep window -> submit_time_exit with healthCode null', () => {
    const decision = decidePlanAction(observation({
        plan: { ...basePlan, exit_deadline: '2026-09-17T19:45:00.000Z' }, // 15:45 ET today
        now: new Date('2026-09-17T19:46:00.000Z'), // 15:46 ET today
        clock: { is_open: true, next_close: '2026-09-17T20:00:00.000Z' },
        monitorState: { ...FRESH_MONITOR_STATE, last_rest_reconciliation_at: '2026-09-17T19:45:50.000Z' },
    }));
    assert.strictEqual(decision.action, 'submit_time_exit');
    assert.strictEqual(decision.reason, 'plan exit deadline has passed with an open position');
    assert.strictEqual(decision.healthCode, null);
    assert.strictEqual(decision.blockEntries, true);
    assert.strictEqual(decision.details.qty, 10);
});

test('M2: now > exit_deadline, clock.is_open false, uncovered position -> action none, CARRIED_POSITION_AWAITING_OPEN (NOT attach_protective_oco)', () => {
    const decision = decidePlanAction(observation({
        plan: { ...basePlan, exit_deadline: '2026-09-17T19:45:00.000Z' },
        stopLeg: null,
        targetLeg: null,
        now: new Date('2026-09-17T20:30:00.000Z'), // market closed
        clock: { is_open: false, next_close: '2026-09-18T20:00:00.000Z' },
        monitorState: { ...FRESH_MONITOR_STATE, last_rest_reconciliation_at: '2026-09-17T20:29:50.000Z' },
    }));
    assert.strictEqual(decision.action, 'none');
    assert.strictEqual(decision.healthCode, 'CARRIED_POSITION_AWAITING_OPEN');
    assert.strictEqual(decision.blockEntries, true);
});

test('M3: inside the safety-sweep window with exit_deadline passed -> still the sweep flatten with activateKillSwitch', () => {
    const decision = decidePlanAction(observation({
        plan: { ...basePlan, exit_deadline: '2026-09-17T19:45:00.000Z' },
        now: new Date('2026-09-17T19:56:00.000Z'), // 4 min before 20:00 close
        clock: { is_open: true, next_close: '2026-09-17T20:00:00.000Z' },
        monitorState: { ...FRESH_MONITOR_STATE, last_rest_reconciliation_at: '2026-09-17T19:55:50.000Z' },
    }));
    assert.strictEqual(decision.action, 'flatten');
    assert.strictEqual(decision.activateKillSwitch, true);
    assert.strictEqual(decision.healthCode, 'SAFETY_SWEEP_VIOLATION');
});

test('Finding 4: clock { next_close } without is_open, deadline passed -> action none, CARRIED_POSITION_AWAITING_OPEN', () => {
    const decision = decidePlanAction(observation({
        plan: { ...basePlan, exit_deadline: '2026-09-17T19:45:00.000Z' },
        now: new Date('2026-09-17T20:30:00.000Z'),
        clock: { next_close: '2026-09-18T20:00:00.000Z' }, // lacking is_open
        monitorState: { ...FRESH_MONITOR_STATE, last_rest_reconciliation_at: '2026-09-17T20:29:50.000Z' },
    }));
    assert.strictEqual(decision.action, 'none');
    assert.strictEqual(decision.healthCode, 'CARRIED_POSITION_AWAITING_OPEN');
    assert.strictEqual(decision.blockEntries, true);
});

