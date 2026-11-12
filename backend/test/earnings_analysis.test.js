'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { analyzeEarnings } = require('../services/earnings_analysis');
const { createSecSource } = require('../services/sec_fundamentals');
const fact = (val, start, end, filed = '2026-02-15') => ({ val, start, end, filed, form: '10-K', accn: '0000000123-26-000001' });
const make = (revenues, extras = {}) => ({ cik: 123, facts: { 'us-gaap': { Revenues: { units: { USD: revenues } }, ...extras } } });
const options = { asOf: '2026-03-01' };

test('earnings match fiscal quarters, expose revisions and never use future or foreign-currency facts', () => {
    const result = analyzeEarnings(make([
        fact(100, '2024-01-01', '2024-03-31'), fact(120, '2025-01-01', '2025-03-31'),
        fact(130, '2025-01-01', '2025-03-31', '2026-02-20'), fact(900, '2025-01-01', '2025-03-31', '2027-01-01'),
        fact(400, '2025-01-01', '2025-09-30'),
    ], { GrossProfit: { units: { EUR: [fact(50, '2025-01-01', '2025-03-31')] } } }), options);
    assert.equal(result.rows.length, 2);
    assert.equal(result.rows[0].metrics.revenue.value, 130);
    assert.ok(Math.abs(result.rows[0].revenueYoY - 30) < 1e-9);
    assert.equal(result.rows[0].metrics.revenue.filed, '2026-02-20');
    assert.equal(result.rows[0].metrics.grossProfit, null);
    assert.match(result.rows[0].metrics.revenue.url, /sec.gov/);
});

test('fourth quarter requires contiguous same-concept quarters and never subtracts diluted EPS', () => {
    const quarters = [fact(100, '2025-01-01', '2025-03-31'), fact(110, '2025-04-01', '2025-06-30'),
        fact(120, '2025-07-01', '2025-09-30'), fact(500, '2025-01-01', '2025-12-31')];
    const eps = quarters.map(f => ({ ...f, val: f.val / 100 }));
    const result = analyzeEarnings(make(quarters, { EarningsPerShareDiluted: { units: { 'USD/shares': eps } } }), options);
    const q4 = result.rows[0];
    assert.equal(q4.end, '2025-12-31'); assert.equal(q4.metrics.revenue.value, 170);
    assert.equal(q4.metrics.revenue.derived, true); assert.equal(q4.metrics.revenue.components.length, 4);
    assert.equal(q4.metrics.eps, null);
    const missing = analyzeEarnings(make(quarters.filter((_, i) => i !== 1)), options);
    assert.equal(missing.rows.some(r => r.end === '2025-12-31'), false);
    const gap = analyzeEarnings(make(quarters.map((f, i) => i === 1 ? { ...f, start: '2025-04-03' } : f)), options);
    assert.equal(gap.rows.some(r => r.end === '2025-12-31'), false);
});

test('earnings warn about a newer filing, do not divide by losses or mix mismatched periods', () => {
    const result = analyzeEarnings(make([fact(-10, '2024-01-01', '2024-03-31'), fact(20, '2025-01-01', '2025-03-31')], {
        OperatingIncomeLoss: { units: { USD: [fact(5, '2025-01-10', '2025-03-31')] } },
    }), { ...options, filings: [{ form: '10-Q', reportDate: '2025-09-30' }] });
    assert.equal(result.rows[0].revenueYoY, null); assert.equal(result.rows[0].operatingMargin, null);
    assert.ok(result.warnings.some(w => /lag/.test(w)));
    assert.deepEqual(analyzeEarnings(make([]), options).rows, []);
});

test('SEC source resolves the earnings exhibit on a fixed SEC path and labels a lagging facts report', async () => {
    const calls = [];
    const source = createSecSource({ env: { SEC_USER_AGENT: 'Fixture fixture@example.test' }, now: () => new Date('2026-03-01'), fetchImpl: async url => {
        calls.push(url);
        let body;
        if (url.endsWith('company_tickers.json')) body = { 0: { ticker: 'TEST', cik_str: 123 } };
        else if (url.includes('companyfacts')) body = make([fact(100, '2025-01-01', '2025-03-31')]);
        else if (url.includes('submissions')) body = { filings: { recent: { accessionNumber: ['0000000123-26-000002', '0000000123-26-000001'], form: ['8-K', '10-K'], filingDate: ['2026-02-20', '2026-02-15'], reportDate: ['2025-12-31', '2025-12-31'], primaryDocument: ['results.htm', 'annual.htm'], items: ['2.02,9.01', ''] } } };
        else body = { directory: { item: [{ name: '../ex99-1.htm' }, { name: 'ex99-1.htm' }] } };
        return { ok: true, text: async () => JSON.stringify(body) };
    } });
    const result = await source.get('TEST');
    assert.equal(result.data.earnings.earningsRelease.exhibitUrl, 'https://www.sec.gov/Archives/edgar/data/123/000000012326000002/ex99-1.htm');
    assert.ok(result.data.earnings.warnings.some(w => /lag/.test(w)));
    await source.get('TEST'); assert.equal(calls.length, 4);
    assert.ok(calls.every(url => /^https:\/\/(www|data)\.sec\.gov\//.test(url)));
});
