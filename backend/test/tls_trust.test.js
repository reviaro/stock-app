'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const tls = require('node:tls');
const { X509Certificate } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { trustedCertificates, initializeTlsTrust, DISTRUSTED_SHA256 } = require('../services/tls_trust');
const affected = require('./fixtures/emsign-g3-public-ca.json').pem;

test('trust policy removes the compromised root while retaining unrelated trusted roots', () => {
    const unrelated = tls.rootCertificates.find(pem => !DISTRUSTED_SHA256.has(new X509Certificate(pem).fingerprint256));
    assert.deepEqual(trustedCertificates([unrelated,affected]),[unrelated]);
    assert.throws(()=>trustedCertificates([affected]),/no approved/);
    assert.throws(()=>trustedCertificates([]),/empty/);
});

test('startup refuses disabled certificate verification and unsupported runtimes', () => {
    assert.throws(()=>initializeTlsTrust({env:{NODE_TLS_REJECT_UNAUTHORIZED:'0'}}),/must remain enabled/);
    assert.throws(()=>initializeTlsTrust({runtime:{},env:{}}),/requires Node/);
});

test('initialization replaces rather than augments the default CA set', () => {
    const unrelated = tls.rootCertificates.find(pem => !DISTRUSTED_SHA256.has(new X509Certificate(pem).fingerprint256));
    let current = [unrelated,affected];
    const runtime = { getCACertificates:()=>current,setDefaultCACertificates:value=>{current=value;} };
    assert.deepEqual(initializeTlsTrust({runtime,env:{}}),{trustedRoots:1,removedRoots:1});
    assert.deepEqual(current,[unrelated]);
});

test('application HTTP startup applies distrust without replacing native fetch', () => {
    const child = spawnSync(process.execPath,['-e',`
        const assert=require('node:assert/strict');
        const native=globalThis.fetch;
        require('./services/http_runtime');
        const tls=require('node:tls');
        const {trustedCertificates}=require('./services/tls_trust');
        const certs=tls.getCACertificates('default');
        assert.equal(trustedCertificates(certs).length,certs.length);
        assert.equal(globalThis.fetch,native);
    `],{cwd:require('node:path').resolve(__dirname,'..'),encoding:'utf8',timeout:5000});
    assert.equal(child.status,0,child.stderr);
});
