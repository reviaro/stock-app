'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const { hash } = require('../services/research_data');
const { summarizePacket, compactQuality, MAX_SUMMARY_BYTES } = require('../services/research_summary');
const { createResearchService } = require('../services/research_service');

const now = new Date('2026-10-20T18:00:00Z');
const evidence = Array.from({ length: 2500 }, (_, index) => ({
    metric: 'Total Revenue', tag: 'RevenueFromContractWithCustomerExcludingAssessedTax', unit: 'USD',
    start: '2025-07-01', end: '2025-09-30', filed: '2025-10-30', form: '10-Q', accession: `0000123456-25-${String(index).padStart(6, '0')}`,
    url: `https://www.sec.gov/Archives/edgar/data/123456/000012345625${String(index).padStart(6, '0')}/`,
}));
const quality = { composite: 75, coveragePct: 100, metrics: { revenue: { value: 123, periods: ['2025-09-30'], method: 'Reported revenue' } }, filingEvidence: evidence };
const filings = { source: 'sec_edgar', asOf: '2026-10-20', evidence, annual: { 'Total Revenue': { '2025-09-30': 123 } }, quarterly: { 'Total Revenue': { '2025-09-30': 123 } },
    filings: [{ form: '10-Q', filedAt: '2025-10-30', url: evidence[0].url }] };
const wrapped = data => ({ status: 'success', data, meta: { source: 'sec_edgar', retrievedAt: now.toISOString() } });
function fixture() {
    let saved;
    const bridge = {
        getStockInfo: async () => wrapped({ symbol: 'TEST', quoteType: 'EQUITY', currency: 'USD', price: 100, timestamp: now.toISOString() }),
        getQualityMetrics: async () => wrapped(quality), getFilings: async () => wrapped(filings), getNews: async () => wrapped([]),
    };
    const service = createResearchService({ bridge, now: () => now, store: { savePacket: async packet => {
        saved = structuredClone(packet); return { ...packet, id: 'synthetic-packet', contentHash: hash(packet) };
    } } });
    return { service, bridge, saved: () => saved };
}
function loadWith(moduleName, overrides) {
    const path = require.resolve(moduleName), localRequire = createRequire(path), module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path, 'utf8'), { module, require: name => overrides[name] || localRequire(name) });
    return module.exports;
}

test('large filing archives stay intact in storage while chat receives a bounded projection', async () => {
    const { service, saved } = fixture();
    const packet = await service.packet('TEST'), summary = await service.summary('TEST');
    assert.ok(Buffer.byteLength(JSON.stringify(packet)) > 1024 * 1024);
    assert.ok(Buffer.byteLength(JSON.stringify(summary)) < MAX_SUMMARY_BYTES);
    assert.equal(summary.id, packet.id); assert.equal(summary.contentHash, hash(saved()));
    assert.equal(summary.representation, 'research_summary');
    assert.equal(summary.data.quality.composite, packet.data.quality.composite);
    assert.deepEqual(summary.data.quality.metrics, packet.data.quality.metrics);
    assert.deepEqual(summary.provenance, packet.provenance);
    assert.equal(summary.data.quality.filingEvidenceTotal, 2500);
    assert.equal(summary.data.quality.filingEvidence.length, 1);
    assert.equal(summary.data.filings.filings[0].url, evidence[0].url);
    assert.equal(summary.data.filings.annual, undefined); assert.equal(summary.data.filings.evidence, undefined);
    assert.equal(saved().data.filings.evidence.length, 2500);
    assert.equal((await service.packet('TEST')).data.quality.filingEvidence.length, 2500);
    const followUp = { messages: [{ role: 'assistant', parts: [{ type: 'tool-getResearchEvidence', toolCallId: 'test', state: 'output-available', input: { symbol: 'TEST' }, output: summary }] }, { role: 'user', parts: [{ type: 'text', text: 'Explain the risks.' }] }] };
    assert.ok(Buffer.byteLength(JSON.stringify(followUp)) < 1024 * 1024);
});

test('actual research and quality tools and brief context use compact results', async () => {
    const { service, bridge } = fixture();
    const { tools } = loadWith('../services/ai_service', { './research_service': service, './pybridge': bridge });
    const context = loadWith('../services/ai_context', { './research_service': service, '../database/db': { getMemo: async () => null } });
    for (const output of [await tools.getResearchEvidence.execute({ symbol: 'TEST' }), await tools.getQualityMetrics.execute({ symbol: 'TEST' }), await context.fetchStockContext('TEST')]) {
        assert.ok(Buffer.byteLength(JSON.stringify(output)) < MAX_SUMMARY_BYTES);
    }
    assert.equal((await context.fetchStockContext('TEST')).id, 'synthetic-packet');
});

test('unexpected oversize provider text fails closed without misrepresenting the full record hash', () => {
    const packet = { id: 'synthetic-packet', contentHash: 'full-record-hash', symbol: 'TEST', eligibleForDecision: true,
        provenance: { info: { available: true } }, data: { info: { description: 'x'.repeat(MAX_SUMMARY_BYTES * 2) }, news: [] } };
    const summary = summarizePacket(packet);
    assert.ok(Buffer.byteLength(JSON.stringify(summary)) < MAX_SUMMARY_BYTES);
    assert.equal(summary.eligibleForDecision, false); assert.match(summary.blockers[0], /exceeds/);
    assert.equal(summary.contentHash, packet.contentHash); assert.match(summary.fullPacket.hashScope, /complete saved packet/);
    assert.equal(packet.eligibleForDecision, true);
});

test('partial holdings and references are labeled and missing quality remains missing', () => {
    assert.equal(compactQuality(null), null);
    const summary = summarizePacket({ id: 'synthetic-packet', data: { fund: { holdings: Array.from({ length: 100 }, () => ({ symbol: 'TEST', weightPct: 1 })), disclosedWeightPct: 100 }, news: [] } });
    assert.equal(summary.data.fund.holdings.length, 20); assert.equal(summary.data.fund.holdingsTotal, 100);
    assert.match(summary.data.fund.holdingsScope, /analyzeExposure/);
});

test('the AI exposure tool uses verified classification and preserves failed lookups as unknown', async () => {
    const fund = require('../services/fund_research');
    const { tools } = loadWith('../services/ai_service', { './fund_research': { analyzeExposure: holdings => fund.analyzeExposure(holdings, { getPacket: async () => { throw Error('Provider unavailable'); } }) } });
    const result = await tools.analyzeExposure.execute({ holdings: [{ symbol: 'SPY', weightPct: 100 }] });
    assert.equal(result.complete, false); assert.deepEqual(result.underlying, []);
    assert.deepEqual(result.unknown, [{ symbol: 'SPY', weightPct: 100 }]);
});
