const WebSocketLib = require('ws');
const { normalizeWebSocketFillEvent } = require('./alpaca_fill_reconciliation');

const DEFAULT_RECONNECT_BASE_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;

// Verified against Alpaca's documented trade_updates protocol: client sends
// {action:'auth', key, secret} then {action:'listen', data:{streams:['trade_updates']}};
// server replies {stream:'authorization', data:{status}} then {stream:'listening', data}.
// This module owns only the transport (connect, authenticate, listen, reconnect) and routing
// a trade_updates message through Task 10's existing normalizeWebSocketFillEvent -- it never
// imports, dedupes, or persists a fill itself. Deduplication is deliberately one layer down,
// in alpaca_paper_fills' activity_id UNIQUE constraint: a second in-memory dedup here would be
// a competing source of truth that can disagree with the database after a restart.
function createTradeUpdatesStream({
    url, apiKey, apiSecret,
    WebSocketImpl = WebSocketLib,
    // v2 boundary: the v2 monitor injects its own fill normalizer; v1 keeps its default.
    normalize = normalizeWebSocketFillEvent,
    onFill = () => {},
    onReconnect = () => {},
    onStateChange = () => {},
    reconnectBaseMs = DEFAULT_RECONNECT_BASE_MS,
    reconnectMaxMs = DEFAULT_RECONNECT_MAX_MS,
} = {}) {
    let socket = null;
    let stopped = false;
    let terminal = false; // a failed auth is never retried -- a bad credential is an operator problem, not a transient one
    let reconnectAttempts = 0;
    let reconnectTimer = null;
    let hasConnectedBefore = false;
    let authenticated = false;
    let listening = false;

    function handleMessage(raw) {
        const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
        let message;
        try {
            message = JSON.parse(text);
        } catch (_error) {
            onStateChange('malformed_message');
            return;
        }
        if (!message || typeof message !== 'object') {
            onStateChange('malformed_message');
            return;
        }

        if (message.stream === 'authorization') {
            authenticated = message.data?.status === 'authorized';
            if (authenticated) {
                socket.send(JSON.stringify({ action: 'listen', data: { streams: ['trade_updates'] } }));
            } else {
                terminal = true;
                onStateChange('auth_failed');
            }
            return;
        }
        if (message.stream === 'listening') {
            listening = true;
            // REST reconciliation runs after a reconnect is confirmed listening again, never on
            // disconnect and never on the first connection -- Section 8 needs to close the gap
            // of events missed *while* down, which is only enumerable once back up. The
            // backoff counter resets here too: without this, one flaky period would leave
            // every future reconnect waiting at the maximum backoff forever.
            const isReconnect = hasConnectedBefore;
            hasConnectedBefore = true;
            reconnectAttempts = 0;
            onStateChange('listening');
            if (isReconnect) Promise.resolve(onReconnect()).catch(() => {});
            return;
        }
        if (message.stream === 'trade_updates') {
            let normalized = null;
            try { normalized = normalize(message.data); } catch (_error) { onStateChange('malformed_message'); return; }
            if (normalized) onFill(normalized);
        }
    }

    function scheduleReconnect() {
        if (stopped || terminal) return;
        const delay = Math.min(reconnectBaseMs * (2 ** reconnectAttempts), reconnectMaxMs);
        reconnectAttempts += 1;
        reconnectTimer = setTimeout(connect, delay);
    }

    function connect() {
        authenticated = false;
        listening = false;
        onStateChange('connecting');
        socket = new WebSocketImpl(url);
        socket.on('open', () => {
            socket.send(JSON.stringify({ action: 'auth', key: apiKey, secret: apiSecret }));
        });
        socket.on('message', handleMessage);
        socket.on('close', () => {
            authenticated = false;
            listening = false;
            onStateChange('disconnected');
            scheduleReconnect();
        });
        socket.on('error', () => {}); // 'close' also fires; nothing extra needed beyond not crashing the process
    }

    function close() {
        stopped = true;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        if (socket) socket.close();
    }

    connect();

    return {
        close,
        isAuthenticated: () => authenticated,
        isListening: () => listening,
    };
}

module.exports = { createTradeUpdatesStream };
