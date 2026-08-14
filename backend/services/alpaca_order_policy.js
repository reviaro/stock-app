function validatePaperOrder({ order, account, asset }) {
    const symbol = String(order?.symbol || '').trim().toUpperCase();
    const qty = Number(order?.qty);
    const side = order?.side;
    const type = order?.type;
    const timeInForce = order?.time_in_force;

    if (!symbol || !Number.isInteger(qty) || qty <= 0) {
        throw new Error('Alpaca paper orders require a symbol and positive whole shares');
    }
    if (side !== 'buy' || type !== 'limit' || timeInForce !== 'day') {
        throw new Error('Only day limit buy orders are permitted');
    }
    if (account?.status !== 'ACTIVE' || account?.trading_blocked || account?.account_blocked) {
        throw new Error('Alpaca paper account must be active and unblocked');
    }
    if (order.extended_hours) throw new Error('extended-hours orders are disabled');
    if (order.order_class && order.order_class !== 'simple') throw new Error('advanced order classes are disabled');
    if (order.notional != null || order.stop_price != null || order.trail_price != null || order.trail_percent != null) {
        throw new Error('Notional, stop, and trailing orders are disabled');
    }
    if (!asset || asset.class !== 'us_equity' || asset.status !== 'active' || !asset.tradable) {
        throw new Error('Only active, tradable US equities are permitted');
    }

    const normalized = { symbol, side, qty, type, time_in_force: timeInForce };
    if (type === 'limit') {
        const limitPrice = Number(order.limit_price);
        if (!(limitPrice > 0)) throw new Error('Limit orders require a positive limit price');
        normalized.limit_price = limitPrice;
    }

    const availableCash = Number(account?.cash);
    if (!Number.isFinite(availableCash) || availableCash < 0) {
        throw new Error('Buy requires a valid cash balance');
    }
    const estimatedCost = qty * normalized.limit_price;
    if (estimatedCost > availableCash) throw new Error('Buy exceeds available cash');
    return normalized;
}

module.exports = { validatePaperOrder };
