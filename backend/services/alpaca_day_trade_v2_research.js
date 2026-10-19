'use strict';

const { validateAndAnnotateQuote } = require('./alpaca_market_data');
const { parseEvidenceTime } = require('./alpaca_day_trade_v2_evidence');
const { canonicalHistoryExecutionId } = require('./alpaca_day_trade_history_audit');

const MAX_OBSERVATION_GAP_MS = 120_000;
const schema = [
    `CREATE TABLE IF NOT EXISTS alpaca_dt_v2_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id INTEGER NOT NULL REFERENCES alpaca_dt_v2_plans(id),
        observed_at TEXT NOT NULL, quote_at TEXT NOT NULL, bid REAL NOT NULL CHECK(bid > 0),
        ask REAL NOT NULL CHECK(ask >= bid), feed TEXT NOT NULL CHECK(feed IN ('iex','sip')),
        entry_qty INTEGER NOT NULL CHECK(entry_qty > 0), exit_qty INTEGER NOT NULL CHECK(exit_qty >= 0),
        entry_price REAL NOT NULL CHECK(entry_price > 0), UNIQUE(plan_id,quote_at))`,
    'CREATE INDEX IF NOT EXISTS idx_dt_v2_observations_plan ON alpaca_dt_v2_observations(plan_id,quote_at)',
    `CREATE TABLE IF NOT EXISTS alpaca_dt_v2_experiments (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, setup_id TEXT NOT NULL,
        strategy_version TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('stall_exit','atr_target')),
        parameters_json TEXT NOT NULL, created_at TEXT NOT NULL, ends_at TEXT NOT NULL,
        min_trades INTEGER NOT NULL CHECK(min_trades > 0), cost_bps REAL NOT NULL CHECK(cost_bps >= 0))`,
    ...['alpaca_dt_v2_observations', 'alpaca_dt_v2_experiments'].flatMap((table) => ['UPDATE', 'DELETE'].map((op) =>
        `CREATE TRIGGER IF NOT EXISTS ${table}_no_${op.toLowerCase()} BEFORE ${op} ON ${table}
         BEGIN SELECT RAISE(ABORT, 'research evidence is immutable'); END`)),
];

const round = (n, places = 2) => {
    if (!Number.isFinite(n)) return null;
    const value = Math.sign(n) * Math.round((Math.abs(n) + Number.EPSILON) * 10 ** places) / 10 ** places;
    return value === 0 ? 0 : value;
};
const instant = (value) => parseEvidenceTime(value)?.milliseconds ?? NaN;
const positive = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;
const json = (value) => { try { return JSON.parse(value || '{}'); } catch { return {}; } };

function experimentError() {
    return Object.assign(new Error('invalid prospective experiment definition'), { code: 'ALPACA_V2_EXPERIMENT_INVALID' });
}

function validateExperiment(input, now = new Date()) {
    const fields = ['name', 'setupId', 'strategyVersion', 'kind', 'parameters', 'durationDays', 'minTrades', 'costBps'];
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !fields.includes(key))) throw experimentError();
    const token = (value) => value === '*' || (typeof value === 'string' && /^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(value));
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100
        || !token(input.setupId) || !token(input.strategyVersion)
        || !Number.isInteger(input.durationDays) || input.durationDays < 1 || input.durationDays > 90
        || !Number.isInteger(input.minTrades) || input.minTrades < 1 || input.minTrades > 1000
        || typeof input.costBps !== 'number' || !Number.isFinite(input.costBps) || input.costBps < 0 || input.costBps > 100) throw experimentError();
    const params = input.parameters;
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw experimentError();
    if (input.kind === 'stall_exit') {
        if (Object.keys(params).sort().join(',') !== 'afterMinutes,minimumProgressR'
            || !Number.isInteger(params.afterMinutes) || params.afterMinutes < 5 || params.afterMinutes > 240
            || typeof params.minimumProgressR !== 'number' || !Number.isFinite(params.minimumProgressR)
            || params.minimumProgressR < 0 || params.minimumProgressR > 1) throw experimentError();
    } else if (input.kind === 'atr_target') {
        if (Object.keys(params).join(',') !== 'atrMultiple' || typeof params.atrMultiple !== 'number'
            || !Number.isFinite(params.atrMultiple) || params.atrMultiple < 0.25 || params.atrMultiple > 10) throw experimentError();
    } else throw experimentError();
    return {
        name: input.name.trim(), setup_id: input.setupId, strategy_version: input.strategyVersion,
        kind: input.kind, parameters_json: JSON.stringify(params), created_at: now.toISOString(),
        ends_at: new Date(now.getTime() + input.durationDays * 86_400_000).toISOString(),
        min_trades: input.minTrades, cost_bps: input.costBps,
    };
}

