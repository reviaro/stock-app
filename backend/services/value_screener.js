function clamp(n, min = 0, max = 100) {
    return Math.max(min, Math.min(max, n));
}

function numberOrNull(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

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
    const qualityScore = qualityComposite ?? 35;
    if (qualityComposite != null) reasons.push(`Quality composite ${Math.round(qualityComposite)}/100`);
    else red_flags.push('quality score unavailable');

    const forwardPE = numberOrNull(stock.forwardPE || stock.peRatio);
    const pe = gradeReason('Forward/actual P/E', forwardPE, 18, 45, 'x');
    reasons.push(pe.reason);
    if (pe.redFlag) red_flags.push(pe.redFlag);

    const debtToEquity = numberOrNull(stock.debtToEquity);
    let debtScore = 70;
    if (debtToEquity != null) {
        debtScore = debtToEquity <= 50 ? 90 : debtToEquity <= 120 ? 60 : 25;
        reasons.push(`Debt/equity ${debtToEquity.toFixed(1)}`);
        if (debtToEquity > 120) red_flags.push('high leverage');
    } else {
        red_flags.push('leverage data unavailable');
    }

    const rsi = numberOrNull(technical?.current?.rsi);
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
    const confidence = [qualityComposite, forwardPE, debtToEquity, stock.price].filter((v) => v != null && Number.isFinite(Number(v))).length / 4;

    let action = 'Research';
    if (score >= 78 && confidence >= 0.75 && red_flags.length <= 1) action = 'Candidate';
    else if (score < 45 || red_flags.length >= 3) action = 'Avoid';
    else if (score < 65) action = 'Wait';

    return {
        score: Math.round(score),
        confidence: Math.round(confidence * 100),
        action,
        reasons: reasons.slice(0, 5),
        red_flags,
    };
}

module.exports = { scoreCandidate };
