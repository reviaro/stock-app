const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const TEST_DB = path.join(__dirname, 'test_strategy_lab.db');
process.env.DB_PATH_OVERRIDE = TEST_DB;

const db = require('../database/db');
const strategyLab = require('../services/strategy_lab');

function cleanupTestDb() {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
        const candidate = `${TEST_DB}${suffix}`;
        if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
    }
}

before(async () => {
    cleanupTestDb();
    await db.initDb();
});

beforeEach(async () => {
    const sqlite = db.getDb();
    await new Promise((resolve, reject) => {
        sqlite.exec('DELETE FROM strategy_runs; DELETE FROM strategy_versions; DELETE FROM strategy_experiments;', (err) => {
            sqlite.close((closeError) => {
                const error = err || closeError;
                error ? reject(error) : resolve();
            });
        });
    });
});

after(() => {
    cleanupTestDb();
});

test('creates, lists, and returns experiment detail', async () => {
    const created = await strategyLab.createExperiment({
        name: 'Earnings drift',
        hypothesis: 'Positive earnings surprises continue to outperform for 20 trading days.',
    });

    const list = await strategyLab.listExperiments();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].id, created.id);

    const detail = await strategyLab.getExperiment(created.id);
    assert.strictEqual(detail.name, 'Earnings drift');
    assert.deepStrictEqual(detail.versions, []);
    assert.deepStrictEqual(detail.promotion_readiness.paper, {
        ready: false,
        blockers: ['missing_backtest_evidence', 'missing_out_of_sample_evidence'],
    });
    assert.deepStrictEqual(detail.promotion_readiness.live, {
        ready: false,
        blockers: ['missing_backtest_evidence', 'missing_out_of_sample_evidence', 'missing_paper_evidence'],
    });
});

test('rejects blank experiment names and hypotheses', async () => {
    await assert.rejects(
        () => strategyLab.createExperiment({ name: ' ', hypothesis: 'testable' }),
        /name/i,
    );
    await assert.rejects(
        () => strategyLab.createExperiment({ name: 'Named', hypothesis: '' }),
        /hypothesis/i,
    );
});

test('adds a version with measurable rules persisted as JSON', async () => {
    const experiment = await strategyLab.createExperiment({
        name: 'Momentum',
        hypothesis: 'Stocks above their 200-day average outperform.',
    });
    const rules = {
        entry: { field: 'close_above_sma_200', operator: 'eq', value: true },
        exit: { field: 'holding_days', operator: 'gte', value: 20 },
    };

    const version = await strategyLab.addVersion(experiment.id, { rules, notes: 'Initial rules' });
    assert.strictEqual(version.version_number, 1);
    assert.deepStrictEqual(version.rules, rules);

    const detail = await strategyLab.getExperiment(experiment.id);
    assert.deepStrictEqual(detail.versions[0].rules, rules);
    assert.strictEqual(detail.versions[0].rules_json, JSON.stringify(rules));
});

test('rejects missing, empty, malformed, and non-serializable rules', async () => {
    const experiment = await strategyLab.createExperiment({ name: 'Rules', hypothesis: 'Rules can be tested.' });
    await assert.rejects(() => strategyLab.addVersion(experiment.id, {}), /rules/i);
    await assert.rejects(() => strategyLab.addVersion(experiment.id, { rules: {} }), /rules/i);
    await assert.rejects(() => strategyLab.addVersion(experiment.id, { rules: '{bad json' }), /JSON|rules/i);
    const circular = {};
    circular.self = circular;
    await assert.rejects(() => strategyLab.addVersion(experiment.id, { rules: circular }), /serializable|rules/i);
});

