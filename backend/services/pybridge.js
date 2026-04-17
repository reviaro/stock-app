const { spawn } = require('child_process');
const path = require('path');

const PYTHON_BIN = process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python';
const PYTHON_PATH = process.env.PYTHON_PATH || path.join(__dirname, '..', 'venv', PYTHON_BIN);
const SCRIPT_PATH = path.join(__dirname, '..', 'python', 'yf_wrapper.py');

function callPython(request) {
    return new Promise((resolve, reject) => {
        const python = spawn(PYTHON_PATH, [SCRIPT_PATH], {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';

        python.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        python.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        python.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`Python process exited with code ${code}: ${stderr}`));
            } else {
                try {
                    const result = JSON.parse(stdout);
                    resolve(result);
                } catch (e) {
                    reject(new Error(`Failed to parse Python output: ${stdout}`));
                }
            }
        });

        // Write request to stdin
        python.stdin.write(JSON.stringify(request));
        python.stdin.end();
    });
}

async function getStockInfo(symbol) {
    return callPython({ action: 'info', symbol });
}

async function getStockHistory(symbol, period = '1y', interval = '1d') {
    return callPython({ action: 'history', symbol, period, interval });
}

async function getCANSlimAnalysis(symbol) {
    return callPython({ action: 'canslim', symbol });
}

async function getTechnicalIndicators(symbol) {
    return callPython({ action: 'technical', symbol });
}

async function getMarketIndexes() {
    return callPython({ action: 'indexes' });
}

async function updateUniverse() {
    return callPython({ action: 'update_universe' });
}

async function getMarketDirection() {
    return callPython({ action: 'market_direction' });
}

async function getNews(symbol) {
    return callPython({ action: 'news', symbol });
}

async function getEarningsDate(symbol) {
    return callPython({ action: 'earnings', symbol });
}

async function getSectorPerformance() {
    return callPython({ action: 'sectors' });
}

module.exports = {
    callPython,
    getStockInfo,
    getStockHistory,
    getCANSlimAnalysis,
    getTechnicalIndicators,
    getMarketIndexes,
    updateUniverse,
    getMarketDirection,
    getNews,
    getEarningsDate,
    getSectorPerformance,
};
