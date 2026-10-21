'use strict';
const crypto = require('node:crypto');
const QUOTE_MAX_AGE_MS = 4 * 24 * 3600_000; // Research valuation only; execution has separate strict limits.
function numberOrNull(value) {
    if (value == null || typeof value === 'boolean' || !['number','string'].includes(typeof value) || (typeof value === 'string' && !value.trim())) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}
function evidence(result, { now = new Date(), maxAgeMs = QUOTE_MAX_AGE_MS } = {}) {
    const data = result?.data ?? null;
    const meta = result?.meta || {};
    const timestamp = data?.timestamp ?? meta.eventAt ?? null;
    const age = timestamp ? now.getTime() - Date.parse(timestamp) : NaN;
    const demo = data?.isDemo === true || data?.is_demo === true || meta.isDemo === true;
    const stale = data?.stale === true || meta.stale === true || (Number.isFinite(age) && (age > maxAgeMs || age < -60_000));
    const available = result?.status === 'success' && data != null && !demo;
    return { source:meta.source || data?.source || 'yfinance', feed:data?.feed || null,
        eventAt:timestamp, retrievedAt:meta.retrievedAt || data?.retrievedAt || null,
        stale, isDemo:demo, available, timestampKnown:Number.isFinite(age),
        warning:!available ? 'Evidence unavailable' : stale ? 'Evidence is stale' : null };
}
function usablePrice(result, options) {
    const e = evidence(result, options), price = numberOrNull(result?.data?.price);
    return e.available && !e.stale && e.timestampKnown && price > 0 ? price : null;
}
function publicationTime(value) {
    const date=new Date(typeof value==='number'?value*1000:value);
    return value!=null && Number.isFinite(date.getTime())?date.toISOString():null;
}
function normalizeNews(result) {
    const e = evidence(result);
    if (!e.available || !Array.isArray(result.data)) return { items:[], evidence:{...e,available:false,warning:'News retrieval failed'} };
    const seen = new Set();
    const items = result.data.filter(item => item && typeof item.title === 'string' && item.title.trim()).map(item => ({
        title:item.title.trim(), publisher:item.publisher || null,
        url:typeof (item.link || item.url) === 'string' && /^https?:\/\//i.test(item.link || item.url) ? item.link || item.url : null,
        publishedAt:publicationTime(item.providerPublishTime ?? item.publishedAt),
    })).filter(item => { const key=item.url || item.title; if(seen.has(key))return false;seen.add(key);return true; });
    const dates=items.map(item=>item.publishedAt).filter(Boolean).sort();
    return {items,evidence:{...e,eventAt:dates.at(-1)||null,available:true,empty:items.length===0}};
}
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value==='object') return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
    return value;
}
const hash = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
module.exports = {numberOrNull,evidence,usablePrice,normalizeNews,hash,QUOTE_MAX_AGE_MS};