test('records runs and deterministically reports paper and live readiness without promotion', async () => {
    const experiment = await strategyLab.createExperiment({ name: 'Quality', hypothesis: 'High ROIC predicts excess returns.' });
    const version = await strategyLab.addVersion(experiment.id, {
        rules: { entry: { field: 'roic_pct', operator: 'gte', value: 15 } },
    });
    const base = {
        start_date: '2024-01-01',
        end_date: '2024-12-31',
        trade_count: 12,
        total_return_pct: 14.2,
        benchmark_return_pct: 9.1,
        max_drawdown_pct: 8.4,
        sharpe: 1.2,
        win_rate: 58.3,
        expectancy: 0.45,
        avg_r: 1.6,
        notes: 'No execution side effects',
    };

    await strategyLab.addRun(version.id, { ...base, run_type: 'backtest' });
    let detail = await strategyLab.getExperiment(experiment.id);
    assert.strictEqual(detail.promotion_readiness.paper.ready, false);
    assert.deepStrictEqual(detail.promotion_readiness.paper.blockers, ['missing_out_of_sample_evidence']);

    await strategyLab.addRun(version.id, { ...base, run_type: 'out_of_sample' });
    detail = await strategyLab.getExperiment(experiment.id);
    assert.strictEqual(detail.promotion_readiness.paper.ready, true);
    assert.deepStrictEqual(detail.promotion_readiness.paper.blockers, []);
    assert.deepStrictEqual(detail.promotion_readiness.live.blockers, ['missing_paper_evidence']);

    const paperRun = await strategyLab.addRun(version.id, { ...base, run_type: 'paper' });
    assert.strictEqual(paperRun.run_type, 'paper');
    assert.strictEqual(paperRun.trade_count, 12);
    assert.strictEqual(paperRun.sharpe, 1.2);

    detail = await strategyLab.getExperiment(experiment.id);
    assert.strictEqual(detail.promotion_readiness.live.ready, true);
    assert.strictEqual(Object.hasOwn(detail, 'promoted'), false);
    assert.strictEqual(Object.hasOwn(detail, 'live'), false);
});

test('assesses readiness from explicit evidence without side effects', () => {
    assert.deepStrictEqual(strategyLab.assessPromotionReadiness([
        { run_type: 'backtest' },
        { run_type: 'out_of_sample' },
    ]), {
        paper: { ready: true, blockers: [] },
        live: { ready: false, blockers: ['missing_paper_evidence'] },
    });
});

test('a new strategy version must gather its own promotion evidence', async () => {
    const experiment = await strategyLab.createExperiment({ name: 'Version evidence', hypothesis: 'Each rule version requires independent evidence.' });
    const first = await strategyLab.addVersion(experiment.id, { rules: { threshold: 10 } });
    const run = {
        start_date: '2024-01-01', end_date: '2024-12-31', trade_count: 2,
        total_return_pct: 2, benchmark_return_pct: 1, max_drawdown_pct: 1,
    };
    await strategyLab.addRun(first.id, { ...run, run_type: 'backtest' });
    await strategyLab.addRun(first.id, { ...run, run_type: 'out_of_sample' });
    await strategyLab.addVersion(experiment.id, { rules: { threshold: 20 } });

    const detail = await strategyLab.getExperiment(experiment.id);
    assert.strictEqual(detail.versions[0].promotion_readiness.paper.ready, true);
    assert.strictEqual(detail.versions[1].promotion_readiness.paper.ready, false);
    assert.deepStrictEqual(detail.promotion_readiness.paper.blockers, [
        'missing_backtest_evidence', 'missing_out_of_sample_evidence',
    ]);
});

test('validates run type, real dates, date order, counts, drawdown, and finite metrics', async () => {
    const experiment = await strategyLab.createExperiment({ name: 'Validation', hypothesis: 'Invalid evidence is rejected.' });
    const version = await strategyLab.addVersion(experiment.id, { rules: { max_positions: 10 } });
    const valid = {
        run_type: 'backtest', start_date: '2024-01-01', end_date: '2024-12-31', trade_count: 1,
        total_return_pct: 1, benchmark_return_pct: 0, max_drawdown_pct: 0,
    };

    await assert.rejects(() => strategyLab.addRun(version.id, { ...valid, run_type: 'live' }), /run_type/i);
    await assert.rejects(() => strategyLab.addRun(version.id, { ...valid, start_date: '2024-02-30' }), /start_date|date/i);
    await assert.rejects(() => strategyLab.addRun(version.id, { ...valid, start_date: '2025-01-01' }), /before|date/i);
    await assert.rejects(() => strategyLab.addRun(version.id, { ...valid, trade_count: -1 }), /trade_count/i);
    await assert.rejects(() => strategyLab.addRun(version.id, { ...valid, trade_count: 1.5 }), /trade_count/i);
    await assert.rejects(() => strategyLab.addRun(version.id, { ...valid, max_drawdown_pct: -0.1 }), /max_drawdown_pct/i);
    await assert.rejects(() => strategyLab.addRun(version.id, { ...valid, total_return_pct: Infinity }), /total_return_pct/i);
    await assert.rejects(() => strategyLab.addRun(version.id, { ...valid, sharpe: 'not-a-number' }), /sharpe/i);
});
