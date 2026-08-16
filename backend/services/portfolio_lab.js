const path = require('node:path');
const { createPythonCaller } = require('./pybridge');

const SYMBOL_RE = /^[A-Z0-9^][A-Z0-9.^-]{0,14}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MODEL_IDS = ['equal_weight', 'inverse_volatility', 'hrp', 'minimum_variance', 'cvar'];
const METRIC_FIELDS = [
    'total_return_pct', 'benchmark_return_pct', 'annualized_return_pct',
    'annualized_volatility_pct', 'max_drawdown_pct', 'sharpe',
    'turnover_pct', 'transaction_cost_pct',
];

function validationError(message) {
    const error = new Error(message);
    error.statusCode = 400;
    return error;
}

function internalContractError() {
    const error = new Error('Invalid Portfolio Lab worker response');
    error.statusCode = 502;
    return error;
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(input, field, { min, max, integer = false }) {
    const value = input[field];
    if (typeof value !== 'number' || !Number.isFinite(value)
        || value < min || value > max || (integer && !Number.isInteger(value))) {
        throw validationError(`${field} must be ${integer ? 'an integer ' : ''}between ${min} and ${max}`);
    }
    return value;
}

function normalizeRequest(input = {}) {
    if (!isPlainObject(input)) throw validationError('request body must be an object');
    if (!Array.isArray(input.symbols) || input.symbols.length < 3 || input.symbols.length > 30) {
        throw validationError('symbols must contain between 3 and 30 entries');
    }
    if (input.symbols.some((value) => typeof value !== 'string')) {
        throw validationError('symbols entries must be strings');
    }
    const symbols = input.symbols.map((value) => value.trim().toUpperCase());
    if (symbols.some((symbol) => !SYMBOL_RE.test(symbol))) {
        throw validationError('symbols contains an invalid ticker');
    }
    if (new Set(symbols).size !== symbols.length) {
        throw validationError('symbols must be unique');
    }

    const cashTargetPct = finiteNumber(input, 'cash_target_pct', { min: 0, max: 90 });
    const maxPositionPct = finiteNumber(input, 'max_position_pct', { min: 1, max: 100 });
    const maxSectorPct = finiteNumber(input, 'max_sector_pct', { min: 1, max: 100 });
    const transactionCostBps = finiteNumber(input, 'transaction_cost_bps', { min: 0, max: 100 });
    const lookbackYears = finiteNumber(input, 'lookback_years', { min: 1, max: 10, integer: true });
    const trainDays = finiteNumber(input, 'train_days', { min: 126, max: 756, integer: true });
    const testDays = finiteNumber(input, 'test_days', { min: 21, max: 252, integer: true });

    const investablePct = 100 - cashTargetPct;
    if (maxPositionPct * symbols.length + 1e-9 < investablePct) {
        throw validationError('infeasible position constraint: max_position_pct cannot allocate the investable portfolio');
    }
    if (lookbackYears * 252 < trainDays + (2 * testDays)) {
        throw validationError('lookback_years must provide room for the training window and at least two test windows');
    }

    const weightsInput = input.current_weights_pct == null ? {} : input.current_weights_pct;
    if (!isPlainObject(weightsInput)) throw validationError('current_weights_pct must be an object');
    const currentWeightsPct = {};
    const normalizedWeightKeys = new Set();
    for (const [rawSymbol, rawWeight] of Object.entries(weightsInput)) {
        const symbol = rawSymbol.trim().toUpperCase();
        if (normalizedWeightKeys.has(symbol)) {
            throw validationError('current_weights_pct keys must be unique after normalization');
        }
        normalizedWeightKeys.add(symbol);
        if (!symbols.includes(symbol)) {
            throw validationError('current_weights_pct keys must be selected symbols');
        }
        if (typeof rawWeight !== 'number' || !Number.isFinite(rawWeight) || rawWeight < 0 || rawWeight > 100) {
            throw validationError('current_weights_pct values must be numbers between 0 and 100');
        }
        currentWeightsPct[symbol] = rawWeight;
    }
    const currentWeightTotal = Object.values(currentWeightsPct).reduce((sum, value) => sum + value, 0);
    if (currentWeightTotal > 100 + 1e-9) {
        throw validationError('current_weights_pct cannot total more than 100');
    }

    return {
        symbols,
        current_weights_pct: currentWeightsPct,
        cash_target_pct: cashTargetPct,
        max_position_pct: maxPositionPct,
        max_sector_pct: maxSectorPct,
        transaction_cost_bps: transactionCostBps,
        lookback_years: lookbackYears,
        train_days: trainDays,
        test_days: testDays,
    };
}

function assertWorker(condition) {
    if (!condition) throw internalContractError();
}

function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

function validateWorkerData(data, request) {
    assertWorker(isPlainObject(data));
    assertWorker(typeof data.generated_at === 'string' && DATE_RE.test(data.generated_at));
    assertWorker(isPlainObject(data.engine) && data.engine.name === 'skfolio' && data.engine.version === '0.20.2');
    assertWorker(Array.isArray(data.symbols) && data.symbols.length === request.symbols.length);
    assertWorker(data.symbols.every((symbol, index) => symbol === request.symbols[index]));
    assertWorker(isPlainObject(data.sectors));
    assertWorker(request.symbols.every((symbol) => typeof data.sectors[symbol] === 'string' && data.sectors[symbol]));

    const history = data.history;
    assertWorker(isPlainObject(history) && DATE_RE.test(history.start_date) && DATE_RE.test(history.end_date));
    assertWorker(Number.isInteger(history.daily_price_rows) && history.daily_price_rows > 0);

    const validation = data.validation;
    assertWorker(isPlainObject(validation) && validation.method === 'rolling_walk_forward');
    assertWorker(validation.train_days === request.train_days && validation.test_days === request.test_days);
    assertWorker(Number.isInteger(validation.fold_count) && validation.fold_count >= 2);
    assertWorker(Array.isArray(validation.fold_lengths_days)
        && validation.fold_lengths_days.length === validation.fold_count
        && validation.fold_lengths_days.every((days) => Number.isInteger(days) && days >= 21 && days <= request.test_days));
    assertWorker(typeof validation.includes_partial_final_fold === 'boolean');
    assertWorker(DATE_RE.test(validation.out_of_sample_start) && DATE_RE.test(validation.out_of_sample_end));

    const constraints = data.constraints;
    assertWorker(isPlainObject(constraints));
    for (const field of ['cash_target_pct', 'max_position_pct', 'max_sector_pct', 'transaction_cost_bps']) {
        assertWorker(constraints[field] === request[field]);
    }
    assertWorker(data.benchmark_model_id === 'equal_weight');
    assertWorker(Array.isArray(data.warnings) && data.warnings.every((warning) => typeof warning === 'string'));
    assertWorker(isPlainObject(data.data_quality)
        && data.data_quality.provider === 'yfinance'
        && data.data_quality.auto_adjust === true
        && data.data_quality.alignment === 'complete_shared_trading_days'
        && data.data_quality.forward_filled_prices === 0
        && data.data_quality.dropped_incomplete_rows === 0);

    assertWorker(Array.isArray(data.models) && data.models.length === MODEL_IDS.length);
    assertWorker(data.models.every((model, index) => isPlainObject(model) && model.id === MODEL_IDS[index]));
    const investablePct = 100 - request.cash_target_pct;
    let successfulModels = 0;
    for (const model of data.models) {
        assertWorker(typeof model.name === 'string' && model.name);
        assertWorker(model.status === 'success' || model.status === 'error');
        assertWorker(Array.isArray(model.target_weights));
        if (model.status === 'error') {
            assertWorker(typeof model.error === 'string' && model.error);
            continue;
        }
        successfulModels += 1;
        assertWorker(isFiniteNumber(model.cash_weight_pct)
            && Math.abs(model.cash_weight_pct - request.cash_target_pct) <= 1e-4);
        assertWorker(isFiniteNumber(model.max_position_pct) && model.max_position_pct <= request.max_position_pct + 1e-3);
        assertWorker(isFiniteNumber(model.concentration_hhi) && model.concentration_hhi >= 0);
        assertWorker(model.constraint_handling === (
            ['minimum_variance', 'cvar'].includes(model.id)
                ? 'native_optimization'
                : 'post_optimization_projection'
        ));
        assertWorker(model.current_target_turnover_pct === null || isFiniteNumber(model.current_target_turnover_pct));
        assertWorker(model.target_weights.length === request.symbols.length);
        const seen = new Set();
        const sectorWeights = new Map();
        let weightTotal = 0;
        for (const weight of model.target_weights) {
            assertWorker(isPlainObject(weight) && request.symbols.includes(weight.symbol) && !seen.has(weight.symbol));
            seen.add(weight.symbol);
            assertWorker(weight.sector === data.sectors[weight.symbol]);
            assertWorker(isFiniteNumber(weight.weight_pct) && weight.weight_pct >= -1e-6
                && weight.weight_pct <= request.max_position_pct + 1e-3);
            weightTotal += weight.weight_pct;
            sectorWeights.set(weight.sector, (sectorWeights.get(weight.sector) || 0) + weight.weight_pct);
        }
        assertWorker(Math.abs(weightTotal - investablePct) <= 1e-3);
        assertWorker([...sectorWeights.values()].every((value) => value <= request.max_sector_pct + 1e-3));

        assertWorker(isPlainObject(model.out_of_sample));
        assertWorker(METRIC_FIELDS.every((field) => isFiniteNumber(model.out_of_sample[field])));
        assertWorker(model.out_of_sample.max_drawdown_pct >= 0);
        const evidence = model.strategy_lab_evidence;
        assertWorker(isPlainObject(evidence) && evidence.run_type === 'out_of_sample'
            && evidence.evidence_domain === 'allocation' && evidence.trade_count === 0);
        assertWorker(DATE_RE.test(evidence.start_date) && DATE_RE.test(evidence.end_date));
        assertWorker(['total_return_pct', 'benchmark_return_pct', 'max_drawdown_pct', 'sharpe']
            .every((field) => isFiniteNumber(evidence[field])));
        assertWorker(typeof evidence.notes === 'string' && evidence.notes);
    }
    assertWorker(successfulModels > 0 && data.models[0].status === 'success');
    return data;
}

function createDefaultWorker() {
    const pythonPath = process.env.PORTFOLIO_LAB_PYTHON
        || path.join(__dirname, '..', 'portfolio_lab', 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    const scriptPath = path.join(__dirname, '..', 'portfolio_lab', 'worker.py');
    return createPythonCaller({
        pythonPath,
        scriptPath,
        timeoutMs: Number(process.env.PORTFOLIO_LAB_TIMEOUT_MS) || 180_000,
        maxOutputBytes: Number(process.env.PORTFOLIO_LAB_MAX_OUTPUT_BYTES) || 10 * 1024 * 1024,
    });
}

function createPortfolioLabService({ runWorker = createDefaultWorker(), maxConcurrent = 1 } = {}) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 4) {
        throw new Error('maxConcurrent must be an integer between 1 and 4');
    }
    let activeWorkers = 0;
    return {
        async analyze(input) {
            const request = normalizeRequest(input);
            if (activeWorkers >= maxConcurrent) {
                const error = new Error('Portfolio Lab is busy; try again after the current analysis finishes');
                error.statusCode = 429;
                throw error;
            }
            activeWorkers += 1;
            try {
                const result = await runWorker(request);
                if (!result || result.status !== 'success') throw internalContractError();
                const data = validateWorkerData(result.data, request);
                return { ...data, read_only: true, execution_enabled: false };
            } finally {
                activeWorkers -= 1;
            }
        },
    };
}

const defaultService = createPortfolioLabService();

module.exports = {
    createPortfolioLabService,
    normalizeRequest,
    validateWorkerData,
    analyze: defaultService.analyze,
};
