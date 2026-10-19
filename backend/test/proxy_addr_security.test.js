'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const proxyaddr = require('proxy-addr');
const { createApp, isAllowedClientAddress } = require('../server');

function requestFrom(remoteAddress, forwardedFor) {
    return { socket: { remoteAddress }, headers: { 'x-forwarded-for': forwardedFor } };
}

// GHSA-jqcg-44mw-7w3h: a short IPv4-mapped IPv6 prefix must not make
// an unrelated network peer authoritative for a forged forwarded address.
test('malformed mapped trust subnets cannot turn an unrelated peer into a trusted proxy', () => {
    for (const subnets of [['::ffff:10.0.0.0/8'], ['::/1'], ['::ffff:10.0.0.0/8', '192.0.2.10']]) {
        const trust = proxyaddr.compile(subnets);
        for (const remoteAddress of ['203.0.113.42', '::ffff:203.0.113.42']) {
            const request = requestFrom(remoteAddress, '127.0.0.1');
            assert.equal(proxyaddr(request, trust), remoteAddress, `${subnets}: ${remoteAddress}`);
            assert.deepEqual(proxyaddr.all(request, trust), [remoteAddress]);
        }
    }
});

test('valid plain and fully mapped IPv4 subnets still trust only their intended network', () => {
    for (const subnet of ['10.0.0.0/8', '::ffff:10.0.0.0/104']) {
        const trust = proxyaddr.compile(subnet);
        for (const remoteAddress of ['10.2.3.4', '::ffff:10.2.3.4']) {
            assert.equal(proxyaddr(requestFrom(remoteAddress, '203.0.113.77'), trust), '203.0.113.77');
        }
        assert.equal(proxyaddr(requestFrom('203.0.113.42', '127.0.0.1'), trust), '203.0.113.42');
    }
});

test('dashboard keeps forwarded headers outside its socket-address access boundary', () => {
    const pass = (_req, _res, next) => next();
    const env = { STOCK_DASHBOARD_TRUSTED_PROXY_IP: '192.0.2.10' };
    const app = createApp({ env, auth: { router: express.Router(), securityHeaders: pass, requireAuth: pass } });
    assert.equal(app.get('trust proxy'), false);
    for (const peer of ['192.0.2.10', '203.0.113.42']) {
        const request = Object.assign(Object.create(app.request), requestFrom(peer, '127.0.0.1'), { app });
        assert.equal(request.ip, peer);
        assert.deepEqual(request.ips, []);
        assert.equal(isAllowedClientAddress(request.socket.remoteAddress, env), peer === '192.0.2.10');
    }
});
