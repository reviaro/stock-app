function clamp(n, min = 0, max = 100) {
    return Math.max(min, Math.min(max, n));
}

const { numberOrNull } = require('./research_data');

function gradeReason(label, value, good, bad, unit = '') {
    if (value == null) return { points: 0, reason: `${label}: unavailable`, redFlag: `${label} data unavailable` };
    if (value <= good) return { points: 100, reason: `${label}: ${value}${unit} attractive` };
    if (value >= bad) return { points: 20, reason: `${label}: ${value}${unit} expensive`, redFlag: `${label} stretched` };
    const points = 100 - ((value - good) / (bad - good)) * 80;
    return { points, reason: `${label}: ${value}${unit} acceptable` };
}

function scoreCandidate({ stock = {}, quality = {}, technical = {} }) {
    const reasons = [];
    const red_flags = [];

    const qualityComposite = numberOrNull(quality.composite);
    if (['ETF','MUTUALFUND'].includes(stock.quoteType) || quality.applicable === false) return { score: 0, confidence: 0, coveragePct: 0, action: 'Research', reasons: ['Fund research: review fees, benchmark, holdings and liquidity.'], red_flags: ['Company quality and P/E scoring does not apply to funds'] };
    const qualityScore = qualityComposite ?? 35;
    if (qualityComposite != null) reasons.push(`Quality composite ${Math.round(qualityComposite)}/100`);
    else red_flags.push('quality score unavailable');

    const rawPE = numberOrNull(stock.forwardPE) ?? numberOrNull(stock.peRatio);
    const forwardPE = rawPE > 0 ? rawPE : null;
    const pe = gradeReason('Forward/actual P/E', forwardPE, 18, 45, 'x');
    reasons.push(pe.reason);
    if (pe.redFlag) red_flags.push(pe.redFlag);

    const rawDebt = numberOrNull(stock.debtToEquity);
    const debtToEquity = rawDebt != null && rawDebt >= 0 ? rawDebt : null;
    let debtScore = 0;
    if (debtToEquity != null) {
        debtScore = debtToEquity <= 50 ? 90 : debtToEquity <= 120 ? 60 : 25;
        reasons.push(`Debt/equity ${debtToEquity.toFixed(1)}%`);
        if (debtToEquity > 120) red_flags.push('high leverage');
    } else {
        red_flags.push('leverage data unavailable');
    }

    const rawRsi = numberOrNull(technical?.current?.rsi);
    const rsi = rawRsi != null && rawRsi >= 0 && rawRsi <= 100 ? rawRsi : null;
    let timingScore = 50;
    if (rsi != null) {
        if (rsi < 30) timingScore = 75;
        else if (rsi <= 65) timingScore = 65;
        else if (rsi <= 75) timingScore = 45;
        else timingScore = 25;
        reasons.push(`RSI ${rsi.toFixed(1)} (${technical?.interpretation?.rsi ?? 'neutral'})`);
        if (rsi > 75) red_flags.push('overbought technical setup');
    }

    const score = clamp((qualityScore * 0.4) + (pe.points * 0.3) + (debtScore * 0.2) + (timingScore * 0.1));
    const confidence = [qualityComposite, forwardPE, debtToEquity, numberOrNull(stock.price) > 0 ? stock.price : null].filter((v) => v != null).length / 4;

    let action = 'Research';
    if (score >= 78 && confidence === 1 && red_flags.length <= 1) action = 'Candidate';
    else if (score < 45 || red_flags.length >= 3) action = 'Avoid';
    else if (score < 65) action = 'Wait';

    return {
        score: Math.round(score),
        confidence: Math.round(confidence * 100),
        coveragePct: Math.round(confidence * 100),
        action,
        reasons: reasons.slice(0, 5),
        red_flags,
    };
}

module.exports = { scoreCandidate };
