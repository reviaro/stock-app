'use strict';

const tls = require('node:tls');
const { X509Certificate } = require('node:crypto');

// The October 2026 emSign incident requires distrust, not a TLS-verification
// exception. Keep unaffected roots and caller-installed private CAs intact.
const DISTRUSTED_SHA256 = new Set([
    '86:A1:EC:BA:08:9C:4A:8D:3B:BE:27:34:C6:12:BA:34:1D:81:3E:04:3C:F9:E8:A8:62:CD:5C:57:A3:6B:BE:6B',
]);
const DISTRUSTED_NAMES = /(?:^|\n)CN=emSign (?:ECC Root CA - G3|Root TLS CA - G3)(?:\n|$)/;

function trustedCertificates(certificates) {
    if (!Array.isArray(certificates) || !certificates.length) throw new Error('TLS trust store is empty.');
    const retained = certificates.filter(pem => {
        const cert = new X509Certificate(pem);
        return !DISTRUSTED_SHA256.has(cert.fingerprint256) && !DISTRUSTED_NAMES.test(cert.subject);
    });
    if (!retained.length) throw new Error('TLS trust store has no approved certificates.');
    return retained;
}

function initializeTlsTrust({ runtime = tls, env = process.env } = {}) {
    if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('TLS certificate verification must remain enabled.');
    if (typeof runtime.getCACertificates !== 'function' || typeof runtime.setDefaultCACertificates !== 'function') {
        throw new Error('Oakline requires Node 24.5+ or 22.19+ with configurable TLS trust.');
    }
    const before = runtime.getCACertificates('default');
    const retained = trustedCertificates(before);
    // Run before importing HTTP clients: existing pooled TLS sessions cannot be
    // revoked by replacing the default trust set after a connection is opened.
    runtime.setDefaultCACertificates(retained);
    const after = runtime.getCACertificates('default');
    if (trustedCertificates(after).length !== after.length) throw new Error('TLS distrust could not be applied.');
    return { trustedRoots: after.length, removedRoots: before.length - retained.length };
}

module.exports = { trustedCertificates, initializeTlsTrust, DISTRUSTED_SHA256 };
