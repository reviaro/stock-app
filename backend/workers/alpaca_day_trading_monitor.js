const fs = require('fs');
const path = require('path');

const store = require('../services/alpaca_day_trade_store');
const { reconcileFills, buildObservation, recordWebSocketFill } = require('../services/alpaca_fill_reconciliation');
const { decidePlanAction, DEFAULT_MONITOR_POLICY } = require('../services/alpaca_day_trade_monitor');
const { executeManagementAction } = require('../services/alpaca_day_trade_repair_execution');
const { createSessionDateResolver } = require('../services/alpaca_trading_calendar');
const { createTradeUpdatesStream } = require('../services/alpaca_trade_updates_stream');
const { TRADE_UPDATES_URL } = require('../services/alpaca_paper_service');

const DEFAULT_LOCK_PATH = path.join(__dirname, '..', '..', 'run', 'alpaca-day-trading-monitor.lock');
const DEFAULT_POLL_INTERVAL_MS = 60_000; // Section 8: every 60s while any plan/order/position is open
const DEFAULT_IDLE_POLL_INTERVAL_MS = 300_000; // Section 8: a slower cadence while flat/closed -- tunable, Stage 4 material
const TERMINAL_PLAN_STATES = ['closed', 'cancelled', 'error'];

function workerError(code, message) {
    return Object.assign(new Error(message), { code });
}

function isPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (_error) {
        return false;
    }
}

// A PID file with exclusive creation, not a distributed lock: this is defense in depth behind
// systemd itself being the primary single-instance guard (a unit with no concurrent instances
// configured). process.kill(pid, 0) succeeds for a PID owned by another user, and a recycled
// PID after a reboot can be alive but be an unrelated process -- acceptable for this purpose,
// not something to rely on outside a systemd-managed deployment.
function acquireInstanceLock(lockPath) {
    try {
        const fd = fs.openSync(lockPath, 'wx');
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        return { acquired: true, release: () => { try { fs.unlinkSync(lockPath); } catch (_e) { /* already gone */ } } };
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let existingPid = null;
        try { existingPid = Number(fs.readFileSync(lockPath, 'utf8').trim()); } catch (_e) { /* unreadable: treat as stale below */ }
        if (existingPid && isPidAlive(existingPid)) {
            return { acquired: false, release: () => {} };
        }
        fs.unlinkSync(lockPath); // stale: reclaim
        return acquireInstanceLock(lockPath);
    }
}