// Reconstruct a completed trade from its executions. Plan caches and operator review
// annotations are not evidence for price, holding duration, or measured excursions.
function deriveFillTrade(plan, fills = []) {
    const own = fills.filter((fill) => fill.plan_id === plan.id);
    if (!own.length) return null;
    const seen = new Set();
    for (const fill of own) {
        const identity = canonicalHistoryExecutionId(fill.execution_id);
        if (typeof fill.execution_id !== 'string' || !identity.trim() || seen.has(identity) || fill.symbol !== plan.symbol
            || !Number.isInteger(fill.qty) || fill.qty <= 0 || !positive(fill.price) || !Number.isFinite(instant(fill.executed_at))
            || !['entry', 'bracket_exit', 'time_exit'].includes(fill.role)
            || fill.side !== (fill.role === 'entry' ? 'buy' : 'sell')) return null;
        seen.add(identity);
    }
    const entries = own.filter((fill) => fill.role === 'entry');
    const exits = own.filter((fill) => fill.role !== 'entry');
    const qty = entries.reduce((sum, fill) => sum + fill.qty, 0);
    if (!qty || qty !== exits.reduce((sum, fill) => sum + fill.qty, 0) || qty > plan.planned_qty) return null;
    const entryCost = entries.reduce((sum, fill) => sum + fill.qty * fill.price, 0);
    const exitProceeds = exits.reduce((sum, fill) => sum + fill.qty * fill.price, 0);
    const firstEntry = Math.min(...entries.map((fill) => instant(fill.executed_at)));
    const lastEntry = Math.max(...entries.map((fill) => instant(fill.executed_at)));
    const firstExit = Math.min(...exits.map((fill) => instant(fill.executed_at)));
    const lastExit = Math.max(...exits.map((fill) => instant(fill.executed_at)));
    const entryNanos = entries.map((fill) => parseEvidenceTime(fill.executed_at).nanoseconds);
    const exitNanos = exits.map((fill) => parseEvidenceTime(fill.executed_at).nanoseconds);
    const maxNanos = (items) => items.reduce((a, b) => a > b ? a : b);
    const minNanos = (items) => items.reduce((a, b) => a < b ? a : b);
    // A normal bracket does not exit before completing its entry. Mixed lifecycles
    // need a separate cost-basis model and must not look like verified observations.
    if (maxNanos(entryNanos) > minNanos(exitNanos)) return null;
    const entryPrice = entryCost / qty;
    const pnl = round(exitProceeds - entryCost);
    const actualRisk = positive(plan.planned_stop) ? (entryPrice - plan.planned_stop) * qty : NaN;
    return {
        ...plan, filled_entry_qty: qty, filled_exit_qty: qty,
        avg_entry_price: entryPrice, avg_exit_price: exitProceeds / qty,
        realized_pnl: pnl, realized_r: positive(plan.planned_risk_dollars) ? round(pnl / plan.planned_risk_dollars, 4) : null,
        actual_initial_risk_dollars: actualRisk > 0 ? round(actualRisk, 6) : null,
        actual_risk_r: actualRisk > 0 ? round(pnl / actualRisk, 4) : null,
        opened_at: new Date(firstEntry).toISOString(), closed_at: new Date(lastExit).toISOString(),
        first_entry_ms: firstEntry, last_entry_ms: lastEntry, first_exit_ms: firstExit, last_exit_ms: lastExit,
        first_entry_nanos: String(minNanos(entryNanos)), last_entry_nanos: String(maxNanos(entryNanos)),
        first_exit_nanos: String(minNanos(exitNanos)), last_exit_nanos: String(maxNanos(exitNanos)),
        entry_cost: entryCost, exit_proceeds: exitProceeds,
    };
}

