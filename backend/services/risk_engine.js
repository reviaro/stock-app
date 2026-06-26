function computeBreaches({ positions = [], cash = 0, rules }) {
    const {
        max_position_pct,
        max_sector_pct,
        max_risk_per_trade_pct,
        target_cash_pct,
    } = rules;

    const positionsValue = positions.reduce((sum, position) => sum + (position.currentValue ?? 0), 0);
    const cashValue = cash == null ? 0 : cash;
    const totalValue = positionsValue + cashValue;
    const cashPct = totalValue > 0 && cash != null ? (cashValue / totalValue) * 100 : null;
    const breaches = [];

    if (totalValue <= 0) return { totalValue, cashPct, breaches };

    for (const position of positions) {
        if (position.currentValue == null) continue;
        const pct = (position.currentValue / totalValue) * 100;
        if (pct > max_position_pct) {
            breaches.push({
                kind: 'position',
                symbol: position.symbol,
                actual: Number(pct.toFixed(2)),
                limit: max_position_pct,
                message: `${position.symbol} is ${pct.toFixed(1)}% of portfolio (limit ${max_position_pct}%)`,
            });
        }
    }

    const sectorTotals = {};
    for (const position of positions) {
        const sector = position.sector || 'Unknown';
        sectorTotals[sector] = (sectorTotals[sector] ?? 0) + (position.currentValue ?? 0);
    }

    Object.entries(sectorTotals).forEach(([sector, value]) => {
        const pct = (value / totalValue) * 100;
        if (pct > max_sector_pct) {
            breaches.push({
                kind: 'sector',
                sector,
                actual: Number(pct.toFixed(2)),
                limit: max_sector_pct,
                message: `${sector} sector is ${pct.toFixed(1)}% of portfolio (limit ${max_sector_pct}%)`,
            });
        }
    });

    for (const position of positions) {
        if (position.stop_loss == null || position.currentPrice == null || position.shares == null) continue;
        if (position.stop_loss >= position.currentPrice) continue;
        const riskAmount = (position.currentPrice - position.stop_loss) * position.shares;
        const pct = (riskAmount / totalValue) * 100;
        if (pct > max_risk_per_trade_pct) {
            breaches.push({
                kind: 'risk_per_trade',
                symbol: position.symbol,
                actual: Number(pct.toFixed(2)),
                limit: max_risk_per_trade_pct,
                message: `${position.symbol} risk/trade is ${pct.toFixed(2)}% (limit ${max_risk_per_trade_pct}%)`,
            });
        }
    }

    if (cash != null && cashPct != null && cashPct < target_cash_pct) {
        breaches.push({
            kind: 'cash_below_target',
            actual: Number(cashPct.toFixed(2)),
            limit: target_cash_pct,
            message: `Cash is ${cashPct.toFixed(1)}% (target ${target_cash_pct}%)`,
        });
    }

    return { totalValue, cashPct, breaches };
}

module.exports = { computeBreaches };