function createWorker({
    client: providedClient,
    createClient,
    lockPath = DEFAULT_LOCK_PATH,
    holderId = `monitor-${process.pid}`,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    idlePollIntervalMs = DEFAULT_IDLE_POLL_INTERVAL_MS,
    policy = DEFAULT_MONITOR_POLICY,
    now = () => new Date(),
    log = () => {},
    wsUrl = TRADE_UPDATES_URL,
    wsApiKey,
    wsApiSecret,
    streamFactory = createTradeUpdatesStream,
} = {}) {
    let ready = false;
    let stopped = false;
    let timer = null;
    let lock = null;
    let client = providedClient || null;
    // Created once client is resolved (see start()) so its calendar cache persists across every
    // tick for this process's lifetime, rather than refetching on each 60s poll.
    let resolveSessionDate = null;
    // REST (reconcileFills, every poll) is the plan's own designated completeness channel and
    // is fully sufficient on its own -- the WebSocket exists purely to react faster. Without
    // credentials configured, this simply never connects; nothing else changes.
    let stream = null;
    // Tracks whatever tick is currently executing (or the last one that ran) so stop() can wait
    // for it -- a SIGTERM arriving mid-tick (the realistic systemd shutdown, Task 16) must not
    // release the instance lock while broker calls/decisions from this process are still in
    // flight, or a systemd-restarted second instance could start deciding/executing concurrently.
    let currentTick = Promise.resolve();

    async function runTick() {
        const monitorState = await store.getMonitorState();
        if (monitorState?.mode === 'disabled') return;

        // Evidence recording (importing fills, closing plans with complete broker evidence) is
        // safe even with the kill switch tripped -- it never creates new exposure -- so it
        // keeps running. The decide/execute loop below does not.
        await reconcileFills({ client, store });

        // Read-only reporting, same safety class as reconcileFills above -- refreshed every
        // tick regardless of kill_switch so the dashboard's daily P&L stays accurate even while
        // tripped. The resolver's own cache keeps this cheap (no broker call most ticks).
        //
        // Caught deliberately broad, same shape as buildObservation's own catch (Task 11): this
        // sits ahead of the decide/execute loop, so an uncaught throw here would propagate out
        // of runTick and be swallowed by scheduleNext's top-level catch, silently skipping plan
        // management for the whole tick on a transient calendar-fetch failure. Reporting is not
        // worth a management outage -- leave session_date at its previous value and continue.
        try {
            const sessionDate = await resolveSessionDate(now());
            if (sessionDate) await store.updateMonitorState({ session_date: sessionDate });
            else log({ sessionDateUnavailable: 'no calendar entry covers the current time' });
        } catch (error) {
            log({ sessionDateError: error.message });
        }

        if (monitorState.kill_switch) {
            log({ skipped: 'kill_switch_active' });
            return; // an operator must clear the switch before the monitor resumes managing plans
        }

        const plans = (await store.listPlans(null)).filter((plan) => !TERMINAL_PLAN_STATES.includes(plan.state));
        let lastHealthCode = null;
        let lastHealthReason = null;
        // Unlike kill_switch, this is not a one-way trip -- rewritten unconditionally below,
        // true or false, every tick that reaches this point, so it self-heals the moment no
        // plan's decision requires it anymore rather than needing an operator to clear it.
        let anyBlockEntries = false;

        for (const plan of plans) {
            const observation = await buildObservation(plan, {
                client, policy, now, log,
            });
            const decision = decidePlanAction(observation);
            log({ planId: plan.id, symbol: plan.symbol, decision });

            if (decision.blockEntries) anyBlockEntries = true;
            if (decision.healthCode) { lastHealthCode = decision.healthCode; lastHealthReason = decision.reason; }

            if (monitorState.mode === 'paper_execute' && decision.action !== 'none') {
                try {
                    await executeManagementAction(decision, plan, { client, holderId, now: now() });
                } catch (error) {
                    log({ planId: plan.id, symbol: plan.symbol, executionError: error.message });
                }
            }
            // mode 'shadow': decided and logged, never executed -- Section 10 Stage 2 requires
            // zero submit/cancel/replace/flatten writes.

            if (decision.activateKillSwitch) {
                await store.updateMonitorState({ kill_switch: true });
                log({ planId: plan.id, killSwitchActivated: true });
                // Stop processing further plans in *this* tick immediately: the switch exists
                // to stop subsequent writes, not to be recorded after the fact while the rest
                // of the batch still executes against a system already known to be unsafe.
                break;
            }
        }

        await store.updateMonitorState({
            block_entries: anyBlockEntries,
            ...(lastHealthCode ? { health_code: lastHealthCode, health_error: lastHealthReason } : {}),
        });
    }

    function scheduleNext() {
        if (stopped) return;
        timer = setTimeout(() => {
            currentTick = runTick()
                .catch((error) => { log({ tickError: error.message }); })
                .then(() => { scheduleNext(); });
        }, pollIntervalMs);
    }

    // Called bare by the stream module (never awaited, never .catch()'d at that call site) --
    // an escaping rejection here would surface as an unhandled promise rejection, which
    // terminates the process by default on modern Node. The detached-IIFE-with-internal-catch
    // shape makes this impossible structurally: handleFill itself returns synchronously.
    function handleFill(normalized) {
        (async () => {
            try {
                await recordWebSocketFill(normalized, { store });
                await store.updateMonitorState({ last_websocket_event_at: now().toISOString() });
                // REST remains the authoritative completeness pass -- this recorded the live
                // event for low latency, but protective-leg discovery and close-from-fills only
                // happen here, against complete broker evidence, same as every poll tick.
                await reconcileFills({ client, store });
            } catch (error) {
                log({ webSocketFillError: error.message });
            }
        })();
    }

    async function handleReconnect() {
        try {
            await reconcileFills({ client, store });
            await store.updateMonitorState({ last_websocket_reconnect_at: now().toISOString() });
        } catch (error) {
            log({ webSocketReconnectError: error.message });
        }
    }

    async function start() {
        lock = acquireInstanceLock(lockPath);
        if (!lock.acquired) {
            throw workerError('ALPACA_MONITOR_ALREADY_RUNNING', `another Day Trading monitor instance already holds ${lockPath}`);
        }
        try {
            if (!client) client = createClient();
            resolveSessionDate = createSessionDateResolver({ client });
            if (wsApiKey && wsApiSecret) {
                stream = streamFactory({
                    url: wsUrl, apiKey: wsApiKey, apiSecret: wsApiSecret,
                    onFill: handleFill, onReconnect: handleReconnect,
                    onStateChange: (state) => log({ webSocketState: state }),
                });
            }
        } catch (error) {
            lock.release();
            throw error; // fatal configuration: reject and let systemd's Restart=always retry at the process level
        }

        try {
            const monitorState = await store.getMonitorState();
            if (monitorState?.mode !== 'disabled') {
                // Startup reconciliation before reporting ready (Section 8 Startup step 4),
                // regardless of shadow vs. paper_execute -- read-only truth-establishing runs
                // in every non-disabled mode.
                await reconcileFills({ client, store });
            }
            ready = true;
            scheduleNext();
        } catch (error) {
            lock.release();
            throw error;
        }
    }

    async function stop() {
        stopped = true;
        if (timer) clearTimeout(timer);
        // Wait for whatever tick is currently mid-flight (already-fired timers aren't affected
        // by clearTimeout) before releasing the lock -- otherwise a systemd-restarted second
        // instance could acquire it and start deciding/executing while this process's own
        // broker calls for the same plans are still outstanding.
        await currentTick;
        // Same reasoning as the in-flight tick above: closed before the lock releases, not
        // after, so a systemd-restarted second instance never has two live sockets open for
        // the same account at once.
        if (stream) stream.close();
        // Graceful shutdown leaves broker-native protective orders intact (systemd hardening,
        // Section 8): this never cancels or flattens anything on the way out.
        if (lock) lock.release();
    }

    return { start, stop, isReady: () => ready };
}

module.exports = { createWorker, acquireInstanceLock, DEFAULT_LOCK_PATH };

if (require.main === module) {
    const { createPaperClient } = require('../services/alpaca_paper_service');
    const worker = createWorker({ createClient: createPaperClient });
    worker.start().catch((error) => {
        // eslint-disable-next-line no-console
        console.error('Alpaca Day Trading monitor failed to start:', error.message);
        process.exit(1);
    });
    const shutdown = () => { worker.stop().then(() => process.exit(0)); };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}
