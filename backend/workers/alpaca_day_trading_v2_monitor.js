'use strict';

// The single v2 monitor process: owns reconciliation and time exits. One instance (PID lock,
// behind systemd's own single-unit guarantee), serial ticks, REST every 60s with exposure and
// every 300s while flat. The WebSocket only speeds up fill ingestion; a disconnect never
// triggers an order -- REST keeps reconciling on its normal cadence.
const fs = require('fs');
const path = require('path');

const store = require('../services/alpaca_day_trade_v2_store');
const { createV2Monitor } = require('../services/alpaca_day_trade_v2_monitor');
const { ingestFill, normalizeV2WebSocketFill } = require('../services/alpaca_day_trade_v2_reconciliation');
const { createTradeUpdatesStream } = require('../services/alpaca_trade_updates_stream');
const { TRADE_UPDATES_URL } = require('../services/alpaca_paper_service');

const DEFAULT_LOCK_PATH = path.join(__dirname, '..', '..', 'run', 'alpaca-day-trading-v2-monitor.lock');
const EXPOSURE_INTERVAL_MS = 60_000;
const FLAT_INTERVAL_MS = 300_000;

function nextDelayMs({ exposure }) {
    return exposure ? EXPOSURE_INTERVAL_MS : FLAT_INTERVAL_MS;
}

function isPidAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (_error) { return false; }
}

function acquireSingletonLock(lockPath) {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    try {
        const fd = fs.openSync(lockPath, 'wx');
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        return { acquired: true, release: () => { try { fs.unlinkSync(lockPath); } catch (_e) { /* already gone */ } } };
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let pid = null;
        try { pid = Number(fs.readFileSync(lockPath, 'utf8').trim()); } catch (_e) { /* unreadable: stale */ }
        if (pid && isPidAlive(pid)) return { acquired: false, release: () => {} };
        fs.unlinkSync(lockPath);
        return acquireSingletonLock(lockPath);
    }
}

function createV2MonitorWorker({
    store: injectedStore = store, client: providedClient, createClient, lockPath = DEFAULT_LOCK_PATH,
    now = () => new Date(), sleep, log = () => {}, delayFor = nextDelayMs,
    wsUrl = TRADE_UPDATES_URL, wsApiKey, wsApiSecret, streamFactory = createTradeUpdatesStream,
} = {}) {
    let lock = null;
    let client = providedClient || null;
    let monitor = null;
    let stream = null;
    let timer = null;
    let stopped = false;
    let running = 0;
    let maxRunning = 0;
    let current = Promise.resolve();

    async function runTick(fn) {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        try {
            return await fn();
        } catch (error) {
            log({ v2MonitorTickError: error.code || 'error' });
            return { exposure: true };
        } finally {
            running -= 1;
        }
    }

    function schedule(result) {
        if (stopped) return;
        timer = setTimeout(() => {
            current = runTick(() => monitor.tick()).then(schedule);
        }, delayFor(result || { exposure: true }));
    }

    async function handleFill(fill) {
        try {
            await ingestFill({ store: injectedStore, fill, now });
            await injectedStore.updateMonitorState({ last_websocket_at: now().toISOString() });
        } catch (error) {
            log({ v2WebSocketFillError: error.code || 'error' });
        }
    }

    async function start() {
        lock = acquireSingletonLock(lockPath);
        if (!lock.acquired) throw Object.assign(new Error('another v2 monitor instance holds the lock'), { code: 'ALPACA_V2_MONITOR_ALREADY_RUNNING' });
        try {
            if (!client) client = createClient();
            monitor = createV2Monitor({ store: injectedStore, client, now, ...(sleep ? { sleep } : {}), notify: (alert) => log({ v2Attention: alert }) });
            if (wsApiKey && wsApiSecret) {
                stream = streamFactory({
                    url: wsUrl, apiKey: wsApiKey, apiSecret: wsApiSecret, normalize: normalizeV2WebSocketFill,
                    onFill: (fill) => { handleFill(fill); },
                    onStateChange: (state) => log({ v2WebSocketState: state }),
                });
            }
        } catch (error) {
            lock.release();
            throw error;
        }
        current = runTick(() => monitor.startup()).then(schedule);
    }

    async function stop() {
        stopped = true;
        if (timer) clearTimeout(timer);
        await current;
        if (stream) stream.close();
        // Graceful shutdown never cancels or flattens anything; native bracket legs stay live.
        if (lock) lock.release();
    }

    return { start, stop, maxConcurrentTicks: () => maxRunning };
}

module.exports = { createV2MonitorWorker, acquireSingletonLock, nextDelayMs, DEFAULT_LOCK_PATH };

if (require.main === module) {
    const { createPaperClient, getPaperCredentials } = require('../services/alpaca_paper_service');
    const credentials = getPaperCredentials();
    const worker = createV2MonitorWorker({
        createClient: createPaperClient, wsApiKey: credentials.key, wsApiSecret: credentials.secret,
        // eslint-disable-next-line no-console
        log: (entry) => console.log(JSON.stringify({ at: new Date().toISOString(), ...entry })),
    });
    require('../database/db').initDb().then(() => worker.start()).catch((error) => {
        // eslint-disable-next-line no-console
        console.error('Alpaca Day Trading v2 monitor failed to start:', error.code || 'error');
        process.exit(1);
    });
    const shutdown = () => { worker.stop().then(() => process.exit(0)); };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}
