'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { createTestDatabase } = require('../test-support/test_database');
createTestDatabase();
const db = require('../database/db');
const store = require('../services/alpaca_day_trade_v2_store');
const { validateExperiment, deriveFillTrade, observationSummary, evaluateExperiment, observeActivePlans } = require('../services/alpaca_day_trade_v2_research');

const START = Date.parse('2027-02-03T15:00:00Z');
const at = (minutes) => new Date(START + minutes * 60_000).toISOString();
const definition = (patch = {}) => ({ name: 'Forward exit comparison', setupId: 'range_breakout', strategyVersion: 'v1',
    kind: 'stall_exit', parameters: { afterMinutes: 5, minimumProgressR: 0.25 }, durationDays: 20, minTrades: 30, costBps: 5, ...patch });
const plan = (patch = {}) => ({ id: 1, symbol: 'TEST', setup_id: 'range_breakout', strategy_version: 'v1', catalyst_class: 'earnings',
    created_at: at(-1), state: 'closed', exit_reason: 'time_exit', planned_qty: 10, planned_stop: 98, planned_risk_dollars: 30,
    realized_pnl: 1000, realized_r: 20, entry_evidence_json: JSON.stringify({ candidate_atr: 1, candidate_observed_at: at(-2) }), ...patch });
const fills = (exitPrice = 99) => [
    { execution_id: 'test-entry', plan_id: 1, symbol: 'TEST', order_id: 'test-parent', role: 'entry', side: 'buy', qty: 10, price: 100, executed_at: at(0) },
    { execution_id: 'test-exit', plan_id: 1, symbol: 'TEST', order_id: 'test-exit-order', role: 'time_exit', side: 'sell', qty: 10, price: exitPrice, executed_at: at(10) },
];
const observations = (priceAt = () => 100.1) => Array.from({ length: 10 }, (_, minute) => ({ plan_id: 1,
    quote_at: at(minute), observed_at: new Date(START + minute * 60_000 + 1000).toISOString(), bid: priceAt(minute), ask: priceAt(minute) + 0.02,
    feed: 'iex', entry_qty: 10, exit_qty: 0, entry_price: 100 }));
const experiment = (patch = {}) => ({ id: 1, ...validateExperiment(definition(patch), new Date(at(-5))) });
const evaluate = (exp = experiment(), extra = {}) => evaluateExperiment(exp, {
    plans: [plan()], fills: fills(), observations: observations(), now: new Date(at(20)), ...extra,
});

before(() => db.initDb());

test('definitions freeze a future collection window and reject backdating and unbounded assumptions', () => {
    const row = validateExperiment(definition(), new Date(at(-5)));
    assert.equal(row.created_at, at(-5));
    assert.equal(Date.parse(row.ends_at) - Date.parse(row.created_at), 20 * 86_400_000);
    for (const body of [definition({ createdAt: at(-20) }), definition({ costBps: -1 }),
        definition({ parameters: { afterMinutes: 0, minimumProgressR: 0.25 } }), definition({ parameters: { afterMinutes: 5, minimumProgressR: NaN } }),
        definition({ kind: 'atr_target', parameters: { atrMultiple: Infinity } }), definition({ durationDays: 91 })]) {
        assert.throws(() => validateExperiment(body), { code: 'ALPACA_V2_EXPERIMENT_INVALID' });
    }
});

test('fill evidence replaces cached outcomes, separates risk denominators and uses execution times', () => {
    const trade = deriveFillTrade(plan(), fills());
    assert.equal(trade.realized_pnl, -10);
    assert.equal(trade.realized_r, -0.3333);
    assert.equal(trade.actual_initial_risk_dollars, 20);
    assert.equal(trade.actual_risk_r, -0.5);
    assert.equal(trade.opened_at, at(0));
    assert.equal(trade.closed_at, at(10));
    assert.equal(deriveFillTrade(plan(), fills().slice(0, 1)), null);
    assert.equal(deriveFillTrade(plan(), [...fills(), fills()[0]]), null);
    assert.equal(deriveFillTrade(plan(), [{ ...fills()[0], executed_at: at(11) }, fills()[1]]), null);
    assert.equal(deriveFillTrade(plan(), [
        { ...fills()[0], executed_at: '2027-02-03T15:00:00.000002Z' },
        { ...fills()[1], executed_at: '2027-02-03T15:00:00.000001Z' },
    ]), null);
    assert.equal(deriveFillTrade(plan(), [{ ...fills()[0], executed_at: '2027-02-30T15:00:00Z' }, fills()[1]]), null);
});

