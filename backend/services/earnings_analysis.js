'use strict';

// Dated, reported US-GAAP numbers. This report does not infer guidance or a trade.
const DAY = 86400000;
const METRICS = {
    revenue: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet'],
    grossProfit: ['GrossProfit'], operatingIncome: ['OperatingIncomeLoss'],
    netIncome: ['NetIncomeLoss', 'ProfitLoss'], eps: ['EarningsPerShareDiluted'],
};
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value));
const days = (end, start) => (Date.parse(end) - Date.parse(start)) / DAY;
const percent = (current, previous) => Number.isFinite(current) && Number.isFinite(previous) && previous > 0
    ? (current / previous - 1) * 100 : null;

function metricSeries(payload, tags, unit, asOf, derive) {
    const quarters = new Map();
    for (const tag of tags) {
        const periods = new Map();
        for (const fact of payload.facts?.['us-gaap']?.[tag]?.units?.[unit] || []) {
            if (!['10-Q', '10-Q/A', '10-K', '10-K/A'].includes(fact.form)
                || !validDate(fact.start) || !validDate(fact.end) || !validDate(fact.filed)
                || fact.filed > asOf || fact.end > asOf || !Number.isFinite(fact.val)) continue;
            const duration = days(fact.end, fact.start);
            if (!(duration >= 70 && duration <= 110) && !(duration >= 330 && duration <= 400)) continue;
            const key = `${fact.start}/${fact.end}`, prior = periods.get(key);
            if (!prior || fact.filed > prior.filed || (fact.filed === prior.filed && String(fact.accn) > String(prior.accn))) {
                periods.set(key, { value: fact.val, start: fact.start, end: fact.end, filed: fact.filed,
                    accession: fact.accn, form: fact.form, tag, derived: false,
                    url: /^\d{10}-\d{2}-\d{6}$/.test(fact.accn || '') && /^\d+$/.test(String(payload.cik))
                        ? `https://www.sec.gov/Archives/edgar/data/${Number(payload.cik)}/${fact.accn.replaceAll('-', '')}/` : null });
            }
        }
        const direct = [...periods.values()].filter(f => days(f.end, f.start) <= 110);
        for (const f of direct) if (!quarters.has(f.end)) quarters.set(f.end, f);
        if (!derive) continue; // Subtracting EPS would mix different weighted share counts.
        for (const annual of [...periods.values()].filter(f => days(f.end, f.start) >= 330)) {
            if (quarters.has(annual.end)) continue;
            const firstThree = direct.filter(f => f.start >= annual.start && f.end < annual.end).sort((a, b) => a.start.localeCompare(b.start));
            if (firstThree.length !== 3 || firstThree[0].start !== annual.start
                || firstThree.some((f, i) => i > 0 && days(f.start, firstThree[i - 1].end) !== 1)) continue;
            const start = new Date(Date.parse(firstThree[2].end) + DAY).toISOString().slice(0, 10);
            if (days(annual.end, start) < 70 || days(annual.end, start) > 110) continue;
            quarters.set(annual.end, { ...annual, start, value: annual.value - firstThree.reduce((sum, f) => sum + f.value, 0),
                derived: true, components: [annual, ...firstThree] });
        }
    }
    return quarters;
}

function analyzeEarnings(payload, { asOf = new Date().toISOString().slice(0, 10), filings = [], earningsRelease = null } = {}) {
    if (!validDate(asOf)) throw new Error('Invalid earnings cutoff');
    const series = Object.fromEntries(Object.entries(METRICS).map(([key, tags]) =>
        [key, metricSeries(payload, tags, key === 'eps' ? 'USD/shares' : 'USD', asOf, key !== 'eps')]));
    const ends = [...new Set([...series.revenue.keys(), ...series.netIncome.keys()])].sort().reverse();
    const rows = ends.slice(0, 8).map(end => {
        const base = series.revenue.get(end) || series.netIncome.get(end);
        const metrics = Object.fromEntries(Object.entries(series).map(([key, values]) => {
            const fact = values.get(end);
            return [key, fact && Math.abs(days(fact.start, base.start)) <= 3 ? fact : null];
        }));
        const yoy = key => {
            const current = metrics[key];
            if (!current) return null;
            const previous = [...series[key].values()].filter(f => Math.abs(days(end, f.end) - 365) <= 15
                && Math.abs(days(current.end, current.start) - days(f.end, f.start)) <= 7)
                .sort((a, b) => Math.abs(days(end, a.end) - 365) - Math.abs(days(end, b.end) - 365))[0];
            return percent(current.value, previous?.value);
        };
        const margin = key => metrics.revenue?.value > 0 && metrics[key] ? metrics[key].value / metrics.revenue.value * 100 : null;
        return { end, start: base.start, metrics, revenueYoY: yoy('revenue'), epsYoY: yoy('eps'),
            grossMargin: margin('grossProfit'), operatingMargin: margin('operatingIncome'), netMargin: margin('netIncome') };
    });
    const report = filings.find(f => ['10-Q', '10-K', '10-Q/A', '10-K/A'].includes(f.form));
    const warnings = [];
    if (!rows.length) warnings.push('No comparable standalone USD quarters were reported in the supported US-GAAP fields.');
    if (report?.reportDate && (!rows.length || days(report.reportDate, rows[0].end) > 20)) warnings.push('SEC financial facts lag the latest report. Read the filing before drawing conclusions.');
    if (rows.length && days(asOf, rows[0].end) > 180) warnings.push('The latest available quarter ended more than 180 days ago.');
    const changes = [], current = rows[0], previous = rows[1];
    if (current) {
        if (current.revenueYoY != null) changes.push(`Revenue ${current.revenueYoY >= 0 ? 'grew' : 'fell'} ${Math.abs(current.revenueYoY).toFixed(1)}% from the comparable quarter a year earlier.`);
        if (current.epsYoY != null) changes.push(`Diluted EPS ${current.epsYoY >= 0 ? 'grew' : 'fell'} ${Math.abs(current.epsYoY).toFixed(1)}% year over year.`);
        if (previous && days(current.end, previous.end) >= 70 && days(current.end, previous.end) <= 110
            && current.operatingMargin != null && previous.operatingMargin != null) {
            const change = current.operatingMargin - previous.operatingMargin;
            changes.push(`Operating margin ${change >= 0 ? 'expanded' : 'contracted'} ${Math.abs(change).toFixed(1)} percentage points from the previous quarter.`);
        }
    }
    return { asOf, source: 'sec_edgar', currency: 'USD', rows, changes, warnings, latestReport: report || null, earningsRelease,
        limitations: ['Reported results, not analyst estimates or forward guidance.',
            'Derived fourth quarters subtract three contiguous quarters from the annual total; diluted EPS is never derived.',
            'Growth is unavailable when the prior value is zero or negative. Unsupported taxonomies and currencies remain unavailable.'] };
}

module.exports = { analyzeEarnings };
