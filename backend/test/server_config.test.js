const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

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

for (const sample of [false, true]) {
    test(`server startup ${sample ? 'skips background jobs and warm-up in sample mode' : 'keeps all background jobs in normal mode'}`, () => {
        // Exercise start(), replacing only external effects. No database is opened,
        // no real scheduler is registered, and no market-data request can run.
        const source = `
            const assert = require('node:assert/strict');
            const calls = [];
            const sampleMode = require('./services/sample_mode');
            sampleMode.validateSampleEnvironment = () => ${sample};
            sampleMode.verifySampleDatabase = async () => {};
            sampleMode.acquireSampleLock = () => () => {};
            require('./database/db').initDb = async () => {};
            require('./services/universeCache').initUniverseScheduler = () => calls.push('universe');
            require('./services/snapshotScheduler').initSnapshotScheduler = () => calls.push('snapshots');
            require('./services/simulator_performance').initSimulatorPerformanceScheduler = () => calls.push('performance');
            require('./services/auth').createAuthFromEnv = () => require('./services/auth').createAuth({
                username: 'test-user', passwordHash: 'unused-by-this-test',
                sessionSecret: 'scheduler-test-secret-at-least-32-characters', allowLoopback: false,
            });
            (async () => {
                const server = await require('./server').start();
                await new Promise(resolve => server.once('listening', resolve));
                await new Promise(resolve => server.close(resolve));
                assert.deepEqual(calls, ${JSON.stringify(sample ? [] : ['universe', 'snapshots', 'performance'])});
            })().catch(error => { console.error(error); process.exitCode = 1; });
        `;
        const result = spawnSync(process.execPath, ['-e', source], {
            cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 30000,
            env: { ...process.env, SAMPLE_DATA: sample ? '1' : '0', PORT: '0',
                STOCK_DASHBOARD_HOST: '127.0.0.1' },
        });
        assert.equal(result.status, 0, result.stderr || result.error?.message);
        if (sample) assert.match(result.stdout, /background refresh jobs and universe warm-up are disabled/);
    });
}
