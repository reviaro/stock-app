'use strict';

const { parseEvidenceTime } = require('./alpaca_day_trade_v2_evidence');

const TERMINAL = new Set(['closed', 'cancelled', 'rejected']);
const STATES = new Set(['pending_submission', 'submission_unknown', 'working', 'active', 'time_exit_pending', 'attention_required', ...TERMINAL]);
const ET_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const whole = (value) => Number.isSafeInteger(value) && value >= 0;
const close = (a, b) => typeof a === 'number' && Number.isFinite(a) && Math.abs(a - b) <= 1e-5;

function easternSessionDate(value) {
    const time = value instanceof Date ? value.getTime() : parseEvidenceTime(value)?.milliseconds;
    return Number.isFinite(time) ? ET_DATE.format(new Date(time)) : null;
}

function canonicalId(value) {
    if (typeof value !== 'string') return '';
    const uuid = value.match(/^(?:\d{17}::)?([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i);
    return uuid ? uuid[1].toLowerCase() : value;
}

// Include still-open plans and any plan with activity or closure on this ET day.
// Earlier entry fills remain necessary to cost today's partial/overnight exits.
function selectV2RiskPlans({ plans, fills, now = new Date() }) {
    const day = easternSessionDate(now);
    const todayIds = new Set(fills.filter((fill) => easternSessionDate(fill.executed_at) === day).map((fill) => fill.plan_id));
    return plans.filter((plan) => !TERMINAL.has(plan.state) || todayIds.has(plan.id)
        || (plan.closed_at && easternSessionDate(plan.closed_at) === day));
}

// A v2-attributed, gross realized-loss measure, not whole-account P&L. Costs are
// known entry fills at each exit, never a later entry price or cached realized P&L.
function computeV2DailyRisk({ plans, fills, now = new Date() }) {
    const sessionDate = easternSessionDate(now);
    const reasons = new Set();
    const result = { complete: false, sessionDate, realizedPnl: null, fillCount: 0, reasonCodes: [] };
    const fail = (code) => reasons.add(code);
    const finish = () => ({ ...result, reasonCodes: [...reasons].sort() });
    if (!sessionDate || !Array.isArray(plans) || !Array.isArray(fills)) {
        fail('INVALID_RISK_INPUT');
        return finish();
    }
    const nowNanos = BigInt(now.getTime()) * 1000000n;
    const planById = new Map();
    for (const plan of plans) {
        if (!whole(plan.id) || plan.id === 0 || planById.has(plan.id) || !STATES.has(plan.state)) fail('INVALID_PLAN');
        planById.set(plan.id, plan);
        if (plan.closed_at && !parseEvidenceTime(plan.closed_at)) fail('INVALID_PLAN_TIME');
    }
    const relevant = selectV2RiskPlans({ plans, fills, now });
    const relevantIds = new Set(relevant.map((plan) => plan.id));
    const rows = [];
    const identities = new Map();
    for (const fill of fills) {
        const time = parseEvidenceTime(fill.executed_at);
        if (!time || time.nanoseconds > nowNanos) { fail('INVALID_FILL_TIME'); continue; }
        const today = easternSessionDate(fill.executed_at) === sessionDate;
        if (!relevantIds.has(fill.plan_id)) {
            if (today) fail('UNATTRIBUTED_FILL');
            continue;
        }
        const plan = planById.get(fill.plan_id);
        const id = canonicalId(fill.execution_id);
        if (!id || !plan || !whole(fill.qty) || fill.qty === 0 || typeof fill.price !== 'number' || !Number.isFinite(fill.price) || fill.price <= 0
            || fill.symbol !== plan.symbol || !['buy', 'sell'].includes(fill.side)
            || (fill.side === 'buy' ? fill.role !== 'entry' : !['bracket_exit', 'time_exit'].includes(fill.role))) {
            fail('INVALID_FILL'); continue;
        }
        const prior = identities.get(id);
        const material = JSON.stringify([fill.plan_id, fill.order_id, fill.symbol, fill.side, fill.role, fill.qty, fill.price, String(time.nanoseconds)]);
        if (prior !== undefined) {
            if (prior !== material) fail('CONFLICTING_EXECUTION');
            continue;
        }
        identities.set(id, material);
        rows.push({ ...fill, time, today });
    }
    rows.sort((a, b) => a.time.nanoseconds < b.time.nanoseconds ? -1 : a.time.nanoseconds > b.time.nanoseconds ? 1
        : a.side === b.side ? 0 : a.side === 'buy' ? -1 : 1);
    let pnl = 0;
    for (const plan of relevant) {
        if (['pending_submission', 'submission_unknown', 'attention_required'].includes(plan.state)) fail('UNRESOLVED_PLAN');
        if (!whole(plan.filled_entry_qty) || !whole(plan.filled_exit_qty)) fail('INVALID_PLAN_QUANTITY');
        let position = 0;
        let basis = 0;
        let bought = 0;
        let sold = 0;
        let entryNotional = 0;
        let exitNotional = 0;
        for (const fill of rows.filter((row) => row.plan_id === plan.id)) {
            if (fill.side === 'buy') {
                position += fill.qty;
                basis += fill.price * fill.qty;
                bought += fill.qty;
                entryNotional += fill.price * fill.qty;
            } else {
                if (fill.qty > position || position === 0) { fail('EXIT_WITHOUT_ENTRY_COST'); continue; }
                const cost = basis / position * fill.qty;
                if (fill.today) { pnl += fill.price * fill.qty - cost; result.fillCount += 1; }
                position -= fill.qty;
                basis -= cost;
                sold += fill.qty;
                exitNotional += fill.price * fill.qty;
            }
        }
        if (!Number.isFinite(basis) || !Number.isFinite(pnl)) fail('NONFINITE_ECONOMICS');
        if (plan.filled_entry_qty !== bought || plan.filled_exit_qty !== sold
            || (bought > 0 && !close(plan.avg_entry_price, entryNotional / bought))
            || (sold > 0 && !close(plan.avg_exit_price, exitNotional / sold))) fail('FILL_SUMMARY_MISMATCH');
        if (plan.state === 'closed' && (bought === 0 || bought !== sold)) fail('INCOMPLETE_CLOSED_PLAN');
        if (['cancelled', 'rejected'].includes(plan.state) && bought !== sold) fail('INCOMPLETE_TERMINAL_PLAN');
    }
    if (!reasons.size) {
        result.complete = true;
        result.realizedPnl = Math.round(pnl * 100) / 100;
    }
    return finish();
}

module.exports = { computeV2DailyRisk, easternSessionDate, selectV2RiskPlans };
