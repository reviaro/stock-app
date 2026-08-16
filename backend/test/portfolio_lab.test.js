const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createPortfolioLabService } = require('../services/portfolio_lab');

function validInput(overrides = {}) {
    return {
        symbols: ['aapl', 'MSFT', ' jpm '],
        current_weights_pct: { AAPL: 30, MSFT: 25, JPM: 20 },
        cash_target_pct: 10,
        max_position_pct: 40,
        max_sector_pct: 60,
        transaction_cost_bps: 10,
        lookback_years: 3,
        train_days: 252,
        test_days: 63,
        ...overrides,
    };
}

function validWorkerOutput() {
    const evidence = {
        run_type: 'out_of_sample', evidence_domain: 'allocation', start_date: '2024-01-01', end_date: '2025-01-01',
        trade_count: 0, total_return_pct: 8, benchmark_return_pct: 7,
        max_drawdown_pct: 5, sharpe: 0.8, notes: 'rebalance count',
    };
    const metrics = {
        total_return_pct: 8, benchmark_return_pct: 7, annualized_return_pct: 6,
        annualized_volatility_pct: 12, max_drawdown_pct: 5, sharpe: 0.8,
        turnover_pct: 20, transaction_cost_pct: 0.02,
    };
    const model = (id) => ({
        id, name: id, status: 'success', cash_weight_pct: 10,
        max_position_pct: 30, concentration_hhi: 0.27, current_target_turnover_pct: 15,
        constraint_handling: ['minimum_variance', 'cvar'].includes(id) ? 'native_optimization' : 'post_optimization_projection',
        target_weights: [
            { symbol: 'AAPL', sector: 'Technology', weight_pct: 30 },
            { symbol: 'MSFT', sector: 'Technology', weight_pct: 30 },
            { symbol: 'JPM', sector: 'Financial Services', weight_pct: 30 },
        ],
        out_of_sample: { ...metrics }, strategy_lab_evidence: { ...evidence },
    });
    return {
        generated_at: '2026-08-16', engine: { name: 'skfolio', version: '0.20.2' }, symbols: ['AAPL', 'MSFT', 'JPM'],
        sectors: { AAPL: 'Technology', MSFT: 'Technology', JPM: 'Financial Services' },
        history: { start_date: '2023-01-01', end_date: '2026-01-01', daily_price_rows: 700 },
        validation: { method: 'rolling_walk_forward', train_days: 252, test_days: 63, fold_count: 4, fold_lengths_days: [63, 63, 63, 42], includes_partial_final_fold: true, out_of_sample_start: '2024-01-01', out_of_sample_end: '2025-01-01' },
        constraints: { cash_target_pct: 10, max_position_pct: 40, max_sector_pct: 60, transaction_cost_bps: 10 },
        benchmark_model_id: 'equal_weight', warnings: [],
        data_quality: { provider: 'yfinance', auto_adjust: true, alignment: 'complete_shared_trading_days', forward_filled_prices: 0, dropped_incomplete_rows: 0 },
        models: ['equal_weight', 'inverse_volatility', 'hrp', 'minimum_variance', 'cvar'].map(model),
    };
}

test('Portfolio Lab normalizes validated input and is always advisory-only', async () => {
    let received;
    const service = createPortfolioLabService({
        runWorker: async (request) => {
            received = request;
            return { status: 'success', data: validWorkerOutput() };
        },
    });

    const result = await service.analyze(validInput());

    assert.deepEqual(received.symbols, ['AAPL', 'MSFT', 'JPM']);
    assert.deepEqual(received.current_weights_pct, { AAPL: 30, MSFT: 25, JPM: 20 });
    assert.equal(result.read_only, true);
    assert.equal(result.execution_enabled, false);
    assert.equal(result.models.length, 5);
});

test('Portfolio Lab rejects malformed, duplicate, and infeasible requests before spawning Python', async () => {
    let calls = 0;
    const service = createPortfolioLabService({ runWorker: async () => { calls += 1; } });

    await assert.rejects(service.analyze(validInput({ symbols: ['AAPL', 'aapl', 'MSFT'] })), /unique/i);
    await assert.rejects(service.analyze(validInput({ max_position_pct: 20 })), /infeasible.*position/i);
    await assert.rejects(service.analyze(validInput({ cash_target_pct: 101 })), /cash_target_pct/i);
    await assert.rejects(service.analyze(validInput({ transaction_cost_bps: -1 })), /transaction_cost_bps/i);
    await assert.rejects(service.analyze(validInput({ current_weights_pct: { TSLA: 10 } })), /current_weights_pct.*selected symbols/i);
    await assert.rejects(service.analyze(validInput({ cash_target_pct: null })), /cash_target_pct/i);
    await assert.rejects(service.analyze(validInput({ transaction_cost_bps: '' })), /transaction_cost_bps/i);
    await assert.rejects(service.analyze(validInput({ symbols: [true, 'MSFT', 'JPM'] })), /symbols.*strings/i);
    await assert.rejects(service.analyze(validInput({ current_weights_pct: { AAPL: 10, ' aapl ': 20 } })), /keys must be unique/i);
    assert.equal(calls, 0);
});

test('Portfolio Lab fails closed on malformed worker output', async () => {
    const service = createPortfolioLabService({ runWorker: async () => ({ status: 'success', data: null }) });
    await assert.rejects(service.analyze(validInput()), /invalid Portfolio Lab worker response/i);

    const incomplete = validWorkerOutput();
    delete incomplete.models[0].out_of_sample.total_return_pct;
    const malformedService = createPortfolioLabService({ runWorker: async () => ({ status: 'success', data: incomplete }) });
    await assert.rejects(malformedService.analyze(validInput()), /invalid Portfolio Lab worker response/i);
});

test('Portfolio Lab admits only one expensive worker at a time', async () => {
    let release;
    const blocked = new Promise((resolve) => { release = resolve; });
    const service = createPortfolioLabService({
        maxConcurrent: 1,
        runWorker: async () => {
            await blocked;
            return { status: 'success', data: validWorkerOutput() };
        },
    });
    const first = service.analyze(validInput());
    await assert.rejects(service.analyze(validInput()), (error) => error.statusCode === 429);
    release();
    await first;
});

test('Portfolio Lab service has no broker, simulator, ledger, or scheduler dependency', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'portfolio_lab.js'), 'utf8');
    assert.doesNotMatch(source, /alpaca|simulator|transactions|database\/db|node-cron/i);
});
