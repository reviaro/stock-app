const db = require('../database/db');

const RUN_TYPES = ['backtest', 'out_of_sample', 'paper'];
const REQUIRED_METRICS = ['total_return_pct', 'benchmark_return_pct', 'max_drawdown_pct'];
const OPTIONAL_METRICS = ['sharpe', 'win_rate', 'expectancy', 'avg_r'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validationError(message) {
    const error = new Error(message);
    error.statusCode = 400;
    return error;
}

function notFound(message) {
    const error = new Error(message);
    error.statusCode = 404;
    return error;
}

function requiredText(value, field) {
    if (typeof value !== 'string' || !value.trim()) {
        throw validationError(`${field} is required`);
    }
    return value.trim();
}

function parseRules(input) {
    if (input == null) throw validationError('rules are required');
    let rules = input;
    if (typeof input === 'string') {
        try {
            rules = JSON.parse(input);
        } catch (_error) {
            throw validationError('rules must be valid JSON');
        }
    }
    if (!rules || typeof rules !== 'object' || Object.keys(rules).length === 0) {
        throw validationError('rules must be a non-empty JSON object or array');
    }

    const seen = new WeakSet();
    function assertJsonValue(value) {
        if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
        if (typeof value === 'number' && Number.isFinite(value)) return;
        if (typeof value !== 'object') throw validationError('rules must be JSON serializable');
        if (seen.has(value)) throw validationError('rules must be JSON serializable');
        seen.add(value);
        for (const child of Array.isArray(value) ? value : Object.values(value)) assertJsonValue(child);
        seen.delete(value);
    }
    assertJsonValue(rules);
    return rules;
}

function isRealDate(value) {
    if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year
        && date.getUTCMonth() === month - 1
        && date.getUTCDate() === day;
}

function finiteMetric(input, field, optional = false) {
    const value = input[field];
    if (optional && (value === undefined || value === null)) return null;
    if (value === undefined || value === null || value === '' || (typeof value === 'string' && !value.trim())) {
        throw validationError(`${field} must be a finite number`);
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) throw validationError(`${field} must be a finite number`);
    return numeric;
}

function assessPromotionReadiness(runs) {
    const evidence = new Set(runs
        .filter((run) => run.evidence_domain !== 'allocation')
        .map((run) => run.run_type));
    const paperBlockers = [];
    if (!evidence.has('backtest')) paperBlockers.push('missing_backtest_evidence');
    if (!evidence.has('out_of_sample')) paperBlockers.push('missing_out_of_sample_evidence');
    const liveBlockers = [...paperBlockers];
    if (!evidence.has('paper')) liveBlockers.push('missing_paper_evidence');
    return {
        paper: { ready: paperBlockers.length === 0, blockers: paperBlockers },
        live: { ready: liveBlockers.length === 0, blockers: liveBlockers },
    };
}

async function createExperiment(input = {}) {
    const name = requiredText(input.name, 'name');
    const hypothesis = requiredText(input.hypothesis, 'hypothesis');
    return db.createStrategyExperiment({ name, hypothesis });
}

function listExperiments() {
    return db.listStrategyExperiments();
}

async function getExperiment(id) {
    const experiment = await db.getStrategyExperimentById(id);
    if (!experiment) throw notFound('strategy experiment not found');
    const [versionRows, runs] = await Promise.all([
        db.listStrategyVersions(id),
        db.listStrategyRunsForExperiment(id),
    ]);
    const versions = versionRows.map((version) => {
        const versionRuns = runs.filter((run) => run.version_id === version.id);
        return {
            ...version,
            rules: JSON.parse(version.rules_json),
            runs: versionRuns,
            promotion_readiness: assessPromotionReadiness(versionRuns),
        };
    });
    const latestVersion = versions.at(-1);
    return {
        ...experiment,
        versions,
        promotion_readiness: latestVersion
            ? latestVersion.promotion_readiness
            : assessPromotionReadiness([]),
    };
}

async function addVersion(experimentId, input = {}) {
    const experiment = await db.getStrategyExperimentById(experimentId);
    if (!experiment) throw notFound('strategy experiment not found');
    const rules = parseRules(input.rules);
    const versions = await db.listStrategyVersions(experimentId);
    const versionNumber = versions.reduce((max, version) => Math.max(max, version.version_number), 0) + 1;
    const created = await db.createStrategyVersion({
        experiment_id: experiment.id,
        version_number: versionNumber,
        rules_json: JSON.stringify(rules),
        notes: input.notes == null ? null : String(input.notes),
    });
    return { ...created, rules };
}

async function addRun(versionId, input = {}) {
    const version = await db.getStrategyVersionById(versionId);
    if (!version) throw notFound('strategy version not found');
    if (!RUN_TYPES.includes(input.run_type)) {
        throw validationError(`run_type must be one of: ${RUN_TYPES.join(', ')}`);
    }
    const evidenceDomain = input.evidence_domain == null ? 'trading' : input.evidence_domain;
    if (!['trading', 'allocation'].includes(evidenceDomain)) {
        throw validationError('evidence_domain must be one of: trading, allocation');
    }
    if (evidenceDomain === 'allocation' && (input.run_type !== 'out_of_sample' || Number(input.trade_count) !== 0)) {
        throw validationError('allocation evidence must be out_of_sample with trade_count 0');
    }
    if (!isRealDate(input.start_date)) throw validationError('start_date must be a real date in YYYY-MM-DD format');
    if (!isRealDate(input.end_date)) throw validationError('end_date must be a real date in YYYY-MM-DD format');
    if (input.start_date > input.end_date) throw validationError('start_date must be on or before end_date');

    const tradeCount = Number(input.trade_count);
    if (input.trade_count === '' || !Number.isInteger(tradeCount) || tradeCount < 0) {
        throw validationError('trade_count must be a non-negative integer');
    }
    const metrics = Object.fromEntries(REQUIRED_METRICS.map((field) => [field, finiteMetric(input, field)]));
    if (metrics.max_drawdown_pct < 0) throw validationError('max_drawdown_pct must be non-negative');
    const optionalMetrics = Object.fromEntries(OPTIONAL_METRICS.map((field) => [field, finiteMetric(input, field, true)]));

    return db.createStrategyRun({
        version_id: version.id,
        run_type: input.run_type,
        evidence_domain: evidenceDomain,
        start_date: input.start_date,
        end_date: input.end_date,
        trade_count: tradeCount,
        ...metrics,
        ...optionalMetrics,
        notes: input.notes == null ? null : String(input.notes),
    });
}

module.exports = {
    RUN_TYPES,
    createExperiment,
    listExperiments,
    getExperiment,
    addVersion,
    addRun,
    assessPromotionReadiness,
    promotionReadiness: assessPromotionReadiness,
};
