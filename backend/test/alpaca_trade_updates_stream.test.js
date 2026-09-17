const { test } = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');

const { createTradeUpdatesStream } = require('../services/alpaca_trade_updates_stream');

function startAuthServer({ authorized = true } = {}) {
    const wss = new WebSocket.Server({ port: 0 });
    const connections = [];
    wss.on('connection', (ws) => {
        connections.push(ws);
        ws.on('message', (raw) => {
            let msg;
            try { msg = JSON.parse(raw.toString()); } catch (_e) { return; }
            if (msg.action === 'auth') {
                ws.send(JSON.stringify({
                    stream: 'authorization',
                    data: { status: authorized ? 'authorized' : 'unauthorized', action: 'authenticate' },
                }));
            } else if (msg.action === 'listen') {
                ws.send(JSON.stringify({ stream: 'listening', data: { streams: ['trade_updates'] } }));
            }
        });
    });
    return new Promise((resolve) => wss.on('listening', () => resolve({ wss, connections, port: wss.address().port })));
}

function waitFor(predicate, { timeout = 3000, interval = 10 } = {}) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        (function check() {
            if (predicate()) return resolve();
            if (Date.now() - start > timeout) return reject(new Error(`timed out waiting: ${predicate}`));
            setTimeout(check, interval);
        }());
    });
}

function fillMessage(overrides = {}) {
    return {
        stream: 'trade_updates',
        data: {
            event: 'fill', execution_id: 'exec-1',
            order: { id: 'broker-order-1', symbol: 'NVDA', side: 'buy' },
            price: '100.50', qty: '10', position_qty: '10', timestamp: '2026-09-17T13:31:00Z',
            ...overrides,
        },
    };
}

async function closeAll(server, stream) {
    if (stream) stream.close();
    await new Promise((resolve) => server.wss.close(resolve));
}

test('authenticates and confirms listening on connect', async () => {
    const server = await startAuthServer();
    const stream = createTradeUpdatesStream({
        url: `ws://127.0.0.1:${server.port}`, apiKey: 'k', apiSecret: 's', WebSocketImpl: WebSocket,
    });
    try {
        await waitFor(() => stream.isAuthenticated() && stream.isListening());
    } finally {
        await closeAll(server, stream);
    }
});

test('delivers a fill event whether sent as a text frame or a binary frame', async () => {
    const server = await startAuthServer();
    const fills = [];
    const stream = createTradeUpdatesStream({
        url: `ws://127.0.0.1:${server.port}`, apiKey: 'k', apiSecret: 's', WebSocketImpl: WebSocket,
        onFill: (fill) => fills.push(fill),
    });
    try {
        await waitFor(() => stream.isListening());
        server.connections[0].send(JSON.stringify(fillMessage({ execution_id: 'exec-text' })));
        server.connections[0].send(Buffer.from(JSON.stringify(fillMessage({ execution_id: 'exec-binary' }))));
        await waitFor(() => fills.length === 2);

        assert.strictEqual(fills[0].activity_id, 'exec-text');
        assert.strictEqual(fills[1].activity_id, 'exec-binary');
        assert.strictEqual(fills[1].symbol, 'NVDA');
    } finally {
        await closeAll(server, stream);
    }
});

test('passes through a duplicate delivery of the same execution without crashing or deduping at this layer', async () => {
    // Correctness dedup lives one layer down, in alpaca_paper_fills' activity_id UNIQUE
    // constraint (Task 10) -- a second in-memory dedup here would be a competing source of
    // truth that can disagree with the database after a restart.
    const server = await startAuthServer();
    const fills = [];
    const stream = createTradeUpdatesStream({
        url: `ws://127.0.0.1:${server.port}`, apiKey: 'k', apiSecret: 's', WebSocketImpl: WebSocket,
        onFill: (fill) => fills.push(fill),
    });
    try {
        await waitFor(() => stream.isListening());
        const message = JSON.stringify(fillMessage({ execution_id: 'exec-dup' }));
        server.connections[0].send(message);
        server.connections[0].send(message);
        await waitFor(() => fills.length === 2);
        assert.deepStrictEqual(fills[0], fills[1]);
    } finally {
        await closeAll(server, stream);
    }
});

