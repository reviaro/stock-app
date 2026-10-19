const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('test launcher isolates credentials, dotenv files, and databases in fixture children', (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'test-environment-check-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sentinel = path.join(directory, 'application.db');
    const dotenvFile = path.join(directory, '.env');
    const resultFile = path.join(directory, 'result.json');
    fs.writeFileSync(sentinel, 'untouched');
    fs.writeFileSync(dotenvFile, 'OPENAI_API_KEY=must-not-load\n');
    const dotenvModule = require.resolve('dotenv');
    const probe = `
        const assert = require('node:assert/strict');
        const fs = require('node:fs');
        for (const key of ['OPENAI_API_KEY', 'ALPACA_API_SECRET', 'STOCK_DASHBOARD_API_TOKEN']) {
            assert.equal(process.env[key], undefined);
        }
        assert.deepEqual(require(${JSON.stringify(dotenvModule)}).config({ path: ${JSON.stringify(dotenvFile)} }), { parsed: {} });
        assert.equal(process.env.OPENAI_API_KEY, undefined);
        assert.notEqual(process.env.DB_PATH_OVERRIDE, ${JSON.stringify(sentinel)});
    `;
    const childSource = `${probe}\nfs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ database: process.env.DB_PATH_OVERRIDE }));`;
    const fixture = path.join(directory, 'fixture.test.cjs');
    fs.writeFileSync(fixture, `
        const { test } = require('node:test');
        test('isolated fixture', () => {
            ${probe}
            const { spawnSync } = require('node:child_process');
            const child = spawnSync(process.execPath, ['-e', ${JSON.stringify(childSource)}], { env: process.env, encoding: 'utf8', timeout: 10000 });
            assert.ifError(child.error);
            assert.equal(child.status, 0, child.stderr);
            assert.notEqual(JSON.parse(fs.readFileSync(${JSON.stringify(resultFile)}, 'utf8')).database, process.env.DB_PATH_OVERRIDE);
        });
    `);
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/run-tests.js'), fixture], {
        env: {
            ...process.env,
            TMPDIR: directory,
            DB_PATH_OVERRIDE: sentinel,
            OPENAI_API_KEY: 'inherited-test-placeholder',
            ALPACA_API_SECRET: 'inherited-test-placeholder',
            STOCK_DASHBOARD_API_TOKEN: 'inherited-test-placeholder',
        },
        encoding: 'utf8',
        timeout: 30000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'untouched');
    const { database } = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    assert.equal(fs.existsSync(path.dirname(database)), false);
});
