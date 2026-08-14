const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createPythonCaller } = require('../services/pybridge');

function fakeChild() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
        write() {},
        end() {},
    };
    child.killedWith = null;
    child.kill = (signal) => {
        child.killedWith = signal;
        child.emit('close', null, signal);
    };
    return child;
}

test('python caller terminates and rejects a process that exceeds its deadline', async () => {
    const child = fakeChild();
    const callPython = createPythonCaller({
        spawnImpl: () => child,
        timeoutMs: 5,
        maxOutputBytes: 1024,
    });

    await assert.rejects(callPython({ action: 'indexes' }), /timed out/i);
    assert.equal(child.killedWith, 'SIGKILL');
});

test('python caller terminates and rejects excessive stdout', async () => {
    const child = fakeChild();
    const callPython = createPythonCaller({
        spawnImpl: () => child,
        timeoutMs: 1_000,
        maxOutputBytes: 8,
    });
    const result = callPython({ action: 'indexes' });
    child.stdout.emit('data', Buffer.from('123456789'));

    await assert.rejects(result, /output limit/i);
    assert.equal(child.killedWith, 'SIGKILL');
});

test('python caller settles only once when a spawn error is followed by close', async () => {
    const child = fakeChild();
    const callPython = createPythonCaller({
        spawnImpl: () => child,
        timeoutMs: 1_000,
        maxOutputBytes: 1024,
    });
    const result = callPython({ action: 'indexes' });
    child.emit('error', new Error('spawn failed'));
    child.emit('close', 1);

    await assert.rejects(result, /spawn failed/i);
});
