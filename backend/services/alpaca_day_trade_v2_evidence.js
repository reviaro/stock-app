'use strict';

const { validateAndAnnotateQuote } = require('./alpaca_market_data');

const LEGACY_METADATA = Object.freeze({
    setup_id: 'legacy_unclassified', strategy_version: 'legacy_unversioned', catalyst_class: 'unclassified',
});
const ENTRY_EVIDENCE_KEYS = Object.freeze([
    'symbol', 'qty', 'stop', 'target', 'entry_price', 'exit_deadline', 'setup', 'catalyst', 'thesis', 'invalidation',
    'max_entry_price', 'max_notional_dollars', 'max_risk_dollars',
    'setup_id', 'strategy_version', 'catalyst_class', 'metadata_status', 'candidate_evidence_status',
    'candidate_observed_at', 'candidate_catalyst_at', 'candidate_relative_volume', 'candidate_relative_strength_pct',
    'candidate_trend', 'candidate_entry_trigger', 'candidate_atr', 'candidate_revision_reason',
    'quote_bid', 'quote_ask', 'quote_bid_size', 'quote_ask_size', 'quote_feed', 'quote_source_at', 'quote_retrieved_at',
    'quote_spread_bps', 'quote_valid', 'planned_reward_risk', 'min_reward_risk', 'daily_realized_pnl', 'daily_loss_limit', 'session_date',
]);
const CANDIDATE_FIELDS = new Set(['observed_at', 'catalyst_at', 'relative_volume', 'relative_strength_pct',
    'trend', 'entry_trigger', 'atr', 'revision_reason']);
const label = (value) => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/.test(value);
const boundedNumber = (value) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e9;

function invalid() {
    throw Object.assign(new Error('entry evidence is invalid or is not current'), { code: 'ALPACA_V2_EVIDENCE_INVALID' });
}

// Require explicit time zones and a real calendar date; Date.parse alone accepts
// impossible dates by silently carrying them into the following month.
function parseEvidenceTime(value) {
    if (typeof value !== 'string') return null;
    const m = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/);
    if (!m) return null;
    const [, year, month, day, hour, minute, second, fraction = '', zone] = m;
    if (+month < 1 || +month > 12 || +day < 1 || +day > new Date(Date.UTC(+year, +month, 0)).getUTCDate()
        || +hour > 23 || +minute > 59 || +second > 59
        || (zone !== 'Z' && (+zone.slice(1, 3) > 23 || +zone.slice(4) > 59))) return null;
    const milliseconds = Date.parse(value);
    if (!Number.isFinite(milliseconds)) return null;
    const nanoseconds = BigInt(milliseconds) * 1000000n + BigInt(fraction.padEnd(9, '0').slice(3) || '0');
    return { milliseconds, nanoseconds, iso: new Date(milliseconds).toISOString() };
}

