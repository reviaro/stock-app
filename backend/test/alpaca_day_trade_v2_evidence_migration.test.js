'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTestDatabase } = require('../test-support/test_database');
createTestDatabase();
const db = require('../database/db');

async function withDb(fn) {
    const connection = db.getDb();
    try { return await fn(connection); }
    finally { await new Promise((resolve, reject) => connection.close((error) => error ? reject(error) : resolve())); }
}
const execute = (sql) => withDb((connection) => new Promise((resolve, reject) =>
    connection.exec(sql, (error) => error ? reject(error) : resolve())));
const query = (sql) => withDb((connection) => new Promise((resolve, reject) =>
    connection.all(sql, (error, rows) => error ? reject(error) : resolve(rows))));

// Frozen pre-evidence v2 schema. Do not generate this from the implementation:
// the regression must exercise an upgrade from tables that lack the new fields.
const OLD_SCHEMA = `
CREATE TABLE alpaca_dt_v2_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT, client_order_id TEXT NOT NULL UNIQUE,
    symbol TEXT NOT NULL, setup TEXT NOT NULL, catalyst TEXT NOT NULL, thesis TEXT NOT NULL, invalidation TEXT NOT NULL,
    planned_qty INTEGER NOT NULL CHECK(planned_qty > 0), planned_entry_price REAL NOT NULL CHECK(planned_entry_price > 0),
    planned_stop REAL NOT NULL CHECK(planned_stop > 0), planned_target REAL NOT NULL CHECK(planned_target > 0),
    planned_risk_dollars REAL NOT NULL CHECK(planned_risk_dollars > 0), exit_deadline TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending_submission' CHECK(state IN ('pending_submission','submission_unknown','working','active','time_exit_pending','attention_required','closed','cancelled','rejected')),
    attention_code TEXT, parent_order_id TEXT, stop_order_id TEXT, target_order_id TEXT, exit_order_id TEXT,
    filled_entry_qty INTEGER NOT NULL DEFAULT 0 CHECK(filled_entry_qty >= 0), avg_entry_price REAL,
    filled_exit_qty INTEGER NOT NULL DEFAULT 0 CHECK(filled_exit_qty >= 0), avg_exit_price REAL,
    exit_reason TEXT CHECK(exit_reason IS NULL OR exit_reason IN ('take_profit','stop_loss','time_exit','operator_resolved')),
    realized_pnl REAL, realized_r REAL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), opened_at TEXT, closed_at TEXT
);
CREATE TABLE alpaca_dt_v2_fills (
    id INTEGER PRIMARY KEY AUTOINCREMENT, execution_id TEXT NOT NULL UNIQUE,
    plan_id INTEGER REFERENCES alpaca_dt_v2_plans(id), order_id TEXT NOT NULL, order_client_id TEXT,
    symbol TEXT NOT NULL, side TEXT NOT NULL CHECK(side IN ('buy','sell')),
    qty INTEGER NOT NULL CHECK(qty > 0), price REAL NOT NULL CHECK(price > 0),
    role TEXT CHECK(role IS NULL OR role IN ('entry','bracket_exit','time_exit')), executed_at TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('websocket','rest')),
    imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE alpaca_dt_v2_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT NOT NULL UNIQUE, plan_id INTEGER REFERENCES alpaca_dt_v2_plans(id),
    event_type TEXT NOT NULL, action TEXT, outcome TEXT, reason_code TEXT, detail_json TEXT NOT NULL DEFAULT '{}',
    occurred_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER alpaca_dt_v2_events_no_update BEFORE UPDATE ON alpaca_dt_v2_events
    BEGIN SELECT RAISE(ABORT,'alpaca_dt_v2_events is immutable'); END;
CREATE TRIGGER alpaca_dt_v2_events_no_delete BEFORE DELETE ON alpaca_dt_v2_events
    BEGIN SELECT RAISE(ABORT,'alpaca_dt_v2_events is immutable'); END;
CREATE TABLE alpaca_dt_v2_monitor_state (
    id INTEGER PRIMARY KEY CHECK(id = 1), mode TEXT NOT NULL DEFAULT 'disabled' CHECK(mode IN ('disabled','shadow','paper_execute')),
    kill_switch INTEGER NOT NULL DEFAULT 0 CHECK(kill_switch IN (0,1)),
    attention_required INTEGER NOT NULL DEFAULT 0 CHECK(attention_required IN (0,1)), attention_code TEXT,
    last_reconciled_at TEXT, last_websocket_at TEXT, session_date TEXT,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO alpaca_dt_v2_plans (
    id,client_order_id,symbol,setup,catalyst,thesis,invalidation,planned_qty,planned_entry_price,planned_stop,
    planned_target,planned_risk_dollars,exit_deadline,state,attention_code,parent_order_id,stop_order_id,target_order_id,
    filled_entry_qty,avg_entry_price,created_at,updated_at,opened_at
) VALUES (7,'dt2-synthetic-upgrade','TEST','range hold','synthetic catalyst','synthetic thesis','below range',
    2,100.5,98,104,5,'2027-02-03T19:30:00Z','attention_required','SYNTHETIC_REVIEW',
    'synthetic-parent','synthetic-stop','synthetic-target',2,100,
    '2027-02-03T14:59:00Z','2027-02-03T15:01:00Z','2027-02-03T15:00:00Z');
INSERT INTO alpaca_dt_v2_fills (id,execution_id,plan_id,order_id,order_client_id,symbol,side,qty,price,role,executed_at,source,imported_at)
    VALUES (11,'synthetic-execution',7,'synthetic-parent','dt2-synthetic-upgrade','TEST','buy',2,100,'entry',
    '2027-02-03T15:00:00.000001Z','rest','2027-02-03T15:00:01Z');
INSERT INTO alpaca_dt_v2_events (id,event_key,plan_id,event_type,action,outcome,reason_code,detail_json,occurred_at,created_at)
    VALUES (9,'synthetic-event',7,'anomaly','latch_attention','attention_required','SYNTHETIC_REVIEW',
    '{"symbol":"TEST","qty":2}','2027-02-03T15:01:00Z','2027-02-03T15:01:01Z');
INSERT INTO alpaca_dt_v2_monitor_state VALUES (1,'paper_execute',1,1,'SYNTHETIC_REVIEW',
    '2027-02-03T15:01:00Z','2027-02-03T15:00:01Z','2027-02-03','2027-02-03T15:01:00Z');
`;

