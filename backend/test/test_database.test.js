const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

for (const exitCode of [0, 1]) {
    test(`temporary databases protect inherited paths and clean sidecars on exit ${exitCode}`, (t) => {
        const sentinelDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'database-sentinel-'));
        t.after(() => fs.rmSync(sentinelDirectory, { recursive: true, force: true }));
        const sentinel = path.join(sentinelDirectory, 'application.db');
        fs.writeFileSync(sentinel, 'untouched');
        const helperPath = require.resolve('../test-support/test_database');
        const source = `
            const fs = require('node:fs');
            const { createTestDatabase } = require(${JSON.stringify(helperPath)});
            const paths = [createTestDatabase(), createTestDatabase()];
            for (const database of paths) {
                for (const suffix of ['', '-journal', '-wal', '-shm', '.backup.test']) {
                    fs.writeFileSync(database + suffix, 'test-only');
                }
            }
            console.log(JSON.stringify({ paths, selected: process.env.DB_PATH_OVERRIDE }));
            process.exitCode = ${exitCode};
        `;
        const result = spawnSync(process.execPath, ['-e', source], {
            env: { ...process.env, DB_PATH_OVERRIDE: sentinel },
            encoding: 'utf8',
            timeout: 10000,
        });
        assert.ifError(result.error);
        assert.equal(result.status, exitCode, result.stderr);
        const { paths, selected } = JSON.parse(result.stdout);
        assert.notEqual(paths[0], paths[1]);
        assert.equal(selected, paths[1]);
        assert.equal(fs.readFileSync(sentinel, 'utf8'), 'untouched');
        for (const database of paths) {
            const expectedRoot = process.env.STOCK_DASHBOARD_TEST_TMPDIR || os.tmpdir();
            assert.equal(fs.realpathSync(path.dirname(path.dirname(database))), fs.realpathSync(expectedRoot));
            assert.equal(fs.existsSync(path.dirname(database)), false);
        }
    });
}
