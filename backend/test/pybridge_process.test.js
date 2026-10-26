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

test('python caller preserves database and sample configuration without forwarding credentials', async t => {
    const settings = { DB_PATH_OVERRIDE: '/isolated/state/stocks.db', SAMPLE_DATA: '1',
        ALPACA_LIVE_API_KEY: 'synthetic-not-a-key', STOCK_DASHBOARD_SESSION_SECRET: 'synthetic-not-a-secret' };
    for (const [key, value] of Object.entries(settings)) {
        const previous = process.env[key];
        process.env[key] = value;
        t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    }
    const child = fakeChild();
    let received;
    const callPython = createPythonCaller({ spawnImpl: (_binary, _args, options) => { received = options.env; return child; } });
    const result = callPython({ action: 'info', symbol: 'SPY' });
    child.stdout.emit('data', Buffer.from('{"status":"success"}'));
    child.emit('close', 0);
    await result;
    assert.equal(received.DB_PATH_OVERRIDE, settings.DB_PATH_OVERRIDE);
    assert.equal(received.SAMPLE_DATA, '1');
    assert.equal(received.ALPACA_LIVE_API_KEY, undefined);
    assert.equal(received.STOCK_DASHBOARD_SESSION_SECRET, undefined);
});

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

test('python research concurrency is bounded and queued work starts only after a process exits',async()=>{
    const children=[];
    const call=createPythonCaller({maxConcurrent:1,maxQueue:2,spawnImpl:()=>{const c=fakeChild();children.push(c);return c;}});
    const first=call({action:'info'}),second=call({action:'news'});
    assert.equal(children.length,1);
    children[0].stdout.emit('data',Buffer.from('{"status":"success"}'));children[0].emit('close',0);
    await first;await new Promise(r=>setImmediate(r));assert.equal(children.length,2);
    children[1].stdout.emit('data',Buffer.from('{"status":"success"}'));children[1].emit('close',0);
    assert.equal((await second).status,'success');
});
test('queued research times out without spawning or killing an unrelated process',async()=>{
    const child=fakeChild();let spawned=0;
    const call=createPythonCaller({maxConcurrent:1,queueTimeoutMs:5,spawnImpl:()=>{spawned++;return child;}});
    const first=call({action:'info'});const second=call({action:'news'});
    await assert.rejects(second,/queue timed out/);assert.equal(spawned,1);assert.equal(child.killedWith,null);
    child.stdout.emit('data',Buffer.from('{"status":"success"}'));child.emit('close',0);await first;
});
