'use strict';
const crypto = require('node:crypto');
const { connection, all, run } = require('./research_store');
const { validateRule, evaluateAlert, invalid } = require('./research_alerts');
const schema = [
    `CREATE TABLE IF NOT EXISTS research_monitor_events (id INTEGER PRIMARY KEY AUTOINCREMENT, fingerprint TEXT NOT NULL UNIQUE,
        symbol TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, url TEXT, published_at TEXT, detail_json TEXT NOT NULL,
        created_at TEXT NOT NULL, reviewed_at TEXT)`,
    `CREATE INDEX IF NOT EXISTS research_monitor_inbox ON research_monitor_events(reviewed_at, id)`,
    `CREATE TABLE IF NOT EXISTS research_monitor_symbols (symbol TEXT PRIMARY KEY, checked_at TEXT NOT NULL, status_json TEXT NOT NULL, earnings_json TEXT)`,
    `CREATE TABLE IF NOT EXISTS research_price_alerts (id TEXT PRIMARY KEY, symbol TEXT NOT NULL, config_json TEXT NOT NULL,
        state_json TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL)`,
];
const decodeRule = row => ({ id: row.id, ...JSON.parse(row.config_json), state: JSON.parse(row.state_json), enabled: Boolean(row.enabled) });
const rules = () => connection(async db => (await all(db, 'SELECT * FROM research_price_alerts ORDER BY symbol,id')).map(decodeRule));
async function transaction(fn) {
    return connection(async db => {
        await run(db, 'BEGIN IMMEDIATE');
        try { const result = await fn(db); await run(db, 'COMMIT'); return result; }
        catch (error) { await run(db, 'ROLLBACK'); throw error; }
    });
}
async function saveRule(input, { id = crypto.randomUUID(), source = 'custom' } = {}) {
    const config = { ...validateRule(input), source };
    return transaction(async db => {
        const previous = (await all(db, 'SELECT * FROM research_price_alerts WHERE id=?', [id]))[0];
        // Re-importing the same memo level must not silently re-arm a fired alert.
        if (previous?.config_json === JSON.stringify(config)) return decodeRule(previous);
        const count = (await all(db, 'SELECT COUNT(*) AS count FROM research_price_alerts'))[0].count;
        if (!previous && count >= 200) throw invalid('Up to 200 price alerts are supported. Remove an unused alert first.');
        const state = { armed: true, triggerCount: previous ? JSON.parse(previous.state_json).triggerCount || 0 : 0 };
        await run(db, `INSERT INTO research_price_alerts VALUES(?,?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET
            config_json=excluded.config_json,state_json=excluded.state_json,enabled=1,updated_at=excluded.updated_at`,
        [id, config.symbol, JSON.stringify(config), JSON.stringify(state), new Date().toISOString()]);
        return { id, ...config, state, enabled: true };
    });
}
async function changeRule(id, action) {
    if (!['enable', 'disable', 'reset', 'delete'].includes(action)) throw invalid('Unknown alert action.');
    return transaction(async db => {
        const row = (await all(db, 'SELECT * FROM research_price_alerts WHERE id=?', [id]))[0];
        if (!row) throw invalid('This alert no longer exists.');
        if (action === 'delete') return run(db, 'DELETE FROM research_price_alerts WHERE id=?', [id]);
        const state = JSON.parse(row.state_json);
        if (action === 'reset') { state.armed = true; delete state.lastQuoteAt; delete state.lastDay; }
        await run(db, 'UPDATE research_price_alerts SET enabled=?,state_json=?,updated_at=? WHERE id=?',
            [action === 'disable' ? 0 : 1, JSON.stringify(state), new Date().toISOString(), id]);
        return { changed: true };
    });
}
async function insertEvent(db, event, checkedAt) {
    return run(db, `INSERT OR IGNORE INTO research_monitor_events
        (fingerprint,symbol,kind,title,url,published_at,detail_json,created_at) VALUES(?,?,?,?,?,?,?,?)`,
    [event.fingerprint, event.symbol, event.kind, event.title, event.url || null, event.publishedAt || null, JSON.stringify(event.detail || {}), checkedAt]);
}
async function recordCheck({ symbol, events, quote, status, earnings, checkedAt }) {
    return transaction(async db => {
        for (const event of events) await insertEvent(db, event, checkedAt);
        const active = (await all(db, 'SELECT * FROM research_price_alerts WHERE symbol=? AND enabled=1', [symbol])).map(decodeRule);
        for (const rule of active) {
            const result = evaluateAlert(rule, rule.state, quote, new Date(checkedAt));
            if (result.warning) status.price = result.warning;
            if (result.hit) {
                const condition = { above: 'at or above', below: 'at or below', pct_up: 'up at least', pct_down: 'down at least' }[rule.condition];
                await insertEvent(db, { fingerprint: `alert:${rule.id}:${result.state.triggerCount}`, symbol, kind: 'price',
                    title: `${symbol} ${condition} ${rule.condition.startsWith('pct_') ? `${rule.threshold}%` : `$${rule.threshold}`}`,
                    publishedAt: result.quoteAt, detail: { category: 'Price level', label: rule.label, price: result.price,
                        changePct: result.changePct, quoteAt: result.quoteAt, ruleId: rule.id, source: quote.meta?.source || 'yfinance', condition: rule.condition, threshold: rule.threshold } }, checkedAt);
            }
            await run(db, 'UPDATE research_price_alerts SET state_json=? WHERE id=?', [JSON.stringify(result.state), rule.id]);
        }
        await run(db, `INSERT INTO research_monitor_symbols VALUES(?,?,?,?) ON CONFLICT(symbol) DO UPDATE SET
            checked_at=excluded.checked_at,status_json=excluded.status_json,
            earnings_json=COALESCE(excluded.earnings_json,research_monitor_symbols.earnings_json)`,
        [symbol, checkedAt, JSON.stringify(status), earnings ? JSON.stringify(earnings) : null]);
    });
}
async function inbox({ symbol, kind, includeReviewed = false, before } = {}) {
    const clauses = [], args = [];
    if (!includeReviewed) clauses.push('reviewed_at IS NULL');
    if (symbol) { clauses.push('symbol=?'); args.push(symbol); }
    if (kind) { clauses.push('kind=?'); args.push(kind); }
    if (before) { clauses.push('id<?'); args.push(before); }
    return connection(async db => {
        const rows = await all(db, `SELECT * FROM research_monitor_events ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''} ORDER BY id DESC LIMIT 101`, args);
        const unread = (await all(db, 'SELECT COUNT(*) AS count FROM research_monitor_events WHERE reviewed_at IS NULL'))[0].count;
        return { unread, nextCursor: rows.length > 100 ? rows[99].id : null, events: rows.slice(0, 100).map(row => ({
            id: row.id, symbol: row.symbol, kind: row.kind, title: row.title, url: row.url, publishedAt: row.published_at,
            createdAt: row.created_at, reviewedAt: row.reviewed_at, detail: JSON.parse(row.detail_json) })) };
    });
}
async function review(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => !Number.isSafeInteger(id) || id < 1)) throw invalid('Select between 1 and 100 displayed events to review.');
    return connection(db => run(db, `UPDATE research_monitor_events SET reviewed_at=? WHERE reviewed_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`, [new Date().toISOString(), ...ids]));
}
const symbols = () => connection(async db => (await all(db, 'SELECT * FROM research_monitor_symbols ORDER BY symbol')).map(row => ({ symbol: row.symbol, checkedAt: row.checked_at, status: JSON.parse(row.status_json) })));
const earnings = symbol => connection(async db => {
    const row = (await all(db, 'SELECT * FROM research_monitor_symbols WHERE symbol=?', [symbol]))[0];
    return row ? { report: row.earnings_json ? JSON.parse(row.earnings_json) : null, checkedAt: row.checked_at, status: JSON.parse(row.status_json).filings } : { report: null, checkedAt: null, status: 'Not checked yet.' };
});
module.exports = { schema, rules, saveRule, changeRule, recordCheck, inbox, review, symbols, earnings };