function validObservations(plan, observations) {
    return observations.filter((sample) => sample.plan_id === plan.id
        && positive(sample.bid) && positive(sample.ask) && sample.ask >= sample.bid
        && ['iex', 'sip'].includes(sample.feed)
        && Number.isFinite(instant(sample.quote_at)) && Number.isFinite(instant(sample.observed_at))
        && instant(sample.observed_at) >= instant(sample.quote_at)
        && parseEvidenceTime(sample.observed_at).nanoseconds >= parseEvidenceTime(sample.quote_at).nanoseconds
        && instant(sample.observed_at) - instant(sample.quote_at) <= 10_000
        && parseEvidenceTime(sample.observed_at).nanoseconds < BigInt(plan.first_exit_nanos)
        && parseEvidenceTime(sample.quote_at).nanoseconds >= BigInt(plan.last_entry_nanos)
        && sample.entry_qty === plan.filled_entry_qty && sample.exit_qty === 0
        && Math.abs(sample.entry_price - plan.avg_entry_price) < 0.00001)
        .sort((a, b) => {
            const left = parseEvidenceTime(a.observed_at).nanoseconds; const right = parseEvidenceTime(b.observed_at).nanoseconds;
            return left < right ? -1 : left > right ? 1 : instant(a.quote_at) - instant(b.quote_at);
        });
}

function observationCoverage(plan, samples, untilNanos = BigInt(plan.first_exit_nanos)) {
    const until = Number(untilNanos / 1000000n);
    const available = samples.filter((sample) => parseEvidenceTime(sample.observed_at).nanoseconds <= untilNanos);
    const times = [plan.first_entry_ms, ...available.map((sample) => instant(sample.quote_at)).sort((a, b) => a - b), until];
    return available.length >= 2 && plan.last_entry_ms - plan.first_entry_ms <= MAX_OBSERVATION_GAP_MS
        && times.every((time, index) => index === 0 || time - times[index - 1] <= MAX_OBSERVATION_GAP_MS);
}

function observationSummary(plan, observations = []) {
    if (!plan?.first_entry_ms) return { count: 0, mfeDollars: null, maeDollars: null, firstAt: null, lastAt: null, complete: false, note: 'No verified fill interval.' };
    const samples = validObservations(plan, observations);
    const moves = samples.map((sample) => (sample.bid - plan.avg_entry_price) * plan.filled_entry_qty);
    return {
        count: samples.length,
        mfeDollars: samples.length ? round(Math.max(0, ...moves)) : null,
        maeDollars: samples.length ? round(Math.min(0, ...moves)) : null,
        firstAt: samples.length ? new Date(Math.min(...samples.map((sample) => instant(sample.quote_at)))).toISOString() : null,
        lastAt: samples.length ? new Date(Math.max(...samples.map((sample) => instant(sample.quote_at)))).toISOString() : null,
        complete: observationCoverage(plan, samples),
        note: 'Sampled bid-price excursions while fully entered; intraminute extremes and partial-exit intervals are not measured.',
    };
}

