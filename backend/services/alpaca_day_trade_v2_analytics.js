'use strict';

// Pure v2 strategy analytics: does the decision process have positive expectancy? Only closed
// v2 trades with a realized outcome count. Operator-resolved plans, unclosed plans, NO TRADE
// decisions, and attention incidents are reported separately and never enter expectancy.

// Below this many closed trades, any win rate or expectancy is noise, not evidence.
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

const catalystClass = (value) => String(value || 'unspecified').trim().toLowerCase() || 'unspecified';

function summarize(trades) {
    const count = trades.length;
    const wins = trades.filter((trade) => trade.realized_pnl > 0);
    const losses = trades.filter((trade) => trade.realized_pnl < 0);
    const realizedPnl = trades.reduce((sum, trade) => sum + trade.realized_pnl, 0);
    const withR = trades.filter((trade) => Number.isFinite(trade.realized_r));
    return {
        count,
        winRate: count ? round(wins.length / count, 4) : null,
        realizedPnl: round(realizedPnl, 2),
        expectancyDollars: count ? round(realizedPnl / count, 2) : null,
        expectancyR: withR.length ? round(withR.reduce((sum, trade) => sum + trade.realized_r, 0) / withR.length, 4) : null,
        wins,
        losses,
    };
}

function breakdown(trades, keyOf) {
    const groups = {};
    for (const trade of trades) (groups[keyOf(trade)] ||= []).push(trade);
    return Object.fromEntries(Object.entries(groups).map(([key, group]) => {
        const { wins: _wins, losses: _losses, ...stats } = summarize(group);
        return [key, stats];
    }));
}

function computeV2Analytics({ plans = [], events = [] }) {
    const closed = plans.filter((plan) => plan.state === 'closed' && Number.isFinite(plan.realized_pnl));
    const trades = closed.filter((plan) => plan.exit_reason !== 'operator_resolved')
        .sort((a, b) => String(a.closed_at).localeCompare(String(b.closed_at)));
    const base = summarize(trades);
    const grossProfit = base.wins.reduce((sum, trade) => sum + trade.realized_pnl, 0);
    const grossLoss = Math.abs(base.losses.reduce((sum, trade) => sum + trade.realized_pnl, 0));

    let streak = 0;
    let maxConsecutiveLosses = 0;
    for (const trade of trades) {
        streak = trade.realized_pnl < 0 ? streak + 1 : 0;
        maxConsecutiveLosses = Math.max(maxConsecutiveLosses, streak);
    }
    const holds = trades.filter((trade) => trade.opened_at && trade.closed_at)
        .map((trade) => (new Date(trade.closed_at) - new Date(trade.opened_at)) / 60_000);

    const tally = (rows, field) => rows.reduce((acc, row) => {
        const key = row[field] || 'UNSPECIFIED';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
    }, {});
    const decisions = events.filter((event) => event.event_type === 'decision');
    const anomalies = events.filter((event) => event.event_type === 'anomaly');
    const timed = trades.filter((trade) => trade.opened_at);

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
        realizedPnl: base.realizedPnl,
        maxConsecutiveLosses,
        averageHoldMinutes: holds.length ? round(holds.reduce((sum, minutes) => sum + minutes, 0) / holds.length, 1) : null,
        bySetup: breakdown(trades, (trade) => String(trade.setup || 'unspecified').trim().toLowerCase()),
        byCatalyst: breakdown(trades, (trade) => catalystClass(trade.catalyst)),
        byWindow: breakdown(timed, (trade) => timeWindow(trade.opened_at)),
        bySessionDate: breakdown(timed, (trade) => easternDate(trade.opened_at)),
        noTrade: { count: decisions.length, byReason: tally(decisions, 'reason_code') },
        attention: { count: anomalies.length, byCode: tally(anomalies, 'reason_code') },
        excludedOperatorResolved: closed.length - trades.length,
        sample: {
            size: base.count,
            preliminary: base.count < PRELIMINARY_SAMPLE_SIZE,
            note: base.count < PRELIMINARY_SAMPLE_SIZE
                ? `Preliminary: ${base.count} closed trades is below the ${PRELIMINARY_SAMPLE_SIZE}-trade minimum; these figures are not evidence of profitability.`
                : `Sample of ${base.count} closed paper trades; past paper results do not guarantee future results.`,
        },
    };
}

module.exports = { computeV2Analytics, PRELIMINARY_SAMPLE_SIZE, timeWindow };