test('equivalent execution identifiers cannot inflate a balanced trade or enter a prospective sample', () => {
    const originals = fills().map((fill, index) => ({ ...fill,
        execution_id: `a0000000-0000-4000-8000-00000000000${index + 1}` }));
    const expanded = plan({ planned_qty: 20 });
    for (const alias of [id => `20270203150000000::${id}`, id => id.toUpperCase()]) {
        const duplicated = [...originals, ...originals.map(fill => ({ ...fill, execution_id: alias(fill.execution_id) }))];
        assert.equal(deriveFillTrade(expanded, duplicated), null);
        const result = evaluate(experiment(), { plans: [expanded], fills: duplicated }).results;
        assert.equal(result.eligibleCount, 0);
        assert.equal(result.exclusions.INCOMPLETE_FILLS, 1);
    }
});

test('undocumented identifier prefixes remain distinct rather than guessing execution identity', () => {
    const originals = fills().map((fill, index) => ({ ...fill,
        execution_id: `a0000000-0000-4000-8000-00000000000${index + 1}` }));
    const separate = [...originals, ...originals.map(fill => ({ ...fill, execution_id: `different::${fill.execution_id}` }))];
    assert.equal(deriveFillTrade(plan({ planned_qty: 20 }), separate).filled_entry_qty, 20);
});

test('excursions use held-interval samples rather than session extremes and missing data stays null', () => {
    const trade = deriveFillTrade(plan(), fills());
    const samples = [...observations((minute) => minute === 3 ? 101 : 99.5),
        { ...observations()[0], quote_at: at(-10), observed_at: at(-10), bid: 1000, ask: 1001 },
        { ...observations()[0], quote_at: at(11), observed_at: at(11), bid: 1, ask: 2 }];
    const result = observationSummary(trade, samples);
    assert.equal(result.count, 10);
    assert.equal(result.mfeDollars, 10);
    assert.equal(result.maeDollars, -5);
    assert.equal(result.complete, true);
    const missing = observationSummary(trade, []);
    assert.equal(missing.mfeDollars, null);
    assert.equal(missing.maeDollars, null);
    assert.equal(missing.complete, false);
});

test('stall evaluation uses observable progress and compares the same trade with equal per-side cost assumptions', () => {
    const result = evaluate().results;
    assert.equal(result.eligibleCount, 1);
    assert.equal(result.triggeredCount, 1);
    assert.equal(result.baselineGrossPnl, -10);
    assert.equal(result.baselineNetPnl, -11);
    assert.equal(result.shadowGrossPnl, 1);
    assert.equal(result.shadowNetPnl, 0);
    assert.equal(result.differenceNetPnl, 10.99);
    assert.equal(result.minimumTradesMet, false);
    const progressed = evaluate(experiment(), { observations: observations((minute) => minute === 3 ? 101 : 100.1) }).results;
    assert.equal(progressed.triggeredCount, 0);
    assert.equal(progressed.differenceNetPnl, 0);
});

test('ATR target estimates use entry-time ATR and the target price, never an observed overshoot', () => {
    const exp = experiment({ kind: 'atr_target', parameters: { atrMultiple: 1.5 } });
    const result = evaluate(exp, { observations: observations((minute) => minute < 6 ? 100.1 : 103) }).results;
    assert.equal(result.eligibleCount, 1);
    assert.equal(result.triggeredCount, 1);
    assert.equal(result.shadowGrossPnl, 15);
    const noAtr = evaluate(exp, { plans: [plan({ entry_evidence_json: '{}' })] }).results;
    assert.equal(noAtr.eligibleCount, 0);
    assert.equal(noAtr.exclusions.NO_ENTRY_ATR, 1);
    const futureAtr = evaluate(exp, { plans: [plan({ entry_evidence_json: JSON.stringify({ candidate_atr: 1, candidate_observed_at: at(5) }) })] }).results;
    assert.equal(futureAtr.exclusions.NO_ENTRY_ATR, 1);
});

test('a delayed quote cannot suppress a stall decision already observable before that quote arrived', () => {
    const samples = observations().filter((_, index) => index < 4 || index > 5);
    const base = observations()[0];
    samples.push({ ...base, quote_at: at(4 + 59 / 60), observed_at: at(5 + 8 / 60), bid: 101, ask: 101.02 });
    samples.push({ ...base, quote_at: at(5), observed_at: at(5 + 0.5 / 60), bid: 100.1, ask: 100.12 });
    const result = evaluate(experiment(), { observations: samples }).results;
    assert.equal(result.triggeredCount, 1);
    assert.equal(result.shadowGrossPnl, 1);
});

test('forward-only enrollment excludes old plans, mismatched versions and unresolved/incomplete trades', () => {
    assert.equal(evaluate(experiment(), { plans: [plan({ created_at: at(-10) })] }).results.eligibleCount, 0);
    assert.equal(evaluate(experiment(), { plans: [plan({ strategy_version: 'v2' })] }).results.eligibleCount, 0);
    assert.equal(evaluate(experiment(), { plans: [plan({ state: 'active' })] }).results.exclusions.NOT_COMPLETED, 1);
    assert.equal(evaluate(experiment(), { fills: fills().slice(0, 1) }).results.exclusions.INCOMPLETE_FILLS, 1);
    const partial = fills().map((fill) => ({ ...fill, qty: 5 }));
    assert.equal(evaluate(experiment(), { fills: partial }).results.exclusions.PARTIAL_ENTRY, 1);
});

