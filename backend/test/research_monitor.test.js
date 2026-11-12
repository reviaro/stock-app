'use strict';
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../database/db');
const store = require('../services/research_monitor_store');
const { createResearchMonitor, collectEvents, startResearchMonitor } = require('../services/research_monitor');
const { connection, run } = require('../services/research_store');
const stamp = '2026-11-12T15:00:00Z';
const quote = (symbol, price = 90) => ({ status: 'success', data: { symbol, currency: 'USD', price, timestamp: stamp, regularMarketPreviousClose: 100 } });
const status = { news: null, filings: null, price: null };
before(() => db.initDb());

test('news and filing identities survive repeated checks and reviews; unseen raced items stay unread', async () => {
    const news = url => ({ status: 'success', data: [{ title: 'Company earnings results', link: url, providerPublishTime: stamp }] });
    const first = collectEvents('NEWS', news('https://example.test/article?utm_source=one'), null, new Date(stamp));
    const again = collectEvents('NEWS', news('https://example.test/article?utm_source=two'), null, new Date(stamp));
    assert.equal(first[0].fingerprint, again[0].fingerprint);
    assert.equal(first[0].detail.category, 'Earnings');
    const save = events => store.recordCheck({ symbol: 'NEWS', events, status: { ...status }, quote: quote('NEWS'), checkedAt: stamp });
    await save(first);
    const visible = await store.inbox({ symbol: 'NEWS' });
    await save([{ ...first[0], fingerprint: 'new-raced-item', title: 'New item' }]);
    await store.review(visible.events.map(event => event.id)); await save(again);
    const unread = await store.inbox({ symbol: 'NEWS' });
    assert.deepEqual(unread.events.map(event => event.title), ['New item']);
    assert.equal((await store.inbox({ symbol: 'NEWS', includeReviewed: true })).events.length, 2);
    const stale = news('https://example.test/old'); stale.data[0].providerPublishTime = '2020-01-01';
    assert.equal(collectEvents('NEWS', stale, null, new Date(stamp)).length, 0);
    const unsafe = news('javascript:alert(1)');
    assert.equal(collectEvents('NEWS', unsafe, null, new Date(stamp))[0].url, null);
});

test('alert events and trigger state commit together, survive a service restart, and respect pause/reset', async () => {
    const rule = await store.saveRule({ symbol: 'ALRT', condition: 'below', threshold: 100 });
    const check = () => store.recordCheck({ symbol: 'ALRT', events: [], status: { ...status }, quote: quote('ALRT'), checkedAt: stamp });
    await check(); await check();
    assert.equal((await store.inbox({ symbol: 'ALRT' })).events.length, 1);
    const restarted = createResearchMonitor({ store, db: { getWatchlist: async () => [], listTransactions: async () => [] } });
    assert.equal((await restarted.overview()).alerts.find(r => r.id === rule.id).state.triggerCount, 1);
    await store.changeRule(rule.id, 'reset'); await store.changeRule(rule.id, 'disable'); await check();
    assert.equal((await store.inbox({ symbol: 'ALRT' })).events.length, 1);
    await store.changeRule(rule.id, 'enable'); await check();
    assert.equal((await store.inbox({ symbol: 'ALRT' })).events.length, 2);
    await store.changeRule(rule.id, 'delete');
    assert.equal((await store.inbox({ symbol: 'ALRT' })).events.length, 2);
});

test('memo imports are idempotent and only changed levels reset watching', async () => {
    let price = 100;
    const service = createResearchMonitor({ store, db: { getMemo: async () => ({ buy_below: price, trim_above: null }) } });
    await service.importMemo('MEMO');
    await store.recordCheck({ symbol: 'MEMO', events: [], quote: quote('MEMO'), status: { ...status }, checkedAt: stamp });
    await service.importMemo('MEMO');
    let alerts = (await store.rules()).filter(rule => rule.symbol === 'MEMO');
    assert.equal(alerts.length, 1); assert.equal(alerts[0].state.armed, false);
    price = 95; await service.importMemo('MEMO');
    alerts = (await store.rules()).filter(rule => rule.symbol === 'MEMO');
    assert.equal(alerts.length, 1); assert.equal(alerts[0].threshold, 95); assert.equal(alerts[0].state.armed, true);
    assert.equal(alerts[0].state.triggerCount, 1);
});

