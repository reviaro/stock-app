const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createProcessIdentity, beginEntryAttempt, endEntryAttempt, isEntrySenderActive } = require('../services/alpaca_day_trade_v2_process_owner');

const stat = (start) => `123 (a process (with spaces)) ${['S', ...Array(18).fill('0'), start].join(' ')}`;

test('sender identity distinguishes a running process from a reused Linux PID', () => {
    let start = '100';
    const identity = createProcessIdentity({ pid: 123, platform: 'linux', kill: () => {}, readFile: () => stat(start) });
    assert.deepEqual(identity.owner, { pid: 123, start: '100' });
    assert.equal(identity.isAlive(identity.owner), true);
    start = '200';
    assert.equal(identity.isAlive(identity.owner), false);
});

test('only a confirmed missing process releases its sender identity', () => {
    const identity = createProcessIdentity({ pid: 123, platform: 'linux', readFile: () => stat('100'),
        kill: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); } });
    assert.equal(identity.isAlive(identity.owner), false);
});

for (const code of ['EPERM', 'EACCES', 'ENOSYS']) {
    test(`an unavailable process probe (${code}) preserves the admission`, () => {
        const identity = createProcessIdentity({ pid: 123, platform: 'linux', readFile: () => stat('100'),
            kill: () => { throw Object.assign(new Error('unavailable'), { code }); } });
        assert.equal(identity.isAlive(identity.owner), true);
    });
}

test('missing or unreadable proc metadata is not proof that a sender exited', () => {
    const identity = createProcessIdentity({ pid: 123, platform: 'linux', kill: () => {},
        readFile: () => { throw Object.assign(new Error('unavailable'), { code: 'ENOENT' }); } });
    assert.equal(identity.isAlive({ pid: 123, start: '100' }), true);
    assert.equal(identity.isAlive(null), true);
    assert.equal(identity.isAlive({ pid: -1 }), true);
});

test('hosts without proc use the process probe and never expire a live admission', () => {
    const identity = createProcessIdentity({ pid: 123, platform: 'darwin', kill: () => {},
        readFile: () => { throw new Error('must not read proc'); } });
    assert.deepEqual(identity.owner, { pid: 123, start: null });
    assert.equal(identity.isAlive(identity.owner), true);
});

test('only the owning process can prove that its registered attempt has finished', () => {
    const first = beginEntryAttempt();
    const second = beginEntryAttempt();
    try {
        assert.equal(isEntrySenderActive(first), true);
        assert.equal(isEntrySenderActive(second), true);
        endEntryAttempt(first);
        assert.equal(isEntrySenderActive(first), false);
        assert.equal(isEntrySenderActive(second), true);
    } finally {
        endEntryAttempt(first);
        endEntryAttempt(second);
    }
});
