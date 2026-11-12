'use strict';
const { hash, normalizeNews } = require('./research_data');
const { quoteStatus, SYMBOL, invalid } = require('./research_alerts');
const { computeHoldings } = require('./portfolio_ledger');
const INTERVAL_MS = 15 * 60_000;

function safeUrl(value) {
    try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.href : null; }
    catch { return null; }
}
function newsIdentity(item) {
    const url = safeUrl(item.url);
    if (!url) return item.title.toLowerCase().replace(/\s+/g, ' ').trim();
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) if (/^(utm_|guccounter|guce_referrer|gclid|fbclid)/i.test(key)) parsed.searchParams.delete(key);
    parsed.hash = ''; parsed.searchParams.sort();
    return parsed.href;
}
function category(title, items = '') {
    if (/\b(earnings|results|eps|guidance|forecast)\b/i.test(title) || /\b2\.02\b/.test(items)) return 'Earnings';
    if (/\b(acquisition|merger|takeover|buyout)\b/i.test(title) || /\b2\.01\b/.test(items)) return 'Deals';
    if (/\b(ceo|cfo|resign|leadership)\b/i.test(title) || /\b5\.02\b/.test(items)) return 'Leadership';
    if (/\b(dividend|buyback|repurchase)\b/i.test(title)) return 'Capital returns';
    if (/\b(lawsuit|investigation|restatement|bankruptcy)\b/i.test(title) || /\b(1\.03|4\.02)\b/.test(items)) return 'Risk';
    return 'Company update';
}
function collectEvents(symbol, news, filings, now) {
    const events = [], normalized = normalizeNews(news);
    const recent = stamp => !stamp || (Number.isFinite(Date.parse(stamp)) && Date.parse(stamp) <= now.getTime() + 60_000 && now.getTime() - Date.parse(stamp) <= 14 * 86400000);
    if (normalized.evidence.available) for (const item of normalized.items) {
        if (!recent(item.publishedAt)) continue;
        events.push({ fingerprint: hash(['news', symbol, newsIdentity(item)]), symbol, kind: 'news', title: item.title.slice(0, 1000),
            url: safeUrl(item.url), publishedAt: item.publishedAt, detail: { publisher: item.publisher, category: category(item.title), source: normalized.evidence.source } });
    }
    if (filings?.status === 'success') {
        for (const filing of filings.data?.filings || []) {
            if (!['8-K', '8-K/A', '10-Q', '10-Q/A', '10-K', '10-K/A', '20-F', '6-K'].includes(filing.form)
                || !recent(filing.filedAt) || !filing.accession || !safeUrl(filing.url)) continue;
            events.push({ fingerprint: hash(['filing', symbol, filing.accession]), symbol, kind: 'filing',
                title: `${symbol} filed ${filing.form}${filing.reportDate ? ` · period ended ${filing.reportDate}` : ''}`,
                url: safeUrl(filing.url), publishedAt: filing.filedAt, detail: { source: 'sec_edgar', category: category('', filing.items), items: filing.items, accession: filing.accession } });
        }
        const report = filings.data?.earnings, latest = report?.rows?.[0];
        if (latest && Object.values(latest.metrics).some(f => f && recent(f.filed))) {
            events.push({ fingerprint: hash(['earnings', symbol, latest]), symbol, kind: 'earnings',
                title: `${symbol} · earnings for quarter ended ${latest.end}`, url: safeUrl(report.latestReport?.url),
                publishedAt: Object.values(latest.metrics).filter(Boolean).map(f => f.filed).sort().at(-1),
                detail: { source: 'sec_edgar', category: 'Earnings', changes: report.changes, quarterEnd: latest.end } });
        }
    }
    return events;
}

