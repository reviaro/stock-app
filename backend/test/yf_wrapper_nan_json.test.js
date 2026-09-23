const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

const backendDir = path.join(__dirname, '..');
const python = path.join(backendDir, 'venv', 'bin', 'python');

function runPython(source, { input = null } = {}) {
    const opts = {
        cwd: backendDir,
        encoding: 'utf8',
    };
    if (input !== null) {
        opts.input = input;
    }
    const result = spawnSync(python, ['-c', source], opts);
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
}

test('H1 get_history with a mocked yfinance Ticker whose .history() returns a DataFrame of 3 bars where the middle bar has NaN OHLC -> result contains exactly the 2 valid bars, and the printed/serialized output parses with JavaScript JSON.parse', () => {
    const source = `
import json
import sys
import pandas as pd

sys.path.insert(0, 'python')
import yf_wrapper

class FakeTicker:
    def history(self, **kwargs):
        idx = pd.date_range('2026-09-20', periods=3, tz='America/New_York')
        return pd.DataFrame([
            {'Open': 100.0, 'High': 105.0, 'Low': 99.0, 'Close': 104.0, 'Volume': 1000},
            {'Open': float('nan'), 'High': float('nan'), 'Low': float('nan'), 'Close': float('nan'), 'Volume': 2000},
            {'Open': 104.0, 'High': 108.0, 'Low': 103.0, 'Close': 107.0, 'Volume': 1500},
        ], index=idx)

yf_wrapper.yf.Ticker = lambda _symbol: FakeTicker()
res = yf_wrapper.get_history('SPY')
print(json.dumps(res))
`;
    const parsed = runPython(source);
    assert.strictEqual(parsed.status, 'success');
    assert.strictEqual(parsed.data.data.length, 2);
    assert.strictEqual(parsed.data.data[0].open, 100);
    assert.strictEqual(parsed.data.data[1].open, 104);
});

test('H2 running main() end-to-end (stdin JSON {"action":"history","symbol":"SPY","period":"1y","interval":"1d"}) with yfinance mocked so .history() returns a frame containing a NaN bar -> stdout is valid for Node\'s JSON.parse and has status \'success\'', () => {
    const source = `
import sys
import pandas as pd

sys.path.insert(0, 'python')
import yf_wrapper

class FakeTicker:
    def history(self, **kwargs):
        idx = pd.date_range('2026-09-20', periods=3, tz='America/New_York')
        return pd.DataFrame([
            {'Open': 100.0, 'High': 105.0, 'Low': 99.0, 'Close': 104.0, 'Volume': 1000},
            {'Open': float('nan'), 'High': float('nan'), 'Low': float('nan'), 'Close': float('nan'), 'Volume': 2000},
            {'Open': 104.0, 'High': 108.0, 'Low': 103.0, 'Close': 107.0, 'Volume': 1500},
        ], index=idx)

yf_wrapper.yf.Ticker = lambda _symbol: FakeTicker()
yf_wrapper.main()
`;
    const input = JSON.stringify({ action: 'history', symbol: 'SPY', period: '1y', interval: '1d' });
    const parsed = runPython(source, { input });
    assert.strictEqual(parsed.status, 'success');
    assert.strictEqual(parsed.data.data.length, 2);
});

test('H3 the NaN-safe serializer: {"a": float(\'nan\'), "b": [1.5, float(\'inf\')], "c": numpy.float64(\'nan\'), "d": 2} -> JSON.parse gives { a: null, b: [1.5, null], c: null, d: 2 }', () => {
    const source = `
import json
import sys
import numpy as np

sys.path.insert(0, 'python')
import yf_wrapper

data = {
    'a': float('nan'),
    'b': [1.5, float('inf')],
    'c': np.float64('nan'),
    'd': 2,
}

if hasattr(yf_wrapper, '_nan_safe_dumps'):
    print(yf_wrapper._nan_safe_dumps(data))
else:
    print(json.dumps(data))
`;
    const parsed = runPython(source);
    assert.deepStrictEqual(parsed, { a: null, b: [1.5, null], c: null, d: 2 });
});

test('H4 a normal frame with no NaN -> identical bars/values to today\'s behavior (same keys, same rounding)', () => {
    const source = `
import json
import sys
import pandas as pd

sys.path.insert(0, 'python')
import yf_wrapper

class FakeTicker:
    def history(self, **kwargs):
        idx = pd.date_range('2026-09-20', periods=2, tz='America/New_York')
        return pd.DataFrame([
            {'Open': 100.126, 'High': 105.454, 'Low': 99.888, 'Close': 104.991, 'Volume': 1000},
            {'Open': 104.111, 'High': 108.222, 'Low': 103.333, 'Close': 107.444, 'Volume': 1500},
        ], index=idx)

yf_wrapper.yf.Ticker = lambda _symbol: FakeTicker()
res = yf_wrapper.get_history('SPY')
print(json.dumps(res))
`;
    const parsed = runPython(source);
    assert.strictEqual(parsed.status, 'success');
    assert.strictEqual(parsed.data.symbol, 'SPY');
    assert.strictEqual(parsed.data.data.length, 2);
    assert.deepStrictEqual(parsed.data.data[0], {
        date: '2026-09-20T00:00:00-04:00',
        open: 100.13,
        high: 105.45,
        low: 99.89,
        close: 104.99,
        volume: 1000,
    });
    assert.deepStrictEqual(parsed.data.data[1], {
        date: '2026-09-21T00:00:00-04:00',
        open: 104.11,
        high: 108.22,
        low: 103.33,
        close: 107.44,
        volume: 1500,
    });
});

test('H5 technical indicators: one partial NaN bar mid-series does not poison current RSI/MACD/EMA/SMA/ATR values', () => {
    const source = `
import sys
import pandas as pd

sys.path.insert(0, 'python')
import yf_wrapper

class FakeTicker:
    def history(self, **kwargs):
        idx = pd.date_range('2025-09-01', periods=260, tz='America/New_York')
        rows = []
        for i in range(260):
            price = 100.0 + (i % 17) - (i % 5) * 0.5 + i * 0.1
            rows.append({'Open': price - 0.5, 'High': price + 1.0, 'Low': price - 1.0, 'Close': price, 'Volume': 1000 + i})
        rows[250] = {'Open': float('nan'), 'High': float('nan'), 'Low': float('nan'), 'Close': float('nan'), 'Volume': 5000}
        return pd.DataFrame(rows, index=idx)

yf_wrapper.yf.Ticker = lambda _symbol: FakeTicker()
yf_wrapper.main()
`;
    const input = JSON.stringify({ action: 'technical', symbol: 'SPY' });
    const parsed = runPython(source, { input });
    assert.strictEqual(parsed.status, 'success');
    const current = parsed.data.current;
    for (const [label, value] of [
        ['price', current.price], ['rsi', current.rsi], ['macd.line', current.macd.line],
        ['ema.12', current.ema['12']], ['ema.26', current.ema['26']], ['sma.50', current.sma['50']],
        ['sma.200', current.sma['200']], ['atr', current.atr],
    ]) {
        assert.ok(Number.isFinite(value), `${label} must be a finite number, got ${value}`);
    }
});