function evaluateExperiment(experiment, { plans = [], fills = [], observations = [], now = new Date() } = {}) {
    const parameters = json(experiment.parameters_json);
    const exclusions = {};
    const exclude = (reason) => { exclusions[reason] = (exclusions[reason] || 0) + 1; };
    let eligible = 0; let triggered = 0; let baselineGross = 0; let baselineNet = 0; let shadowGross = 0; let shadowNet = 0;
    for (const plan of plans) {
        const created = parseEvidenceTime(plan.created_at)?.nanoseconds;
        const start = parseEvidenceTime(experiment.created_at)?.nanoseconds;
        const end = parseEvidenceTime(experiment.ends_at)?.nanoseconds;
        if (created == null || start == null || end == null || created < start || created >= end) continue;
        if (experiment.setup_id !== '*' && experiment.setup_id !== plan.setup_id) continue;
        if (experiment.strategy_version !== '*' && experiment.strategy_version !== plan.strategy_version) continue;
        if (plan.state !== 'closed') { exclude('NOT_COMPLETED'); continue; }
        if (plan.exit_reason === 'operator_resolved') { exclude('OPERATOR_RESOLVED'); continue; }
        const trade = deriveFillTrade(plan, fills);
        if (!trade) { exclude('INCOMPLETE_FILLS'); continue; }
        const nowNanos = BigInt(now.getTime()) * 1000000n;
        if (BigInt(trade.last_exit_nanos) > nowNanos || created > nowNanos) { exclude('FUTURE_EVIDENCE'); continue; }
        if (!positive(trade.actual_initial_risk_dollars)) { exclude('INVALID_INITIAL_RISK'); continue; }
        if (trade.filled_entry_qty !== trade.planned_qty) { exclude('PARTIAL_ENTRY'); continue; }
        if (BigInt(trade.first_entry_nanos) < start || BigInt(trade.first_entry_nanos) >= end) { exclude('ENTRY_OUTSIDE_WINDOW'); continue; }
        const samples = validObservations(trade, observations);
        let candidate = null; let shadowPrice = trade.avg_exit_price;
        if (experiment.kind === 'stall_exit') {
            const deadline = BigInt(trade.first_entry_nanos) + BigInt(parameters.afterMinutes * 60_000) * 1000000n;
            const progress = trade.actual_initial_risk_dollars / trade.filled_entry_qty * parameters.minimumProgressR;
            let maxProgress = 0;
            for (const sample of samples) {
                maxProgress = Math.max(maxProgress, sample.bid - trade.avg_entry_price);
                if (parseEvidenceTime(sample.observed_at).nanoseconds >= deadline) {
                    if (maxProgress < progress) { candidate = sample; shadowPrice = sample.bid; }
                    break;
                }
            }
        } else {
            const evidence = json(plan.entry_evidence_json);
            const atrObserved = parseEvidenceTime(evidence.candidate_observed_at)?.nanoseconds;
            if (!positive(evidence.candidate_atr) || atrObserved == null || atrObserved > created) { exclude('NO_ENTRY_ATR'); continue; }
            const target = trade.avg_entry_price + evidence.candidate_atr * parameters.atrMultiple;
            candidate = samples.find((sample) => sample.bid >= target) || null;
            // A conservative hypothetical limit-price estimate, never an assumed
            // executable order or the high of a full-session bar.
            if (candidate) shadowPrice = target;
        }
        if (!observationCoverage(trade, samples, candidate ? parseEvidenceTime(candidate.observed_at).nanoseconds : BigInt(trade.first_exit_nanos))) { exclude('OBSERVATION_GAPS'); continue; }
        eligible += 1;
        if (candidate) triggered += 1;
        const shadowProceeds = shadowPrice * trade.filled_entry_qty;
        const bGross = trade.exit_proceeds - trade.entry_cost;
        const sGross = shadowProceeds - trade.entry_cost;
        const costRate = experiment.cost_bps / 10_000;
        baselineGross += bGross; shadowGross += sGross;
        baselineNet += bGross - (trade.entry_cost + trade.exit_proceeds) * costRate;
        shadowNet += sGross - (trade.entry_cost + shadowProceeds) * costRate;
    }
    return {
        id: experiment.id, name: experiment.name, setupId: experiment.setup_id, strategyVersion: experiment.strategy_version,
        kind: experiment.kind, parameters, createdAt: experiment.created_at, endsAt: experiment.ends_at,
        minTrades: experiment.min_trades, costBps: experiment.cost_bps,
        results: {
            status: now.getTime() >= instant(experiment.ends_at) ? 'complete' : 'collecting',
            eligibleCount: eligible, excludedCount: Object.values(exclusions).reduce((sum, count) => sum + count, 0),
            triggeredCount: triggered, baselineGrossPnl: eligible ? round(baselineGross) : null,
            baselineNetPnl: eligible ? round(baselineNet) : null, shadowGrossPnl: eligible ? round(shadowGross) : null,
            shadowNetPnl: eligible ? round(shadowNet) : null, differenceNetPnl: eligible ? round(shadowNet - baselineNet) : null,
            meanDifferenceNetPnl: eligible ? round((shadowNet - baselineNet) / eligible) : null,
            minimumTradesMet: eligible >= experiment.min_trades, exclusions,
        },
    };
}

// Instrumentation follows the monitor's protective work. A missing/stale quote
// creates missing evidence, never a trading latch, a synthetic price, or an order.
async function observeActivePlans({ store, client, now = () => new Date() }) {
    if (typeof client.getLatestQuote !== 'function' || typeof store.recordObservation !== 'function') return;
    const plans = (await store.listNonterminalPlans()).filter((plan) => plan.filled_entry_qty > plan.filled_exit_qty && positive(plan.avg_entry_price));
    await Promise.all(plans.map(async (plan) => {
        try {
            const raw = await client.getLatestQuote(plan.symbol, { feed: 'iex' });
            const quote = validateAndAnnotateQuote(raw, { requestedSymbol: plan.symbol, feed: 'iex', now: now() });
            await store.recordObservation({ plan_id: plan.id, observed_at: quote.retrievedAt, quote_at: quote.sourceTimestamp,
                bid: quote.bidPrice, ask: quote.askPrice, feed: quote.feed });
        } catch { /* Coverage calculations retain gaps instead of inventing observations. */ }
    }));
}

module.exports = { schema, MAX_OBSERVATION_GAP_MS, validateExperiment, deriveFillTrade, observationSummary, evaluateExperiment, observeActivePlans };
