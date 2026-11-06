'use strict';
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { createTestDatabase } = require('../test-support/test_database');
createTestDatabase();
const db = require('../database/db');
const v2 = require('../services/alpaca_day_trade_v2_store');
const { retireDayTrading } = require('../services/alpaca_day_trading_retirement');
const query = (sql, params = []) => {
    const c = db.getDb();
    return new Promise((resolve, reject) => c.all(sql, params, (err, rows) => c.close(() => err ? reject(err) : resolve(rows))));
};
before(() => db.initDb());

test('retirement requires confirmation and atomically disables both monitors without removing plans', async () => {
    await query("UPDATE alpaca_monitor_state SET mode='paper_execute' WHERE id=1");
    await v2.updateMonitorState({ mode: 'paper_execute' });
    const { plan } = await v2.createPlan({ client_order_id: 'dt2-synthetic-retirement', symbol: 'XYZ', setup: 's', catalyst: 'c', thesis: 't', invalidation: 'i',
        planned_qty: 1, planned_entry_price: 100, planned_stop: 95, planned_target: 110, planned_risk_dollars: 5, exit_deadline: '2025-01-02T20:00:00.000Z' });
    await assert.rejects(retireDayTrading(''), { code: 'PAPER_RETIREMENT_CONFIRMATION_REQUIRED' });
    assert.equal((await v2.getMonitorState()).mode, 'paper_execute');
    assert.deepEqual(await retireDayTrading('RETIRE DAY TRADING'), { v1Mode: 'disabled', v2Mode: 'disabled' });
    assert.equal((await query('SELECT mode FROM alpaca_monitor_state WHERE id=1'))[0].mode, 'disabled');
    assert.equal((await v2.getMonitorState()).mode, 'disabled');
    assert.deepEqual(await v2.getPlan(plan.id), plan);
    assert.deepEqual(await retireDayTrading('RETIRE DAY TRADING'), { v1Mode: 'disabled', v2Mode: 'disabled' });
});

test('a live sender admission prevents retirement from reporting a completed transition', async () => {
    await v2.updateMonitorState({ mode: 'paper_execute' });
    const plan = (await v2.listPlans())[0];
    const owner = v2.beginEntryAttempt();
    try {
        await v2.admitEntrySubmission(plan.id, { owner });
        await assert.rejects(retireDayTrading('RETIRE DAY TRADING'), { code: 'PAPER_LEGACY_SUBMISSION_IN_PROGRESS' });
        assert.equal((await v2.getMonitorState()).mode, 'paper_execute');
    } finally { v2.endEntryAttempt(owner); }
    await retireDayTrading('RETIRE DAY TRADING');
});

test('an unresolved legacy lease refuses retirement without partially disabling monitors', async () => {
    await query("UPDATE alpaca_monitor_state SET mode='paper_execute', submission_lease_holder='synthetic-holder', submission_lease_expires_at=NULL WHERE id=1");
    await v2.updateMonitorState({ mode: 'paper_execute' });
    await assert.rejects(retireDayTrading('RETIRE DAY TRADING'), { code: 'PAPER_LEGACY_SUBMISSION_IN_PROGRESS' });
    assert.equal((await v2.getMonitorState()).mode, 'paper_execute');
    assert.equal((await query('SELECT mode FROM alpaca_monitor_state WHERE id=1'))[0].mode, 'paper_execute');
    await query('UPDATE alpaca_monitor_state SET submission_lease_holder=NULL WHERE id=1');
});

test('retirement HTTP endpoint requires a real operator principal', async () => {
    for (const auth of [undefined, { type: 'bearer', role: 'alpaca-day-trading-agent' }, { type: 'session' }, { type: 'session', role: 'operator' }]) {
        const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.auth = auth; next(); });
        app.use('/paper', require('../routes/alpaca_paper'));
        const server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        try {
            const status = await new Promise((resolve, reject) => {
                const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/paper/retire-day-trading', method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
                req.on('error', reject); req.end(JSON.stringify({ confirmation: 'RETIRE DAY TRADING' }));
            });
            assert.equal(status, auth?.role === 'operator' ? 200 : 403);
        } finally { await new Promise(resolve => server.close(resolve)); }
    }
});