function createResearchMonitor({ store = require('./research_monitor_store'), bridge = require('./pybridge'),
    db = require('../database/db'), now = () => new Date() } = {}) {
    let inFlight = null, lastFinished = 0;
    async function trackedSymbols() {
        const [watchlist, transactions, alerts] = await Promise.all([db.getWatchlist(), db.listTransactions(), store.rules()]);
        const held = Object.entries(computeHoldings(transactions)).filter(([, value]) => value.shares > 0).map(([symbol]) => symbol);
        return [...new Set([...watchlist.map(w => w.symbol), ...held, ...alerts.filter(r => r.enabled).map(r => r.symbol)])]
            .filter(symbol => SYMBOL.test(symbol)).sort();
    }
    async function overview(query = {}) {
        const [inbox, symbols, alerts, tracked] = await Promise.all([store.inbox(query), store.symbols(), store.rules(), trackedSymbols()]);
        return { ...inbox, symbols: symbols.filter(row => tracked.includes(row.symbol)), tracked, alerts,
            checking: Boolean(inFlight), intervalMinutes: 15 };
    }
    async function performCheck() {
        const symbols = await trackedSymbols();
        let index = 0;
        const worker = async () => {
            while (index < symbols.length) {
                const symbol = symbols[index++];
                const [newsResult, filingsResult, quoteResult] = await Promise.allSettled([
                    bridge.getNews(symbol), bridge.getFilings(symbol), bridge.getStockInfo(symbol),
                ]);
                const value = result => result.status === 'fulfilled' ? result.value : { status: 'error' };
                const news = value(newsResult), filings = value(filingsResult), quote = value(quoteResult), checked = now();
                const newsEvidence = normalizeNews(news).evidence;
                const status = {
                    news: newsEvidence.available && !newsEvidence.stale ? null : 'News unavailable or stale; coverage is incomplete.',
                    filings: filings?.status === 'success' ? null : filings?.configurationRequired
                        ? 'SEC contact configuration is needed for filings and earnings.' : 'SEC filings unavailable; previous earnings may be out of date.',
                    price: quoteStatus(quote, symbol, checked),
                };
                await store.recordCheck({ symbol, events: collectEvents(symbol, news, filings, checked), quote, status,
                    earnings: filings?.status === 'success' ? filings.data?.earnings : null, checkedAt: checked.toISOString() });
            }
        };
        // Bound simultaneous provider requests and never overlap manual/background runs.
        const workers = await Promise.allSettled(Array.from({ length: Math.min(3, symbols.length) }, worker));
        const failed = workers.find(result => result.status === 'rejected');
        if (failed) throw failed.reason;
        lastFinished = now().getTime();
        return { checked: symbols.length, checkedAt: now().toISOString() };
    }
    function check() {
        if (inFlight) return inFlight;
        if (lastFinished && now().getTime() - lastFinished < 60_000) return Promise.resolve({ cached: true, checkedAt: new Date(lastFinished).toISOString() });
        inFlight = performCheck().finally(() => { inFlight = null; });
        return inFlight;
    }
    async function importMemo(symbol) {
        if (!SYMBOL.test(symbol)) throw invalid('Enter a valid symbol.');
        const memo = await db.getMemo(symbol);
        if (!memo) throw invalid('Save a research memo with buy or trim levels first.');
        const levels = [['buy_below', 'below', 'Memo buy level'], ['trim_above', 'above', 'Memo trim level']]
            .filter(([field]) => typeof memo[field] === 'number' && Number.isFinite(memo[field]) && memo[field] > 0);
        if (!levels.length) throw invalid('This memo has no positive buy-below or trim-above price.');
        const imported = [];
        for (const [field, condition, label] of levels) imported.push(await store.saveRule({ symbol, condition, threshold: memo[field], label, repeat: false }, { id: `memo:${symbol}:${field}`, source: 'memo' }));
        return { imported };
    }
    async function earnings(symbol) {
        if (!SYMBOL.test(symbol)) throw invalid('Enter a valid symbol.');
        const saved = await store.earnings(symbol);
        const age = now().getTime() - Date.parse(saved.checkedAt);
        if (Number.isFinite(age) && age >= 0 && age < 30 * 60_000) return saved;
        const result = await bridge.getFilings(symbol).catch(() => null);
        return { report: result?.data?.earnings || saved.report, checkedAt: result?.meta?.retrievedAt || saved.checkedAt,
            status: result?.status === 'success' ? null : result?.configurationRequired
                ? 'SEC earnings need the server SEC_USER_AGENT contact name and email.'
                : 'SEC earnings unavailable; any previous report shown may be out of date.' };
    }
    return { overview, check, importMemo, earnings, store };
}
let singleton;
const getMonitor = () => singleton ||= createResearchMonitor();
function startResearchMonitor({ monitor = getMonitor(), timers = globalThis } = {}) {
    const tick = () => monitor.check().catch(() => console.error('[researchMonitor] Check failed; retrying at the next interval.'));
    const initial = timers.setTimeout(tick, 5000), interval = timers.setInterval(tick, INTERVAL_MS);
    initial.unref?.(); interval.unref?.();
    return () => { timers.clearTimeout(initial); timers.clearInterval(interval); };
}
module.exports = { createResearchMonitor, getMonitor, startResearchMonitor, collectEvents, newsIdentity, safeUrl };
