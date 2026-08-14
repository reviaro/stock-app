function finiteNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function alert(type, severity, symbol, message, details = {}) {
    return { type, severity, symbol, message, ...details };
}

function buildRiskMonitor({
    holdings = {},
    plans = [],
    quotes = {},
    checkedAt = new Date().toISOString(),
    marketOpen = false,
    staleAfterSeconds = 180,
} = {}) {
    const checkedMs = Date.parse(checkedAt);
    const activePlans = plans.filter((plan) => plan.status === 'active');
    const planBySymbol = new Map(activePlans.map((plan) => [String(plan.symbol).toUpperCase(), plan]));
    const alerts = [];
    const positions = [];

    for (const [rawSymbol, holding] of Object.entries(holdings)) {
        const symbol = rawSymbol.toUpperCase();
        const plan = planBySymbol.get(symbol) || null;
        const quote = quotes[symbol] || {};
        const price = finiteNumber(quote.price);
        const quoteMs = quote.timestamp ? Date.parse(quote.timestamp) : NaN;
        const ageSeconds = Number.isFinite(checkedMs) && Number.isFinite(quoteMs)
            ? Math.max(0, Math.round((checkedMs - quoteMs) / 1000))
            : null;

        positions.push({
            symbol,
            shares: finiteNumber(holding.shares),
            avg_cost: finiteNumber(holding.avg_cost),
            current_price: price,
            quote_timestamp: quote.timestamp || null,
            price_age_seconds: ageSeconds,
            market_state: quote.market_state || null,
            data_source: quote.data_source || 'unavailable',
            plan,
        });

        if (!plan) {
            alerts.push(alert('missing_plan', 'critical', symbol, `${symbol} has an open position without a structured risk plan.`));
            continue;
        }
        const heldShares = finiteNumber(holding.shares);
        const plannedShares = finiteNumber(plan.shares);
        if (heldShares != null && plannedShares != null && Math.abs(heldShares - plannedShares) > 0.000001) {
            alerts.push(alert('plan_share_mismatch', 'critical', symbol, `${symbol} position size does not match its documented risk plan.`, { held_shares: heldShares, planned_shares: plannedShares }));
            continue;
        }
        if (price == null) {
            alerts.push(alert('price_unavailable', 'critical', symbol, `${symbol} cannot be monitored because its current price is unavailable.`));
            continue;
        }
        if (marketOpen && ageSeconds != null && ageSeconds > staleAfterSeconds) {
            alerts.push(alert('stale_price', 'critical', symbol, `${symbol} quote is stale; risk thresholds were not evaluated.`, { price_age_seconds: ageSeconds }));
            continue;
        }

        const stop = finiteNumber(plan.stop_price);
        const target = finiteNumber(plan.target_price);
        if (stop != null && price <= stop) {
            alerts.push(alert('stop_breached', 'critical', symbol, `${symbol} is at or below its documented hard stop.`, { current_price: price, threshold: stop }));
        } else if (target != null && price >= target) {
            alerts.push(alert('target_hit', 'info', symbol, `${symbol} is at or above its documented target.`, { current_price: price, threshold: target }));
        }
    }

    const heldSymbols = new Set(Object.keys(holdings).map((symbol) => symbol.toUpperCase()));
    for (const plan of activePlans) {
        const symbol = String(plan.symbol).toUpperCase();
        if (!heldSymbols.has(symbol)) {
            alerts.push(alert('orphan_plan', 'warning', symbol, `${symbol} has an active plan but no matching open position.`, { plan_id: plan.id }));
        }
    }

    const severityRank = { critical: 0, warning: 1, info: 2 };
    alerts.sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || a.symbol.localeCompare(b.symbol));

    return {
        read_only: true,
        execution_enabled: false,
        checked_at: checkedAt,
        market_open: Boolean(marketOpen),
        stale_after_seconds: staleAfterSeconds,
        positions,
        alerts,
    };
}

module.exports = { buildRiskMonitor };
