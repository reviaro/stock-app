const { test } = require('node:test');
const assert = require('node:assert/strict');

const { resolveListenHost } = require('../server');

test('dashboard listens on loopback by default', () => {
    assert.equal(resolveListenHost({}), '127.0.0.1');
});

test('dashboard refuses an insecure all-interface listener', () => {
    assert.throws(() => resolveListenHost({
        STOCK_DASHBOARD_HOST: '0.0.0.0',
        STOCK_DASHBOARD_SECURE_COOKIE: '0',
    }), /loopback|reverse proxy/i);
});

test('dashboard refuses all non-loopback listeners even when secure cookies are configured', () => {
    assert.throws(() => resolveListenHost({
        STOCK_DASHBOARD_HOST: '0.0.0.0',
        STOCK_DASHBOARD_SECURE_COOKIE: '1',
        STOCK_DASHBOARD_PUBLIC_ORIGIN: 'https://stocks.example.com',
    }), /loopback|reverse proxy/i);
});

test('dashboard permits the IPv6 loopback listener', () => {
    assert.equal(resolveListenHost({ STOCK_DASHBOARD_HOST: '::1' }), '::1');
});
