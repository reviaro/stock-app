'use strict';

// Pure v2 strategy analytics: does the decision process have positive expectancy? Only closed
// v2 trades with a realized outcome count. Operator-resolved plans, unclosed plans, NO TRADE
// decisions, and attention incidents are reported separately and never enter expectancy.

const { deriveFillTrade, observationSummary } = require('./alpaca_day_trade_v2_research');

// An operational review threshold, never a statistical proof of an edge.
const PRELIMINARY_SAMPLE_SIZE = 30;

const round = (value, places) => (value == null || !Number.isFinite(value) ? null : Math.round(value * 10 ** places) / 10 ** places);

function easternMinutes(iso) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso));
    const get = (type) => Number(parts.find((part) => part.type === type).value);
    return get('hour') * 60 + get('minute');
}

function easternDate(iso) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

// Entry-time windows in exchange time: open (to 10:30), midday (to 14:00), late (after).
function timeWindow(iso) {
    const minutes = easternMinutes(iso);
    if (minutes < 10 * 60 + 30) return 'open';
    if (minutes < 14 * 60) return 'midday';
    return 'late';
}

function summarize(trades) {
    const count = trades.length;
    const wins = trades.filter((trade) => trade.realized_pnl > 0);
    const losses = trades.filter((trade) => trade.realized_pnl < 0);
    const realizedPnl = trades.reduce((sum, trade) => sum + trade.realized_pnl, 0);
    const withR = trades.filter((trade) => Number.isFinite(trade.realized_r));
    const withActualR = trades.filter((trade) => Number.isFinite(trade.actual_risk_r));
    return {
        count,
        winRate: count ? round(wins.length / count, 4) : null,
        realizedPnl: round(realizedPnl, 2),
        expectancyDollars: count ? round(realizedPnl / count, 2) : null,
        expectancyR: withR.length ? round(withR.reduce((sum, trade) => sum + trade.realized_r, 0) / withR.length, 4) : null,
        expectancyActualRiskR: withActualR.length ? round(withActualR.reduce((sum, trade) => sum + trade.actual_risk_r, 0) / withActualR.length, 4) : null,
        wins,
        losses,
    };
}

function breakdown(trades, keyOf) {
    const groups = new Map();
    for (const trade of trades) {
        const key = keyOf(trade);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(trade);
    }
    return Object.fromEntries([...groups].map(([key, group]) => {
        const { wins: _wins, losses: _losses, ...stats } = summarize(group);
        return [key, stats];
    }));
}

function computeV2Analytics({ plans = [], events = [], fills = [], observations = [] }) {
    const closed = plans.filter((plan) => plan.state === 'closed');
    const candidates = closed.filter((plan) => plan.exit_reason !== 'operator_resolved');
    const trades = candidates.map((plan) => deriveFillTrade(plan, fills)).filter(Boolean)
        .sort((a, b) => String(a.closed_at).localeCompare(String(b.closed_at)));
    const base = summarize(trades);
    const grossProfit = base.wins.reduce((sum, trade) => sum + trade.realized_pnl, 0);
    const grossLoss = Math.abs(base.losses.reduce((sum, trade) => sum + trade.realized_pnl, 0));

    let streak = 0;
    let maxConsecutiveLosses = 0;
    let cumulative = 0; let peak = 0; let maxDrawdown = 0;
    for (const trade of trades) {
        streak = trade.realized_pnl < 0 ? streak + 1 : 0;
        maxConsecutiveLosses = Math.max(maxConsecutiveLosses, streak);
        cumulative += trade.realized_pnl;
        peak = Math.max(peak, cumulative);
        maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
    }
    const holds = trades.filter((trade) => trade.opened_at && trade.closed_at)
        .map((trade) => (new Date(trade.closed_at) - new Date(trade.opened_at)) / 60_000);

    const tally = (rows, field) => Object.fromEntries(rows.reduce((acc, row) => {
        const key = row[field] || 'UNSPECIFIED';
        acc.set(key, (acc.get(key) || 0) + 1);
        return acc;
    }, new Map()));
    const decisions = events.filter((event) => event.event_type === 'decision');
    const anomalies = events.filter((event) => event.event_type === 'anomaly');
    const timed = trades.filter((trade) => trade.opened_at);
    const measured = trades.map((trade) => observationSummary(trade, observations));

    return {
        closedTradeCount: base.count,
        wins: base.wins.length,
        losses: base.losses.length,
        winRate: base.winRate,
        grossProfit: round(grossProfit, 2),
        grossLoss: round(grossLoss, 2),
        profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss, 4) : null,
        averageWin: base.wins.length ? round(grossProfit / base.wins.length, 2) : null,
        averageLoss: base.losses.length ? round(-grossLoss / base.losses.length, 2) : null,
        expectancyDollars: base.expectancyDollars,
        expectancyR: base.expectancyR,
        expectancyActualRiskR: base.expectancyActualRiskR,
        realizedPnl: base.realizedPnl,
        maxConsecutiveLosses,
        maxClosedTradeDrawdownDollars: round(maxDrawdown, 2),
        averageHoldMinutes: holds.length ? round(holds.reduce((sum, minutes) => sum + minutes, 0) / holds.length, 1) : null,
        bySetup: breakdown(trades, (trade) => trade.setup_id || 'legacy_unclassified'),
        byCatalyst: breakdown(trades, (trade) => trade.catalyst_class || 'unclassified'),
        byStrategyVersion: breakdown(trades, (trade) => trade.strategy_version || 'legacy_unversioned'),
        byExitReason: breakdown(trades, (trade) => trade.exit_reason || 'unknown'),
        byWindow: breakdown(timed, (trade) => timeWindow(trade.opened_at)),
        bySessionDate: breakdown(timed, (trade) => easternDate(trade.opened_at)),
        noTrade: { count: decisions.length, byReason: tally(decisions, 'reason_code') },
        attention: { count: anomalies.length, byCode: tally(anomalies, 'reason_code') },
        excludedOperatorResolved: closed.length - candidates.length,
        excludedIncompleteFills: candidates.length - trades.length,
        evidence: {
            classifiedTrades: trades.filter((trade) => trade.setup_id && trade.setup_id !== 'legacy_unclassified'
                && trade.strategy_version && trade.strategy_version !== 'legacy_unversioned' && trade.catalyst_class && trade.catalyst_class !== 'unclassified').length,
            measuredTrades: measured.filter((summary) => summary.complete).length,
            totalTrades: trades.length,
            sampledObservationCount: measured.reduce((sum, summary) => sum + summary.count, 0),
        },
        sample: {
            size: base.count,
            preliminary: base.count < PRELIMINARY_SAMPLE_SIZE,
            note: base.count < PRELIMINARY_SAMPLE_SIZE
                ? `Preliminary: ${base.count} verified closed trades is below the ${PRELIMINARY_SAMPLE_SIZE}-trade review threshold. Gross paper results exclude costs and do not establish an edge.`
                : `Sample of ${base.count} verified closed paper trades. Meeting the review threshold does not establish an edge; results exclude costs.`,
        },
    };
}

module.exports = { computeV2Analytics, PRELIMINARY_SAMPLE_SIZE, timeWindow };