test('ignores a malformed frame without crashing, and keeps processing subsequent valid ones', async () => {
    const server = await startAuthServer();
    const fills = [];
    const states = [];
    const stream = createTradeUpdatesStream({
        url: `ws://127.0.0.1:${server.port}`, apiKey: 'k', apiSecret: 's', WebSocketImpl: WebSocket,
        onFill: (fill) => fills.push(fill),
        onStateChange: (s) => states.push(s),
    });
    try {
        await waitFor(() => stream.isListening());
        server.connections[0].send('{not valid json');
        await waitFor(() => states.includes('malformed_message'));

        server.connections[0].send(JSON.stringify(fillMessage({ execution_id: 'exec-after-malformed' })));
        await waitFor(() => fills.length === 1);
        assert.strictEqual(fills[0].activity_id, 'exec-after-malformed');
    } finally {
        await closeAll(server, stream);
    }
});

test('reconnects with backoff after the connection drops, and re-authenticates', async () => {
    const server = await startAuthServer();
    const stream = createTradeUpdatesStream({
        url: `ws://127.0.0.1:${server.port}`, apiKey: 'k', apiSecret: 's', WebSocketImpl: WebSocket,
        reconnectBaseMs: 10, reconnectMaxMs: 50,
    });
    try {
        await waitFor(() => stream.isListening());
        server.connections[0].close();
        await waitFor(() => server.connections.length === 2, { timeout: 3000 });
        await waitFor(() => stream.isListening());
    } finally {
        await closeAll(server, stream);
    }
});

test('triggers REST reconciliation after a reconnect completes, but not after the initial connection', async () => {
    const server = await startAuthServer();
    let reconnectCalls = 0;
    const stream = createTradeUpdatesStream({
        url: `ws://127.0.0.1:${server.port}`, apiKey: 'k', apiSecret: 's', WebSocketImpl: WebSocket,
        reconnectBaseMs: 10, reconnectMaxMs: 50,
        onReconnect: () => { reconnectCalls += 1; },
    });
    try {
        await waitFor(() => stream.isListening());
        assert.strictEqual(reconnectCalls, 0, 'the initial connection must not itself count as a reconnect');

        server.connections[0].close();
        await waitFor(() => server.connections.length === 2, { timeout: 3000 });
        await waitFor(() => reconnectCalls === 1);
    } finally {
        await closeAll(server, stream);
    }
});

test('backoff does not stay maxed forever: it resets after a successful reconnect', async () => {
    const server = await startAuthServer();
    const stream = createTradeUpdatesStream({
        url: `ws://127.0.0.1:${server.port}`, apiKey: 'k', apiSecret: 's', WebSocketImpl: WebSocket,
        reconnectBaseMs: 10, reconnectMaxMs: 5000,
    });
    try {
        await waitFor(() => stream.isListening());
        server.connections[0].close();
        await waitFor(() => server.connections.length === 2, { timeout: 3000 });
        await waitFor(() => stream.isListening());

        const before = Date.now();
        server.connections[1].close();
        await waitFor(() => server.connections.length === 3, { timeout: 3000 });
        const elapsed = Date.now() - before;
        assert.ok(elapsed < 500, `second reconnect should use the low base delay again, not an escalated one (took ${elapsed}ms)`);
    } finally {
        await closeAll(server, stream);
    }
});

test('a failed authentication is terminal and is never retried', async () => {
    const server = await startAuthServer({ authorized: false });
    const states = [];
    const stream = createTradeUpdatesStream({
        url: `ws://127.0.0.1:${server.port}`, apiKey: 'bad-key', apiSecret: 'bad-secret', WebSocketImpl: WebSocket,
        reconnectBaseMs: 10, reconnectMaxMs: 50,
        onStateChange: (s) => states.push(s),
    });
    try {
        await waitFor(() => states.includes('auth_failed'));
        await new Promise((resolve) => { setTimeout(resolve, 300); });
        assert.strictEqual(server.connections.length, 1, 'a terminal auth failure must not be retried with the same bad credentials');
    } finally {
        await closeAll(server, stream);
    }
});

test('close() stops the stream cleanly with no further reconnect attempts', async () => {
    const server = await startAuthServer();
    const stream = createTradeUpdatesStream({
        url: `ws://127.0.0.1:${server.port}`, apiKey: 'k', apiSecret: 's', WebSocketImpl: WebSocket,
        reconnectBaseMs: 10, reconnectMaxMs: 50,
    });
    await waitFor(() => stream.isListening());
    stream.close();
    await new Promise((resolve) => { setTimeout(resolve, 300); });
    assert.strictEqual(server.connections.length, 1, 'no reconnect attempt may follow a caller-initiated close');
    await new Promise((resolve) => server.wss.close(resolve));
});
