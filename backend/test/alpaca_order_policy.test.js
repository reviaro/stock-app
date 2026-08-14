const { test } = require('node:test');
const assert = require('node:assert');
const { validatePaperOrder } = require('../services/alpaca_order_policy');

const account = { status: 'ACTIVE', cash: '1000.00', buying_power: '4000.00' };
const asset = { class: 'us_equity', status: 'active', tradable: true };

test('approves a whole-share long buy covered by cash', () => {
    assert.deepStrictEqual(validatePaperOrder({
        order: { symbol: 'MSFT', side: 'buy', qty: 2, type: 'limit', limit_price: 400, time_in_force: 'day' },
        account,
        asset,
        positionQty: 0,
    }), {
        symbol: 'MSFT', side: 'buy', qty: 2, type: 'limit', limit_price: 400, time_in_force: 'day',
    });
});

test('rejects a buy that exceeds cash even when buying power is higher', () => {
    assert.throws(() => validatePaperOrder({
        order: { symbol: 'MSFT', side: 'buy', qty: 3, type: 'limit', limit_price: 400, time_in_force: 'day' },
        account,
        asset,
        positionQty: 0,
    }), /cash/);
});

test('rejects fractional quantities and extended-hours orders', () => {
    assert.throws(() => validatePaperOrder({
        order: { symbol: 'MSFT', side: 'buy', qty: 1.5, type: 'market', time_in_force: 'day' }, account, asset, positionQty: 0,
    }), /whole shares/);
    assert.throws(() => validatePaperOrder({
        order: { symbol: 'MSFT', side: 'buy', qty: 1, type: 'limit', limit_price: 400, time_in_force: 'day', extended_hours: true }, account, asset, positionQty: 0,
    }), /extended-hours/);
});

test('rejects every sell instead of permitting a short-sale check', () => {
    assert.throws(() => validatePaperOrder({
        order: { symbol: 'MSFT', side: 'sell', qty: 3, type: 'market', time_in_force: 'day' }, account, asset, positionQty: 2,
    }), /limit buy orders/);
});

test('rejects non-equities and advanced order fields', () => {
    assert.throws(() => validatePaperOrder({
        order: { symbol: 'BTC/USD', side: 'buy', qty: 1, type: 'limit', limit_price: 400, time_in_force: 'day' }, account, asset: { ...asset, class: 'crypto' }, positionQty: 0,
    }), /US equities/);
    assert.throws(() => validatePaperOrder({
        order: { symbol: 'MSFT', side: 'buy', qty: 1, type: 'limit', limit_price: 400, time_in_force: 'day', order_class: 'bracket' }, account, asset, positionQty: 0,
    }), /advanced/);
});

test('rejects every sell and every market order before broker submission', () => {
    assert.throws(() => validatePaperOrder({
        order: { symbol: 'MSFT', side: 'sell', qty: 1, type: 'limit', limit_price: 400, time_in_force: 'day' }, account, asset, positionQty: 1,
    }), /limit buy orders/);
    assert.throws(() => validatePaperOrder({
        order: { symbol: 'MSFT', side: 'buy', qty: 1, type: 'market', time_in_force: 'day' }, account, asset, positionQty: 0,
    }), /limit buy orders/);
});

test('fails closed when fresh broker cash is missing or malformed', () => {
    for (const cash of [undefined, 'not-a-number']) {
        assert.throws(() => validatePaperOrder({
            order: { symbol: 'MSFT', side: 'buy', qty: 1, type: 'limit', limit_price: 400, time_in_force: 'day' },
            account: { status: 'ACTIVE', cash }, asset, positionQty: 0,
        }), /valid cash/);
    }
});

test('rejects inactive or trade-blocked broker accounts', () => {
    for (const rejectedAccount of [
        { ...account, status: 'INACTIVE' },
        { ...account, status: 'ACTIVE', trading_blocked: true },
        { ...account, status: 'ACTIVE', account_blocked: true },
    ]) {
        assert.throws(() => validatePaperOrder({
            order: { symbol: 'MSFT', side: 'buy', qty: 1, type: 'limit', limit_price: 400, time_in_force: 'day' },
            account: rejectedAccount, asset, positionQty: 0,
        }), /active and unblocked/);
    }
});