function normalizeEntryMetadata(intent = {}, { now = new Date(), maxAgeMs = 15 * 60_000 } = {}) {
    const result = { ...LEGACY_METADATA };
    let classified = 0;
    for (const key of Object.keys(LEGACY_METADATA)) {
        if (intent[key] === undefined) continue;
        if (!label(intent[key])) invalid();
        result[key] = intent[key];
        classified += 1;
    }
    result.metadata_status = classified === 0 ? 'legacy_unclassified' : classified === 3 ? 'classified' : 'partially_classified';
    result.candidate_evidence_status = 'not_provided';
    if (intent.candidate_evidence === undefined) return result;
    const candidate = intent.candidate_evidence;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
        || Object.keys(candidate).some((key) => !CANDIDATE_FIELDS.has(key))) invalid();
    const observed = parseEvidenceTime(candidate.observed_at);
    if (!observed || !Number.isFinite(now.getTime()) || observed.nanoseconds > BigInt(now.getTime()) * 1000000n
        || !Number.isFinite(maxAgeMs) || maxAgeMs < 0
        || now.getTime() - observed.milliseconds > maxAgeMs) invalid();
    result.candidate_observed_at = observed.iso;
    if (candidate.catalyst_at !== undefined) {
        const catalyst = parseEvidenceTime(candidate.catalyst_at);
        if (!catalyst || catalyst.nanoseconds > observed.nanoseconds) invalid();
        result.candidate_catalyst_at = catalyst.iso;
    }
    for (const key of ['relative_volume', 'relative_strength_pct', 'atr']) {
        if (candidate[key] === undefined) continue;
        if (!boundedNumber(candidate[key]) || (key !== 'relative_strength_pct' && candidate[key] < 0)
            || (key === 'atr' && candidate[key] === 0)) invalid();
        result[`candidate_${key}`] = candidate[key];
    }
    if (candidate.trend !== undefined) {
        if (!['up', 'down', 'sideways', 'unknown'].includes(candidate.trend)) invalid();
        result.candidate_trend = candidate.trend;
    }
    if (candidate.entry_trigger !== undefined) {
        if (!label(candidate.entry_trigger)) invalid();
        result.candidate_entry_trigger = candidate.entry_trigger;
    }
    if (candidate.revision_reason !== undefined) {
        if (typeof candidate.revision_reason !== 'string' || !candidate.revision_reason.trim()
            || candidate.revision_reason.length > 300) invalid();
        result.candidate_revision_reason = candidate.revision_reason.trim();
    }
    result.candidate_evidence_status = 'provided';
    return result;
}

// Capture only known primitives, including on a refused request. Store sanitization
// removes identifier/token/URL-shaped text before this reaches the immutable journal.
function captureEntryEvidence(intent, { quote, policy = {}, now = new Date(), retrievedAt } = {}) {
    const source = intent && typeof intent === 'object' && !Array.isArray(intent) ? intent : {};
    let result;
    try { result = normalizeEntryMetadata(source, { now, maxAgeMs: policy.maxCandidateAgeMs }); }
    catch (_error) { result = { ...LEGACY_METADATA, metadata_status: 'invalid', candidate_evidence_status: 'invalid' }; }
    if (typeof source.symbol === 'string' && /^[A-Za-z]{1,5}(\.[A-Za-z])?$/.test(source.symbol.trim())) result.symbol = source.symbol.trim().toUpperCase();
    for (const key of ['qty', 'stop', 'target', 'max_entry_price', 'max_notional_dollars', 'max_risk_dollars']) {
        if (boundedNumber(source[key])) result[key] = source[key];
    }
    for (const key of ['setup', 'catalyst', 'thesis', 'invalidation']) {
        if (typeof source[key] === 'string') result[key] = source[key].slice(0, 1000);
    }
    const deadline = parseEvidenceTime(source.exit_deadline);
    if (deadline) result.exit_deadline = deadline.iso;
    if (!quote) return result;
    const raw = quote.quote || {};
    for (const [key, value] of [['quote_bid', raw.bp], ['quote_ask', raw.ap], ['quote_bid_size', raw.bs], ['quote_ask_size', raw.as]]) {
        if (boundedNumber(value) && value >= 0) result[key] = value;
    }
    if (['iex', 'sip'].includes(policy.feed)) result.quote_feed = policy.feed;
    const timestamp = parseEvidenceTime(raw.t);
    if (timestamp) result.quote_source_at = timestamp.iso;
    result.quote_retrieved_at = parseEvidenceTime(retrievedAt)?.iso || now.toISOString();
    if (result.quote_bid > 0 && result.quote_ask > 0) {
        result.quote_spread_bps = Math.round((result.quote_ask - result.quote_bid) / ((result.quote_ask + result.quote_bid) / 2) * 1e8) / 1e4;
    }
    try {
        validateAndAnnotateQuote(quote, { requestedSymbol: result.symbol, feed: policy.feed, now, maxAgeMs: policy.maxQuoteAgeMs });
        result.quote_valid = true;
    } catch (_error) { result.quote_valid = false; }
    return result;
}

module.exports = { ENTRY_EVIDENCE_KEYS, LEGACY_METADATA, normalizeEntryMetadata, captureEntryEvidence, parseEvidenceTime };