test('failed refresh preserves the last earnings report while exposing current coverage errors', async () => {
    await store.recordCheck({ symbol: 'EARN', events: [], quote: quote('EARN'), status: { ...status }, earnings: { asOf: '2026-11-12', rows: [] }, checkedAt: stamp });
    await store.recordCheck({ symbol: 'EARN', events: [], quote: { status: 'error' }, status: { ...status, filings: 'SEC unavailable' }, checkedAt: '2026-11-12T16:00:00Z' });
    const result = await store.earnings('EARN');
    assert.equal(result.report.asOf, '2026-11-12'); assert.equal(result.status, 'SEC unavailable');
});

test('checks follow only held/watchlist/active-alert symbols, share concurrent work and expose partial outages', async () => {
    const observed = [], records = [];
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const fake = { rules: async () => [{ symbol: 'ALERT', enabled: true }, { symbol: 'PAUSED', enabled: false }], recordCheck: async row => records.push(row) };
    const service = createResearchMonitor({ store: fake, now: () => new Date(stamp), db: {
        getWatchlist: async () => [{ symbol: 'WATCH' }], listTransactions: async () => [
            { id: 1, symbol: 'HELD', type: 'buy', shares: 1, amount: 1, txn_date: '2026-01-01' },
            { id: 2, symbol: 'SOLD', type: 'buy', shares: 1, amount: 1, txn_date: '2026-01-01' },
            { id: 3, symbol: 'SOLD', type: 'sell', shares: 1, amount: 1, txn_date: '2026-01-02' }],
    }, bridge: {
        getNews: async symbol => { observed.push(symbol); await gate; throw Error('private provider failure'); },
        getFilings: async () => ({ status: 'unavailable', configurationRequired: true }), getStockInfo: async symbol => quote(symbol),
    } });
    const first = service.check(), second = service.check(); assert.equal(first, second); release();
    assert.equal((await first).checked, 3); assert.deepEqual(observed.sort(), ['ALERT', 'HELD', 'WATCH']);
    assert.equal(records.length, 3); assert.match(records[0].status.news, /unavailable/);
    assert.match(records[0].status.filings, /configuration/); assert.equal(JSON.stringify(records).includes('private provider failure'), false);
    assert.equal((await service.check()).cached, true);
});

test('the scheduler starts and stops its owned timers without placing orders', () => {
    const callbacks = [], cleared = [];
    const stop = startResearchMonitor({ monitor: { check: async () => ({}) }, timers: {
        setTimeout: (fn, delay) => { callbacks.push({ fn, delay }); return 1; },
        setInterval: (fn, delay) => { callbacks.push({ fn, delay }); return 2; },
        clearTimeout: id => cleared.push(id), clearInterval: id => cleared.push(id),
    } });
    assert.deepEqual(callbacks.map(row => row.delay), [5000, 900000]); stop(); assert.deepEqual(cleared, [1, 2]);
});

test('opening an old earnings report refreshes its source and retains explicit stale evidence on failure', async () => {
    const old = { report: { asOf: '2026-10-01', rows: [] }, checkedAt: '2026-10-01T15:00:00Z', status: null };
    let result = { status: 'success', data: { earnings: { asOf: '2026-11-12', rows: [] } }, meta: { retrievedAt: stamp } };
    const service = createResearchMonitor({ now: () => new Date(stamp), store: { earnings: async () => old }, bridge: { getFilings: async () => result } });
    assert.equal((await service.earnings('TEST')).report.asOf, '2026-11-12');
    result = { status: 'error' };
    const fallback = await service.earnings('TEST');
    assert.equal(fallback.report.asOf, '2026-10-01'); assert.match(fallback.status, /out of date/);
});

test('inbox pagination cannot acknowledge items on later pages', async () => {
    await connection(async database => {
        for (let i = 0; i < 102; i++) await run(database, `INSERT INTO research_monitor_events
            (fingerprint,symbol,kind,title,detail_json,created_at) VALUES(?,?,?,?,?,?)`, [`page-${i}`, 'PAGE', 'news', `item ${i}`, '{}', stamp]);
    });
    const first = await store.inbox({ symbol: 'PAGE' }); assert.equal(first.events.length, 100); assert.ok(first.nextCursor);
    await store.review(first.events.map(event => event.id));
    assert.equal((await store.inbox({ symbol: 'PAGE' })).events.length, 2);
    assert.equal((await store.inbox({ symbol: 'PAGE', before: first.nextCursor })).events.length, 2);
});
