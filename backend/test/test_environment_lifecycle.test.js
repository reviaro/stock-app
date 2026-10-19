const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

test('interrupting the launcher stops a stubborn fixture descendant and removes its databases', {
    skip: process.platform === 'win32' ? 'POSIX process-group lifecycle check' : false,
    timeout: 20000,
}, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'test-lifecycle-check-'));
    const readyFile = path.join(directory, 'ready.json');
    const heartbeatFile = path.join(directory, 'heartbeat');
    const fixture = path.join(directory, 'fixture.test.cjs');
    const descendantSource = `
        const fs = require('node:fs');
        process.on('SIGINT', () => {});
        process.on('SIGTERM', () => {});
        fs.writeFileSync(${JSON.stringify(readyFile)}, JSON.stringify({
            pid: process.pid, database: process.env.DB_PATH_OVERRIDE,
        }));
        let heartbeat = 0;
        setInterval(() => fs.writeFileSync(${JSON.stringify(heartbeatFile)}, String(++heartbeat)), 20);
    `;
    fs.writeFileSync(fixture, `
        const { test } = require('node:test');
        const { spawn } = require('node:child_process');
        test('fixture with a live descendant', async () => {
            spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], { stdio: 'ignore' });
            await new Promise(() => {});
        });
    `);
    const runner = spawn(process.execPath, [path.resolve(__dirname, '../scripts/run-tests.js'), fixture], {
        env: { ...process.env, TMPDIR: directory },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let descendant;
    let closed = false;
    runner.stdout.on('data', chunk => { output = (output + chunk).slice(-8000); });
    runner.stderr.on('data', chunk => { output = (output + chunk).slice(-8000); });
    const completion = new Promise((resolve, reject) => {
        runner.once('error', reject);
        runner.once('close', (code, signal) => { closed = true; resolve({ code, signal }); });
    });
    // Attach a rejection observer while waiting for the fixture readiness signal.
    completion.catch(() => {});
    t.after(async () => {
        if (!closed) {
            runner.kill('SIGTERM');
            await Promise.race([completion.catch(() => {}), delay(6000)]);
            if (!closed) runner.kill('SIGKILL');
        }
        if (descendant?.pid) {
            try { process.kill(descendant.pid, 'SIGKILL'); } catch (error) {
                if (error.code !== 'ESRCH') throw error;
            }
        }
        fs.rmSync(directory, { recursive: true, force: true });
    });
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(readyFile) || !fs.existsSync(heartbeatFile)) {
        assert.equal(closed, false, output);
        assert.ok(Date.now() < deadline, `fixture did not become ready: ${output}`);
        await delay(25);
    }
    descendant = JSON.parse(fs.readFileSync(readyFile, 'utf8'));
    runner.kill('SIGTERM');
    assert.deepEqual(await completion, { code: 143, signal: null }, output);
    assert.equal(fs.existsSync(path.dirname(descendant.database)), false);
    const lastHeartbeat = fs.readFileSync(heartbeatFile, 'utf8');
    await delay(150);
    assert.equal(fs.readFileSync(heartbeatFile, 'utf8'), lastHeartbeat, 'descendant kept running after launcher exit');
});
