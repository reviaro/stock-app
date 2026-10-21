'use strict';

// Chat resends tool results on subsequent turns. Keep archives in the immutable
// packet store and send measured values plus a bounded set of source references.
const MAX_SUMMARY_BYTES = 32 * 1024;
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
const list = value => Array.isArray(value) ? value : [];

function compactQuality(quality) {
    if (!quality) return quality;
    const { filingEvidence, ...metrics } = quality;
    if (!Array.isArray(filingEvidence)) return metrics;
    const references = [...filingEvidence].sort((a, b) => String(b.end).localeCompare(String(a.end)) || String(b.filed).localeCompare(String(a.filed)));
    const seen = new Set();
    const recent = references.filter(row => {
        const key = [row.metric, row.start, row.end].join('|');
        if (seen.has(key)) return false;
        seen.add(key); return true;
    }).slice(0, 12);
    return { ...metrics, filingEvidence: recent, filingEvidenceTotal: filingEvidence.length,
        filingEvidenceScope: 'Recent references only; the full archive is retained in the saved research packet.' };
}

function summarizePacket(packet) {
    const data = packet.data || {};
    const summary = {
        ...pick(packet, ['schemaVersion', 'id', 'contentHash', 'symbol', 'generatedAt', 'accountScope', 'horizon', 'eligibleForDecision', 'blockers', 'limitations', 'provenance']),
        representation: 'research_summary',
        fullPacket: { path: `/api/research/packets/${encodeURIComponent(packet.id)}`, hashScope: 'contentHash identifies the complete saved packet, not this projection.' },
        data: {
            info: data.info,
            quality: compactQuality(data.quality),
            technical: data.technical ? Object.fromEntries(Object.entries(data.technical).filter(([key]) => !/chart/i.test(key))) : data.technical,
            canslim: data.canslim ? { ...data.canslim, relativeStrength: data.canslim.relativeStrength ? Object.fromEntries(Object.entries(data.canslim.relativeStrength).filter(([key]) => key !== 'cohort')) : data.canslim.relativeStrength } : data.canslim,
            weeklyTrend: data.weeklyTrend,
            news: list(data.news).slice(0, 10),
            fund: data.fund ? { ...data.fund, holdings: list(data.fund.holdings).slice(0, 20), holdingsTotal: list(data.fund.holdings).length,
                holdingsScope: 'At most 20 disclosed holdings shown; use analyzeExposure for complete look-through calculations.' } : data.fund,
            filings: data.filings ? { ...pick(data.filings, ['asOf', 'cik', 'source', 'limitations']), filings: list(data.filings.filings).slice(0, 10) } : data.filings,
        },
        omitted: ['Full annual and quarterly statement archives', 'Full filing-fact reference archive', 'Indicator charts and relative-strength cohort'],
        newsTotal: list(data.news).length,
        filingsTotal: list(data.filings?.filings).length,
    };
    if (Buffer.byteLength(JSON.stringify(summary)) <= MAX_SUMMARY_BYTES) return summary;
    // Unexpected provider text must not turn the next user message into HTTP 413.
    // Never silently truncate measured values or imply that omitted data was read.
    return { ...pick(summary, ['schemaVersion', 'id', 'contentHash', 'symbol', 'generatedAt', 'accountScope', 'horizon', 'representation', 'fullPacket']),
        eligibleForDecision: false, blockers: ['Research summary exceeds the chat evidence budget. Review the complete saved packet before drawing conclusions.'],
        provenance: {}, data: { news: [] }, omitted: ['All research detail; reference only because the summary exceeded its byte budget.'] };
}

module.exports = { compactQuality, summarizePacket, MAX_SUMMARY_BYTES };