test('forward windows and evidence cutoffs retain fractional-millisecond chronology', () => {
    const futureFill = [fills()[0], { ...fills()[1], executed_at: '2027-02-03T15:10:00.000001Z' }];
    assert.equal(evaluate(experiment(), { fills: futureFill, now: new Date(at(10)) }).results.exclusions.FUTURE_EVIDENCE, 1);
    const atr = experiment({ kind: 'atr_target', parameters: { atrMultiple: 1.5 } });
    const laterAtr = plan({ entry_evidence_json: JSON.stringify({ candidate_atr: 1, candidate_observed_at: '2027-02-03T14:59:00.000001Z' }) });
    assert.equal(evaluate(atr, { plans: [laterAtr] }).results.exclusions.NO_ENTRY_ATR, 1);
    const startedLater = { ...experiment(), created_at: '2027-02-03T14:59:00.000001Z' };
    assert.equal(evaluate(startedLater).results.eligibleCount, 0);
});

test('missing intervals exclude estimates, while gaps after a hypothetical exit do not leak into its decision', () => {
    const gapped = observations().filter((_, index) => index !== 2 && index !== 3);
    const result = evaluate(experiment(), { observations: gapped }).results;
    assert.equal(result.eligibleCount, 0);
    assert.equal(result.exclusions.OBSERVATION_GAPS, 1);
    assert.equal(result.shadowNetPnl, null);
    const afterExitGap = observations().filter((_, index) => index <= 5);
    assert.equal(evaluate(experiment(), { observations: afterExitGap }).results.eligibleCount, 1);
    const receivedAfterExit = observations().map((sample) => ({ ...sample, quote_at: at(9.95), observed_at: at(10.01) }));
    assert.equal(evaluate(experiment(), { observations: receivedAfterExit }).results.eligibleCount, 0);
});

test('evidence collection cannot place an order, ignores stale data, and preserves fresh quote provenance', async () => {
    const calls = [];
    const active = { id: 1, symbol: 'TEST', filled_entry_qty: 10, filled_exit_qty: 0, avg_entry_price: 100 };
    const fakeStore = { listNonterminalPlans: async () => [active], recordObservation: async (row) => calls.push(row) };
    const client = { getLatestQuote: async () => ({ symbol: 'TEST', quote: { t: at(0), bp: 100, bs: 2, ap: 100.02, as: 2 } }),
        submitOrder: async () => assert.fail('research must never trade') };
    await observeActivePlans({ store: fakeStore, client, now: () => new Date(at(1)) });
    assert.equal(calls.length, 0);
    await observeActivePlans({ store: fakeStore, client, now: () => new Date(START + 1000) });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].quote_at, at(0));
    assert.equal(calls[0].feed, 'iex');
});

function sql(statement) {
    const c = db.getDb();
    return new Promise((resolve, reject) => c.run(statement, (err) => { c.close(); err ? reject(err) : resolve(); }));
}

test('stored definitions and samples are immutable; closing a plan before a quote returns suppresses that sample', async () => {
    const exp = await store.createExperiment(definition(), new Date(at(-5)));
    await assert.rejects(sql(`UPDATE alpaca_dt_v2_experiments SET cost_bps=0 WHERE id=${exp.id}`), /immutable/);
    await assert.rejects(sql(`DELETE FROM alpaca_dt_v2_experiments WHERE id=${exp.id}`), /immutable/);
    const { plan: created } = await store.createPlan({ client_order_id: 'dt2-research-test', symbol: 'TEST', setup: 'range', catalyst: 'test', thesis: 'test', invalidation: 'test',
        planned_qty: 10, planned_entry_price: 100.5, planned_stop: 98, planned_target: 105, planned_risk_dollars: 25, exit_deadline: at(10), occurred_at: at(-1) });
    await store.updatePlan(created.id, { state: 'active', filled_entry_qty: 10, avg_entry_price: 100, opened_at: at(0) });
    const sample = { plan_id: created.id, observed_at: new Date(START + 1000).toISOString(), quote_at: at(0), bid: 100, ask: 100.02, feed: 'iex' };
    assert.equal((await store.recordObservation(sample)).inserted, true);
    assert.equal((await store.recordObservation(sample)).inserted, false);
    await assert.rejects(sql('UPDATE alpaca_dt_v2_observations SET bid=99'), /immutable/);
    await store.updatePlan(created.id, { state: 'closed', filled_exit_qty: 10, avg_exit_price: 99, closed_at: at(10) });
    assert.equal((await store.recordObservation({ ...sample, quote_at: at(1), observed_at: at(1) })).inserted, false);
    assert.equal((await store.listObservations({ planId: created.id })).length, 1);
});
