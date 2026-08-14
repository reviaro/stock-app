const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isAllowedClientAddress, resolveListenHost } = require('../server');

test('dashboard listens on loopback by default', () => {
    assert.equal(resolveListenHost({}), '127.0.0.1');
});

test('dashboard refuses an insecure all-interface listener', () => {
    assert.throws(() => resolveListenHost({
        STOCK_DASHBOARD_HOST: '0.0.0.0',
        STOCK_DASHBOARD_SECURE_COOKIE: '0',
    }), /secure cookies/i);
});

test('dashboard refuses all non-loopback listeners even when secure cookies are configured', () => {
    assert.throws(() => resolveListenHost({
        STOCK_DASHBOARD_HOST: '0.0.0.0',
        STOCK_DASHBOARD_SECURE_COOKIE: '1',
        STOCK_DASHBOARD_PUBLIC_ORIGIN: 'https://stocks.example.com',
    }), /trusted proxy/i);
});

test('dashboard permits the IPv6 loopback listener', () => {
    assert.equal(resolveListenHost({ STOCK_DASHBOARD_HOST: '::1' }), '::1');
});

test('dashboard permits a LAN proxy listener only with an exact trusted proxy and HTTPS origin', () => {
    assert.equal(resolveListenHost({
        STOCK_DASHBOARD_HOST: '0.0.0.0',
        STOCK_DASHBOARD_SECURE_COOKIE: '1',
        STOCK_DASHBOARD_PUBLIC_ORIGIN: 'https://stocks.example.com',
        STOCK_DASHBOARD_TRUSTED_PROXY_IP: '192.0.2.10',
    }), '0.0.0.0');
    assert.throws(() => resolveListenHost({
        STOCK_DASHBOARD_HOST: '0.0.0.0',
        STOCK_DASHBOARD_SECURE_COOKIE: '1',
        STOCK_DASHBOARD_PUBLIC_ORIGIN: 'http://stocks.example.com',
        STOCK_DASHBOARD_TRUSTED_PROXY_IP: '192.0.2.10',
    }), /HTTPS public origin/i);
    assert.throws(() => resolveListenHost({
        STOCK_DASHBOARD_HOST: '0.0.0.0',
        STOCK_DASHBOARD_SECURE_COOKIE: '1',
        STOCK_DASHBOARD_PUBLIC_ORIGIN: 'https://stocks.example.com',
    }), /trusted proxy/i);
});

test('listener source guard allows only loopback and the configured LAN proxy', () => {
    const env = { STOCK_DASHBOARD_TRUSTED_PROXY_IP: '192.0.2.10' };
    assert.equal(isAllowedClientAddress('127.0.0.1', env), true);
    assert.equal(isAllowedClientAddress('::1', env), true);
    assert.equal(isAllowedClientAddress('::ffff:127.0.0.1', env), true);
    assert.equal(isAllowedClientAddress('192.0.2.10', env), true);
    assert.equal(isAllowedClientAddress('::ffff:192.0.2.10', env), true);
    assert.equal(isAllowedClientAddress('192.0.2.44', env), false);
});
