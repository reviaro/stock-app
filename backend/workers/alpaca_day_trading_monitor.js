const fs = require('fs');
const path = require('path');

const store = require('../services/alpaca_day_trade_store');
const { reconcileFills, buildObservation, recordWebSocketFill } = require('../services/alpaca_fill_reconciliation');
const { decidePlanAction, DEFAULT_MONITOR_POLICY } = require('../services/alpaca_day_trade_monitor');
const { executeManagementAction, NON_EXECUTABLE_BROKER_STATUSES, resolveTerminalDescendant } = require('../services/alpaca_day_trade_repair_execution');
const { createSessionDateResolver } = require('../services/alpaca_trading_calendar');
const { createTradeUpdatesStream } = require('../services/alpaca_trade_updates_stream');
const { TRADE_UPDATES_URL } = require('../services/alpaca_paper_service');

const DEFAULT_LOCK_PATH = path.join(__dirname, '..', '..', 'run', 'alpaca-day-trading-monitor.lock');
const DEFAULT_POLL_INTERVAL_MS = 60_000; // Section 8: every 60s while any plan/order/position is open
const DEFAULT_IDLE_POLL_INTERVAL_MS = 300_000; // Section 8: a slower cadence while flat/closed -- tunable, Stage 4 material
const TERMINAL_PLAN_STATES = ['closed', 'cancelled', 'error'];
const RISK_REDUCING_ACTIONS = ['flatten', 'submit_time_exit', 'buy_to_cover', 'cancel_unfilled_remainder', 'attach_protective_oco'];
const EXIT_ACTIONS = ['flatten', 'submit_time_exit', 'buy_to_cover'];

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
    leaseClock = () => new Date(),
    log = () => {},
    wsUrl = TRADE_UPDATES_URL,
    wsApiKey,
    wsApiSecret,
    streamFactory = createTradeUpdatesStream,
    exitPolicy,
    sleep,
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
    // A per-process monotonic counter, not the injected `now()` (frozen in tests) and not
    // last_rest_reconciliation_at (which stops advancing while reconciliation is stalled --
    // reusing it as the cycle id would make every event_key in a stalled tick collide with the
    // prior good tick's). Combined with the real wall clock so it also can't collide with a
    // prior process lifetime's keys after a restart.
    let tickSequence = 0;
    // Journaling is level-triggered by nature (buildObservation re-derives the decision fresh
    // every tick) but an unchanged "still nothing to do" observation is zero-information noise
    // in an append-only, never-pruned table. These track the last recorded state per plan (and
    // whether the account was already idle) so only genuine transitions get a row -- action
    // execution and kill-switch handling below are entirely unaffected by this, since deciding
    // and acting must never depend on whether the decision was worth writing down.
    const lastDecisionSignature = new Map();
    let wasIdle = false;

    // A semantic-event append is an audit row, not a lease: its insert-or-ignore outcome must
    // never gate whether the decide/execute loop actually runs an action, and a failure to
    // write it must never abort the rest of the tick (skipping later plans, a pending kill
    // switch, or the terminal block_entries write below). Logged, not thrown.
    async function recordMonitorEvent(payload) {
        try {
            return await store.appendEvent(payload);
        } catch (error) {
            log({ monitorEventError: error.message, eventKey: payload.event_key });
            return { inserted: false };
        }
    }

    async function runTick() {
        const monitorState = await store.getMonitorState();
        if (monitorState?.mode === 'disabled') return;
        tickSequence += 1;
        const cycleId = `${Date.now()}-${tickSequence}`;
        const occurredAt = new Date().toISOString();

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

        let pendingKillSwitch = false;
        const activatingDecisions = [];
        const sweepResults = [];

        const plans = (await store.listPlans(null)).filter((plan) => !TERMINAL_PLAN_STATES.includes(plan.state));
        let lastHealthCode = null;
        let lastHealthReason = null;
        // Unlike kill_switch, this is not a one-way trip -- rewritten unconditionally below,
        // true or false, every tick that reaches this point, so it self-heals the moment no
        // plan's decision requires it anymore rather than needing an operator to clear it.
        let anyBlockEntries = false;

        if (plans.length === 0) {
            if (!wasIdle) {
                await recordMonitorEvent({
                    event_key: `monitor:${cycleId}:no_active_plans`, plan_id: null, event_type: 'monitor_decision',
                    action: 'none', outcome: 'no_active_plans', reason: 'no_active_plans',
                    detail: { mode: monitorState.mode, cycle_id: cycleId }, occurred_at: occurredAt,
                });
                wasIdle = true;
            }
        } else {
            wasIdle = false;
        }

        // Bounded by currently-open plans, not by every plan this process has ever seen.
        const activePlanIds = new Set(plans.map((plan) => plan.id));
        for (const id of lastDecisionSignature.keys()) {
            if (!activePlanIds.has(id)) lastDecisionSignature.delete(id);
        }

        for (const plan of plans) {
            const observation = await buildObservation(plan, {
                client, policy, now, log,
            });
            const decision = decidePlanAction(observation);
            log({ planId: plan.id, symbol: plan.symbol, decision });

            if (decision.activateKillSwitch) {
                if (!monitorState.kill_switch && !pendingKillSwitch) {
                    await store.updateMonitorState({ kill_switch: true, block_entries: true });
                    await recordMonitorEvent({
                        event_key: `monitor:${cycleId}:kill_switch`,
                        plan_id: null,
                        event_type: 'kill_switch',
                        action: 'activate',
                        outcome: 'activated',
                        reason: decision.reason || 'safety_sweep_violation',
                        detail: {
                            cycle_id: cycleId,
                            health_code: decision.healthCode || null,
                            trigger_plan_id: plan.id,
                            symbol: plan.symbol,
                        },
                        occurred_at: occurredAt,
                    });
                    log({ killSwitchActivated: true, triggerPlanId: plan.id, symbol: plan.symbol, reason: decision.reason });
                }
                pendingKillSwitch = true;
                activatingDecisions.push(decision);
            }

            const isKillSwitchActive = Boolean(monitorState.kill_switch) || pendingKillSwitch;
            const isRiskReducing = RISK_REDUCING_ACTIONS.includes(decision.action);
            const isExitAction = EXIT_ACTIONS.includes(decision.action);

            const decisionOutcome = monitorState.mode === 'shadow'
                ? 'shadow_observed_only'
                : (decision.action === 'none' ? 'no_action_required' : (isKillSwitchActive && !isRiskReducing ? 'skipped_kill_switch_active' : 'action_pending'));
            if (decision.blockEntries) anyBlockEntries = true;
            if (decision.healthCode) { lastHealthCode = decision.healthCode; lastHealthReason = decision.reason; }
            const decisionSignature = JSON.stringify({
                action: decision.action, outcome: decisionOutcome, reason: decision.reason || null,
                healthCode: decision.healthCode || null, blockEntries: Boolean(decision.blockEntries),
                activateKillSwitch: Boolean(decision.activateKillSwitch),
            });
            if (lastDecisionSignature.get(plan.id) !== decisionSignature) {
                lastDecisionSignature.set(plan.id, decisionSignature);
                await recordMonitorEvent({
                    event_key: `monitor:${cycleId}:plan:${plan.id}`, plan_id: plan.id, event_type: 'monitor_decision',
                    action: decision.action, outcome: decisionOutcome, reason: decision.reason || null,
                    detail: {
                        mode: monitorState.mode, cycle_id: cycleId, health_code: decision.healthCode || null,
                        block_entries: Boolean(decision.blockEntries), activate_kill_switch: Boolean(decision.activateKillSwitch),
                    }, occurred_at: occurredAt,
                });
            }

            if (monitorState.mode === 'paper_execute') {
                if (isKillSwitchActive) {
                    const entryOrderId = observation.entryOrder?.id || plan.entry_parent_broker_order_id;
                    let hasActiveEntry = Boolean(entryOrderId) && observation.entryOrder && !NON_EXECUTABLE_BROKER_STATUSES.includes(observation.entryOrder.status);
                    if (hasActiveEntry && entryOrderId) {
                        try {
                            const chainRes = await resolveTerminalDescendant(entryOrderId, client);
                            hasActiveEntry = !chainRes.isNonExecutable;
                        } catch (chainErr) {
                            hasActiveEntry = true;
                            log({ planId: plan.id, symbol: plan.symbol, resolveEntryChainError: chainErr.message });
                        }
                    }
                    if (hasActiveEntry && !isExitAction) {
                        let cancelOutcome = 'cancel_requested';
                        const cancelDetail = {
                            cycle_id: cycleId,
                        };
                        try {
                            const res = await executeManagementAction(
                                { action: 'cancel_unfilled_remainder', reason: 'kill_switch_entry_cancel' },
                                { ...plan, entry_parent_broker_order_id: entryOrderId },
                                { client, holderId, now: now(), nowFn: leaseClock },
                            );
                            if (res?.result?.canceled === false && res?.result?.reason === 'not_cancelable') {
                                cancelOutcome = 'not_cancelable';
                            }
                        } catch (cancelErr) {
                            cancelOutcome = 'failed';
                            cancelDetail.error = cancelErr.message;
                            cancelDetail.broker_status = cancelErr.status ?? null;
                            cancelDetail.broker_code = cancelErr.brokerCode ?? null;
                            cancelDetail.broker_message = cancelErr.brokerMessage ?? null;
                            log({ planId: plan.id, symbol: plan.symbol, cancelEntryError: cancelErr.message, ...(cancelErr.brokerBodyRaw ? { brokerBodyRaw: cancelErr.brokerBodyRaw } : {}) });
                        }
                        sweepResults.push({
                            plan_id: plan.id,
                            symbol: plan.symbol,
                            action: 'cancel_unfilled_remainder',
                            outcome: cancelOutcome,
                            flat_verified: null,
                        });
                        await recordMonitorEvent({
                            event_key: `monitor:${cycleId}:plan:${plan.id}:cancel_entry`,
                            plan_id: plan.id,
                            event_type: 'monitor_action',
                            action: 'cancel_unfilled_remainder',
                            outcome: cancelOutcome,
                            reason: 'kill_switch_entry_cancel',
                            detail: cancelDetail,
                            occurred_at: occurredAt,
                        });
                        continue;
                    }
                    if (!isRiskReducing) {
                        if (decision.action !== 'none') {
                            log({ planId: plan.id, symbol: plan.symbol, skippedAction: decision.action, reason: 'kill_switch_active_or_pending' });
                        }
                        continue;
                    }
                }

                if (decision.action !== 'none') {
                    try {
                        const actionRes = await executeManagementAction(decision, plan, {
                            client, holderId, now: now(), nowFn: leaseClock, exitPolicy, sleep,
                        });
                        const actionOutcome = actionRes?.outcome || 'submitted';
                        const flatVerified = actionRes?.flatVerified ?? null;
                        if (isRiskReducing) {
                            sweepResults.push({
                                plan_id: plan.id,
                                symbol: plan.symbol,
                                action: decision.action,
                                outcome: actionOutcome,
                                flat_verified: flatVerified,
                            });
                        }
                        await recordMonitorEvent({
                            event_key: `monitor:${cycleId}:plan:${plan.id}:action`, plan_id: plan.id, event_type: 'monitor_action',
                            action: decision.action, outcome: actionOutcome, reason: decision.reason || null,
                            detail: {
                                cycle_id: cycleId,
                                flat_verified: flatVerified,
                            }, occurred_at: occurredAt,
                        });
                    } catch (error) {
                        log({ planId: plan.id, symbol: plan.symbol, executionError: error.message, ...(error.brokerBodyRaw ? { brokerBodyRaw: error.brokerBodyRaw } : {}) });
                        if (isRiskReducing) {
                            sweepResults.push({
                                plan_id: plan.id,
                                symbol: plan.symbol,
                                action: decision.action,
                                outcome: 'failed',
                                flat_verified: null,
                            });
                        }
                        await recordMonitorEvent({
                            event_key: `monitor:${cycleId}:plan:${plan.id}:action`, plan_id: plan.id, event_type: 'monitor_action',
                            action: decision.action, outcome: 'failed', reason: error.code || 'execution_failed',
                            detail: {
                                cycle_id: cycleId,
                                flat_verified: null,
                                error: error.message,
                                broker_status: error.status ?? null,
                                broker_code: error.brokerCode ?? null,
                                broker_message: error.brokerMessage ?? null,
                            }, occurred_at: occurredAt,
                        });
                    }
                }
            }
        }

        // When kill_switch was ALREADY latched at tick start, or was tripped this tick:
        // do NOT write block_entries/health_code/health_error here.
        if (!monitorState.kill_switch && !pendingKillSwitch) {
            const monitorStatePatch = {
                block_entries: anyBlockEntries,
                ...(lastHealthCode ? { health_code: lastHealthCode, health_error: lastHealthReason } : {}),
            };
            await store.updateMonitorState(monitorStatePatch);
        }

        if (sweepResults.length > 0) {
            await recordMonitorEvent({
                event_key: `monitor:${cycleId}:kill_switch_sweep`,
                plan_id: null,
                event_type: 'kill_switch',
                action: 'sweep_summary',
                outcome: 'recorded',
                reason: 'safety_sweep_completed',
                detail: {
                    cycle_id: cycleId,
                    sweep: sweepResults,
                },
                occurred_at: occurredAt,
            });
            log({ sweepSummary: true, sweep: sweepResults });
        }
    }

    function scheduleNext() {
        if (stopped) return;
        timer = setTimeout(() => {
            const nextTick = Promise.resolve(currentTick)
                .catch(() => {})
                .then(async () => {
                    if (stopped) return;
                    try {
                        await runTick();
                    } catch (error) {
                        log({ tickError: error.message });
                    }
                })
                .then(() => {
                    scheduleNext();
                });
            currentTick = nextTick;
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
        if (lock) lock.release();
    }

    async function runTickNow() {
        if (!ready || stopped) {
            throw new Error('worker is not running');
        }
        const prevTick = Promise.resolve(currentTick).catch(() => {});
        currentTick = prevTick.then(() => {
            if (stopped) throw new Error('worker is not running');
            return runTick();
        });
        return currentTick;
    }

    return { start, stop, isReady: () => ready, runTickNow };
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