test('evidence upgrade preserves existing trading state and is idempotent, with immutable new research tables', async () => {
    await execute(OLD_SCHEMA);
    const tables = ['alpaca_dt_v2_plans', 'alpaca_dt_v2_fills', 'alpaca_dt_v2_events', 'alpaca_dt_v2_monitor_state'];
    const before = Object.fromEntries(await Promise.all(tables.map(async (table) => [table, await query(`SELECT * FROM ${table} ORDER BY id`)])));
    await db.initDb();

    async function assertOriginalRows() {
        for (const table of tables) {
            const rows = await query(`SELECT * FROM ${table} ORDER BY id`);
            const originalKeys = Object.keys(before[table][0]);
            assert.deepEqual(rows.map((row) => Object.fromEntries(originalKeys.map((key) => [key, row[key]]))), before[table], table);
        }
        assert.deepEqual(await query('SELECT setup_id,strategy_version,catalyst_class,entry_evidence_json FROM alpaca_dt_v2_plans'), [{
            setup_id: 'legacy_unclassified', strategy_version: 'legacy_unversioned', catalyst_class: 'unclassified', entry_evidence_json: '{}',
        }]);
    }
    await assertOriginalRows();
    for (const table of ['alpaca_dt_v2_observations', 'alpaca_dt_v2_experiments']) assert.deepEqual(await query(`SELECT * FROM ${table}`), []);
    await execute(`
        INSERT INTO alpaca_dt_v2_observations (plan_id,observed_at,quote_at,bid,ask,feed,entry_qty,exit_qty,entry_price)
            VALUES (7,'2027-02-03T15:01:01Z','2027-02-03T15:01:00Z',100,100.02,'iex',2,0,100);
        INSERT INTO alpaca_dt_v2_experiments (name,setup_id,strategy_version,kind,parameters_json,created_at,ends_at,min_trades,cost_bps)
            VALUES ('Synthetic forward comparison','range','v1','stall_exit','{"afterMinutes":5,"minimumProgressR":0.25}',
            '2027-02-03T15:00:00Z','2027-02-04T15:00:00Z',30,5);
    `);
    const observations = await query('SELECT * FROM alpaca_dt_v2_observations');
    const experiments = await query('SELECT * FROM alpaca_dt_v2_experiments');
    await db.initDb();
    await assertOriginalRows();
    assert.deepEqual(await query('SELECT * FROM alpaca_dt_v2_observations'), observations);
    assert.deepEqual(await query('SELECT * FROM alpaca_dt_v2_experiments'), experiments);
    for (const table of ['alpaca_dt_v2_observations', 'alpaca_dt_v2_experiments']) {
        await assert.rejects(execute(`UPDATE ${table} SET id=id`), /research evidence is immutable/);
        await assert.rejects(execute(`DELETE FROM ${table}`), /research evidence is immutable/);
    }
    await assert.rejects(execute('DELETE FROM alpaca_dt_v2_events'), /alpaca_dt_v2_events is immutable/);
});
