'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const path = require('node:path');

const dependencyPaths = new Map([
    [null, 'application HTTP helper'],
    [require.resolve('undici'), 'application fetch'],
    [createRequire(require.resolve('@ai-sdk/provider-utils')).resolve('undici'), 'AI SDK downloads'],
    [createRequire(createRequire(require.resolve('@ai-sdk/anthropic')).resolve('@ai-sdk/provider-utils')).resolve('undici'), 'Anthropic SDK downloads'],
    [createRequire(require.resolve('node-gyp')).resolve('undici'), 'native dependency downloads'],
]);

for (const [modulePath, consumer] of dependencyPaths) {
test(`${consumer}: excessive encodings and early close reject fetch without a process crash`, () => {
    // GHSA-xjj6-f33q-929c: the vulnerable dependency emits an unhandled stream
    // error after fetch rejects. A child process observes that crash safely.
    const source = `
        const assert = require('node:assert/strict');
        const net = require('node:net');
        ${modulePath ? `const { fetch, Agent } = require(${JSON.stringify(modulePath)});`
            : "const { fetch } = require('./services/http_runtime'); const { Agent } = require('undici');"}
        const dispatcher = new Agent();
        const server = net.createServer(socket => {
            socket.once('data', () => socket.end([
                'HTTP/1.1 200 OK',
                'Content-Encoding: gzip, gzip, gzip, gzip, gzip, gzip',
                'Content-Length: 100',
                'Connection: close', '', '',
            ].join('\\r\\n')));
        });
        (async () => {
            server.listen(0, '127.0.0.1');
            await new Promise((resolve, reject) => {
                server.once('listening', resolve);
                server.once('error', reject);
            });
            try {
                await assert.rejects(fetch('http://127.0.0.1:' + server.address().port, {
                    dispatcher,
                    signal: AbortSignal.timeout(1000),
                }), error => error instanceof TypeError && /fetch failed/.test(error.message));
                // Give the premature-close stream error time to surface.
                await new Promise(resolve => setTimeout(resolve, 100));
            } finally {
                await dispatcher.close();
                await new Promise(resolve => server.close(resolve));
            }
            process.stdout.write('rejection handled; process survived');
        })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    const result = spawnSync(process.execPath, ['-e', source], {
        cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.equal(result.stdout, 'rejection handled; process survived');
});
}
