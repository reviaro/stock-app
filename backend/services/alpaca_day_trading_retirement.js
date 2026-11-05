'use strict';

const legacyV2 = require('./alpaca_day_trade_v2_store');
const error = (code, message, status = 409) => Object.assign(new Error(message), { code, status });

// One write fence covers both historical monitor modes. Nothing is canceled,
// sold, adopted, or erased; outstanding broker exposure still needs review.
async function retireDayTrading(confirmation) {
    if (confirmation !== 'RETIRE DAY TRADING') throw error('PAPER_RETIREMENT_CONFIRMATION_REQUIRED', 'Type RETIRE DAY TRADING to disable both historical monitors.', 400);
    await legacyV2.recoverEntrySubmissions();
    const db = require('../database/db').getDb();
    const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, err => err ? reject(err) : resolve()));
    const get = sql => new Promise((resolve, reject) => db.get(sql, (err, row) => err ? reject(err) : resolve(row)));
    try {
        await run('BEGIN IMMEDIATE');
        const pending = await get(`SELECT e.plan_id FROM alpaca_dt_v2_events e
            WHERE e.event_type = 'submission' AND e.action = 'entry_admitted'
            AND NOT EXISTS (SELECT 1 FROM alpaca_dt_v2_events settled
                WHERE settled.event_key = 'plan:' || e.plan_id || ':entry_settled') LIMIT 1`);
        const legacy = await get('SELECT submission_lease_holder, submission_lease_expires_at FROM alpaca_monitor_state WHERE id=1');
        if (pending || (legacy?.submission_lease_holder && (!Number.isFinite(Date.parse(legacy.submission_lease_expires_at)) || Date.parse(legacy.submission_lease_expires_at) >= Date.now()))) {
            throw error('PAPER_LEGACY_SUBMISSION_IN_PROGRESS', 'A historical submission is still in progress. Reconcile it before disabling the monitors.');
        }
        await run("UPDATE alpaca_monitor_state SET mode='disabled', block_entries=1, updated_at=datetime('now') WHERE id=1");
        await run("UPDATE alpaca_dt_v2_monitor_state SET mode='disabled', updated_at=datetime('now') WHERE id=1");
        await run(`INSERT OR IGNORE INTO alpaca_dt_v2_events(event_key,event_type,action,outcome,reason_code,detail_json,occurred_at)
            VALUES('long_term_retirement','mode_change','set_mode','disabled','OPERATOR_CONFIRMED','{}',?)`, [new Date().toISOString()]);
        await run('COMMIT');
        return { v1Mode: 'disabled', v2Mode: 'disabled' };
    } catch (err) {
        await run('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        await new Promise(resolve => db.close(resolve));
    }
}

module.exports = { retireDayTrading };
