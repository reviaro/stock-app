const { test } = require('node:test');
const assert = require('node:assert');
const { sanitizeBrokerMessage } = require('../services/alpaca_broker_error');

test('G-1 sanitizeBrokerMessage unit tests: UUID, account id, URL, email, IP, api_key, truncation, short numbers', () => {
    // Non-string / empty
    assert.strictEqual(sanitizeBrokerMessage(null), null);
    assert.strictEqual(sanitizeBrokerMessage(undefined), null);
    assert.strictEqual(sanitizeBrokerMessage(12345), null);
    assert.strictEqual(sanitizeBrokerMessage(''), null);
    assert.strictEqual(sanitizeBrokerMessage('   '), null);

    // UUID
    assert.strictEqual(
        sanitizeBrokerMessage('order 12345678-1234-1234-1234-123456789abc failed'),
        'order [id] failed',
    );

    // Account id like PA3ABCD12345
    assert.strictEqual(
        sanitizeBrokerMessage('account PA3ABCD12345 restricted'),
        'account [redacted] restricted',
    );

    // URL
    assert.strictEqual(
        sanitizeBrokerMessage('see https://example.com/docs/error?code=1 for info'),
        'see [url] for info',
    );

    // Email
    assert.strictEqual(
        sanitizeBrokerMessage('contact support@alpaca.markets for help'),
        'contact [email] for help',
    );

    // IPv4
    assert.strictEqual(
        sanitizeBrokerMessage('connection from 192.168.1.100 rejected'),
        'connection from [ip] rejected',
    );

    // Key-like words
    assert.strictEqual(
        sanitizeBrokerMessage('failed with api_key=secretKey123 and token: myToken456'),
        'failed with api_key=[redacted] and token=[redacted]',
    );

    // Authorization / bearer / basic / token with spaces
    assert.strictEqual(
        sanitizeBrokerMessage('header Authorization: Bearer abc.def was rejected'),
        'header Authorization=[redacted] was rejected',
    );
    assert.strictEqual(
        sanitizeBrokerMessage('auth token = xyz expired'),
        'auth token=[redacted] expired',
    );
    assert.strictEqual(
        sanitizeBrokerMessage('credentials Basic dXNlcjpwYXNz invalid'),
        'credentials Basic [redacted] invalid',
    );

    // 400-char input -> 200
    const longInput = 'x'.repeat(400);
    const sanitizedLong = sanitizeBrokerMessage(longInput);
    assert.strictEqual(sanitizedLong.length, 200);

    // Short numbers intact
    const intactMsg = 'insufficient qty available for order (requested: 10, available: 0)';
    assert.strictEqual(sanitizeBrokerMessage(intactMsg), intactMsg);
});

test('N5-t1 unit: labeled and our own client/order identifiers sanitized', () => {
    const res1 = sanitizeBrokerMessage('client_order_id=dt-timeexit-42-a1 already exists');
    assert.strictEqual(res1.includes('dt-timeexit-42-a1'), false, 'no dt-timeexit-42-a1 in output');

    const res2 = sanitizeBrokerMessage('order_id: 1234abcd');
    assert.strictEqual(res2.includes('1234abcd'), false, '1234abcd must be redacted');
    assert.ok(res2.includes('[redacted]'), 'must contain [redacted]');

    const res3 = sanitizeBrokerMessage('account PA3ABCD123');
    assert.strictEqual(res3.includes('PA3ABCD123'), false, 'PA3ABCD123 must be redacted');
    assert.ok(res3.includes('[redacted]'), 'must contain [redacted]');
});
