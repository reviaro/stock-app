'use strict';
const crypto = require('node:crypto');

// RFC 6238 / RFC 4226: authenticator-compatible SHA-1, 6 digits, 30-second steps.
function decodeSecret(value) {
    if (typeof value !== 'string' || !/^[A-Z2-7]{32,128}={0,6}$/i.test(value)) {
        throw new Error('TOTP secret must be a private base32 value with at least 160 bits.');
    }
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0, count = 0;
    const bytes = [];
    for (const character of value.toUpperCase().replace(/=+$/, '')) {
        bits = (bits << 5) | alphabet.indexOf(character);
        count += 5;
        if (count >= 8) { count -= 8; bytes.push((bits >>> count) & 255); }
    }
    if (count && (bits & ((1 << count) - 1))) throw new Error('TOTP secret has invalid base32 padding.');
    return Buffer.from(bytes);
}

function codeAt(secret, counter, digits = 6) {
    const key = Buffer.isBuffer(secret) ? secret : decodeSecret(secret);
    const moving = Buffer.alloc(8);
    moving.writeBigUInt64BE(BigInt(counter));
    const digest = crypto.createHmac('sha1', key).update(moving).digest();
    const offset = digest[digest.length - 1] & 15;
    return String((digest.readUInt32BE(offset) & 0x7fffffff) % (10 ** digits)).padStart(digits, '0');
}

function matchCounter(secret, code, nowMs, afterCounter = -1) {
    if (typeof code !== 'string' || !/^\d{6}$/.test(code) || !Number.isFinite(nowMs) || nowMs < 0) return null;
    const current = Math.floor(nowMs / 30000);
    let matched = null;
    for (const counter of [current - 1, current, current + 1]) {
        if (counter < 0) continue;
        if (crypto.timingSafeEqual(Buffer.from(code), Buffer.from(codeAt(secret, counter))) && counter > afterCounter) matched = counter;
    }
    return matched;
}

module.exports = { decodeSecret, codeAt, matchCounter };
