const { spawn } = require('child_process');
const path = require('path');
const {
    createAsyncTtlCache,
    createBatchingStockInfoLoader,
} = require('./market_data_cache');

const PYTHON_BIN = process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python';
const PYTHON_PATH = process.env.PYTHON_PATH || path.join(__dirname, '..', 'venv', PYTHON_BIN);
const SCRIPT_PATH = path.join(__dirname, '..', 'python', 'yf_wrapper.py');

function createPythonCaller({
    spawnImpl = spawn,
    pythonPath = PYTHON_PATH,
    scriptPath = SCRIPT_PATH,
    timeoutMs = Number(process.env.PYTHON_TIMEOUT_MS) || 45_000,
    maxOutputBytes = Number(process.env.PYTHON_MAX_OUTPUT_BYTES) || 5 * 1024 * 1024,
} = {}) {
    return function callPython(request) {
        return new Promise((resolve, reject) => {
            const python = spawnImpl(pythonPath, [scriptPath], {
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            let stdout = '';
            let stderr = '';
            let outputBytes = 0;
            let settled = false;

            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                python.kill('SIGKILL');
                reject(new Error(`Python request timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            function settle(callback, value) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                callback(value);
            }

            function collect(data, target) {
                if (settled) return;
                outputBytes += Buffer.byteLength(data);
                if (outputBytes > maxOutputBytes) {
                    settled = true;
                    clearTimeout(timer);
                    python.kill('SIGKILL');
                    reject(new Error(`Python output limit exceeded (${maxOutputBytes} bytes)`));
                    return;
                }
                if (target === 'stdout') stdout += data.toString();
                else stderr += data.toString();
            }

            python.stdout.on('data', (data) => collect(data, 'stdout'));
            python.stderr.on('data', (data) => collect(data, 'stderr'));
            python.on('error', (error) => settle(reject, error));
            python.on('close', (code) => {
                if (settled) return;
                if (code !== 0) {
                    settle(reject, new Error(`Python process exited with code ${code}: ${stderr}`));
                    return;
                }
                try {
                    settle(resolve, JSON.parse(stdout));
                } catch (_error) {
                    settle(reject, new Error(`Failed to parse Python output: ${stdout.slice(0, 500)}`));
                }
            });
            python.stdin.write(JSON.stringify(request));
            python.stdin.end();
        });
    };
}

const callPython = createPythonCaller();

function createPybridge({
    callPython: runPython = callPython,
    quoteTtlMs = Number(process.env.MARKET_QUOTE_CACHE_TTL_MS || 60_000),
    staleQuoteTtlMs = Number(process.env.MARKET_QUOTE_STALE_TTL_MS || 15 * 60_000),
    batchDelayMs = Number(process.env.MARKET_QUOTE_BATCH_DELAY_MS || 15),
    marketTtlMs = Number(process.env.MARKET_SUMMARY_CACHE_TTL_MS || 60_000),
} = {}) {
    const stockInfoLoader = createBatchingStockInfoLoader({
        ttlMs: quoteTtlMs,
        staleTtlMs: staleQuoteTtlMs,
        batchDelayMs,
        fetchBatch: async (symbols) => {
            const result = await runPython({ action: 'info_batch', symbols });
            if (result?.status !== 'success' || !result.data) {
                throw new Error(result?.error || 'Batch market data request failed');
            }
            return result.data;
        },
    });
    const marketCache = createAsyncTtlCache({ ttlMs: marketTtlMs });
    const sectorCache = createAsyncTtlCache({ ttlMs: Math.max(marketTtlMs, 5 * 60_000) });

    return {
        getStockInfo(symbol) {
            return stockInfoLoader.get(symbol);
        },
        getStockHistory(symbol, period = '1y', interval = '1d') {
            return runPython({ action: 'history', symbol, period, interval });
        },
        getCANSlimAnalysis(symbol) {
            return runPython({ action: 'canslim', symbol });
        },
        getTechnicalIndicators(symbol) {
            return runPython({ action: 'technical', symbol });
        },
        getMarketIndexes() {
            return marketCache.get('indexes', () => runPython({ action: 'indexes' }));
        },
        updateUniverse() {
            return runPython({ action: 'update_universe' });
        },
        getMarketDirection() {
            return marketCache.get('direction', () => runPython({ action: 'market_direction' }));
        },
        getNews(symbol) {
            return runPython({ action: 'news', symbol });
        },
        getEarningsDate(symbol) {
            return runPython({ action: 'earnings', symbol });
        },
        getSectorPerformance() {
            return sectorCache.get('sectors', () => runPython({ action: 'sectors' }));
        },
        getQualityMetrics(symbol) {
            return runPython({ action: 'quality', symbol });
        },
        clearMarketDataCache(symbol) {
            stockInfoLoader.clear(symbol);
            marketCache.clear();
            sectorCache.clear();
        },
    };
}

const defaultBridge = createPybridge();

module.exports = {
    callPython,
    createPythonCaller,
    createPybridge,
    ...defaultBridge,
};
