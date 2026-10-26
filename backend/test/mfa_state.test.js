'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createMfaState } = require('../services/mfa_state');

const KEY = Buffer.alloc(20, 7);
async function fixture(fn) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oakline-mfa-state-'));
    try { await fn(path.join(directory, 'state.json')); }
    finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test('durable counters reject replay across recreated auth instances and key changes', async () => fixture(async file => {
    assert.equal(createMfaState(file, KEY).consume(100), true);
    assert.equal(createMfaState(file, KEY).consume(100), false);
    assert.equal(createMfaState(file, KEY).consume(99), false);
    assert.equal(createMfaState(file, KEY).consume(101), true);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.throws(() => createMfaState(file, Buffer.alloc(20, 8)), { code: 'AUTH_MFA_UNAVAILABLE' });
}));

test('concurrent processes can consume a counter at most once', async () => fixture(async file => {
    const source = `const {createMfaState}=require(${JSON.stringify(path.resolve(__dirname, '../services/mfa_state'))});
        try { process.stdout.write(JSON.stringify({accepted:createMfaState(process.argv[1],Buffer.alloc(20,7)).consume(200)})); }
        catch(e) { process.stdout.write(JSON.stringify({accepted:false,code:e.code})); }`;
    const launch = () => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', source, file], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '', error = '';
        child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { error += chunk; });
        child.on('error', reject); child.on('close', code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(error)));
    });
    const results = await Promise.all([launch(), launch()]);
    assert.equal(results.filter(result => result.accepted).length, 1);
    assert.equal(createMfaState(file, KEY).consume(200), false);
}));

test('state corruption, unsafe permissions, symlinks and interrupted locks fail closed', async () => fixture(async file => {
    fs.writeFileSync(file, 'broken JSON', { mode: 0o600 });
    assert.throws(() => createMfaState(file, KEY), { code: 'AUTH_MFA_UNAVAILABLE' });
    fs.unlinkSync(file);
    const state = createMfaState(file, KEY);
    fs.writeFileSync(file + '.lock', '', { mode: 0o600 });
    assert.throws(() => state.consume(300), { code: 'AUTH_MFA_UNAVAILABLE' });
    assert.equal(fs.existsSync(file), false);
    fs.unlinkSync(file + '.lock');
    assert.equal(state.consume(300), true);
    fs.chmodSync(file, 0o644);
    assert.throws(() => createMfaState(file, KEY), { code: 'AUTH_MFA_UNAVAILABLE' });
    fs.unlinkSync(file); fs.symlinkSync(file + '.missing', file);
    assert.throws(() => createMfaState(file, KEY), { code: 'AUTH_MFA_UNAVAILABLE' });
}));
