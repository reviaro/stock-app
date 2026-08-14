const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

const backendDir = path.join(__dirname, '..');
const python = path.join(backendDir, 'venv', 'bin', 'python');

function runPython(source) {
    const result = spawnSync(python, ['-c', source], {
        cwd: backendDir,
        encoding: 'utf8',
    });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
}

test('stock info exposes source quote time and market state for stale-data monitoring', () => {
    const result = runPython(`
import json
import pandas as pd
import sys
sys.path.insert(0, 'python')
import yf_wrapper

class FakeTicker:
    info = {
        'shortName': 'Example',
        'regularMarketTime': 1786464000,
        'marketState': 'REGULAR',
    }
    def history(self, **kwargs):
        return pd.DataFrame([{
            'Open': 99.0, 'High': 102.0, 'Low': 98.0,
            'Close': 101.0, 'Volume': 1000,
        }])

yf_wrapper.yf.Ticker = lambda _symbol: FakeTicker()
print(json.dumps(yf_wrapper.get_stock_info('XYZ')))
`);
    assert.strictEqual(result.data.marketState, 'REGULAR');
    assert.match(result.data.timestamp, /^\d{4}-\d{2}-\d{2}T/);
    assert.strictEqual(result.data.isDemo, false);
});

test('demo quote fallback is explicitly labeled and has no trustworthy timestamp', () => {
    const result = runPython(`
import json
import sys
sys.path.insert(0, 'python')
import yf_wrapper
print(json.dumps(yf_wrapper.get_demo_data('AAPL')))
`);
    assert.strictEqual(result.data.isDemo, true);
    assert.strictEqual(result.data.timestamp, null);
    assert.strictEqual(result.data.marketState, 'UNKNOWN');
});
