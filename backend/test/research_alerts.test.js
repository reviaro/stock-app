'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateRule, evaluateAlert } = require('../services/research_alerts');
const now = new Date('2026-11-12T15:00:00Z');
const rule = { symbol: 'TEST', condition: 'below', threshold: 100, repeat: false };
const quote = (price, timestamp = now.toISOString()) => ({ status: 'success', data: { symbol: 'TEST', currency: 'USD', price, regularMarketPreviousClose: 100, timestamp } });
test('alerts reject invalid rules and unverified prices', () => {
    for (const threshold of [null, '10', 0, -1, Infinity, NaN, true]) assert.throws(() => validateRule({ ...rule, threshold }));
    assert.throws(() => validateRule({ ...rule, symbol: '../TEST' }));
    assert.equal(validateRule({ ...rule, symbol: ' test ' }).symbol, 'TEST');
    for (const data of [{ timestamp: null }, { timestamp: '2020-01-01' }, { timestamp: '2027-01-01' }, { currency: 'EUR' },
        { symbol: 'OTHER' }, { isDemo: true }, { priceBasis: 'unadjusted_daily_bar' }, { price: NaN }]) {
        assert.equal(evaluateAlert(rule, {}, { ...quote(90), data: { ...quote(90).data, ...data } }, now).hit, false);
    }
    assert.equal(evaluateAlert(rule, {}, { ...quote(90), meta: { stale: true } }, now).hit, false);
});
test('one-time alerts persist their triggered state and ignore duplicate or older quotes', () => {
    const first = evaluateAlert(rule, {}, quote(90), now);
    assert.equal(first.hit, true); assert.equal(first.state.triggerCount, 1);
    assert.equal(evaluateAlert(rule, first.state, quote(90), now).hit, false);
    assert.equal(evaluateAlert(rule, first.state, quote(90, '2026-11-12T14:59:00Z'), now).hit, false);
    assert.equal(evaluateAlert(rule, first.state, quote(90, '2026-11-12T15:01:00Z'), new Date('2026-11-12T15:01:00Z')).hit, false);
});
test('repeating levels re-arm only after an observed move away, then cross again', () => {
    const repeating = { ...rule, repeat: true };
    let result = evaluateAlert(repeating, {}, quote(90), now);
    const next = (price, minute) => result = evaluateAlert(repeating, result.state, quote(price, `2026-11-12T15:0${minute}:00Z`), new Date(`2026-11-12T15:0${minute}:00Z`));
    assert.equal(next(95, 1).hit, false); assert.equal(next(101, 2).state.armed, true);
    assert.equal(next(100, 3).hit, true); assert.equal(result.state.triggerCount, 2);
});
test('daily percentage alerts need a previous close and fire at most once per New York date', () => {
    const daily = { ...rule, condition: 'pct_up', threshold: 5, repeat: true };
    const first = evaluateAlert(daily, {}, quote(106), now);
    assert.equal(first.hit, true);
    assert.equal(evaluateAlert(daily, first.state, quote(110, '2026-11-12T15:01:00Z'), new Date('2026-11-12T15:01:00Z')).hit, false);
    assert.equal(evaluateAlert(daily, first.state, quote(106, '2026-11-13T15:00:00Z'), new Date('2026-11-13T15:00:00Z')).hit, true);
    const bad = quote(106); bad.data.regularMarketPreviousClose = 0; bad.data.previousClose = 90;
    assert.equal(evaluateAlert(daily, {}, bad, now).hit, false);
    assert.match(evaluateAlert(daily, {}, bad, now).warning, /Previous close/);
});
