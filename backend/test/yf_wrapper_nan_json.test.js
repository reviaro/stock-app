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

test('H6 _normalize_bars requires finite values in all four OHLC columns and normalizes invalid volume to 0', () => {
    const source = `
import json
import sys
import numpy as np
import pandas as pd

sys.path.insert(0, 'python')
import yf_wrapper

idx = pd.date_range('2026-09-20', periods=5, tz='America/New_York')
frame = pd.DataFrame([
    {'Open': 100.0, 'High': 101.0, 'Low': 99.0, 'Close': 100.5, 'Volume': 1000},
    {'Open': float('inf'), 'High': 101.0, 'Low': 99.0, 'Close': 100.5, 'Volume': 1000},
    {'Open': 100.0, 'High': 101.0, 'Low': -float('inf'), 'Close': 100.5, 'Volume': 1000},
    {'Open': 100.0, 'High': 101.0, 'Low': 99.0, 'Close': 100.5, 'Volume': float('nan')},
    {'Open': 100.0, 'High': 101.0, 'Low': 99.0, 'Close': 100.5, 'Volume': float('inf')},
], index=idx)
bars = yf_wrapper._normalize_bars(frame)
missing = yf_wrapper._normalize_bars(frame.drop(columns=['Low']))
print(json.dumps({
    'rows': len(bars),
    'volumes': [int(v) for v in bars['Volume']],
    'missing_rows': len(missing),
}))
`;
    const parsed = runPython(source);
    assert.deepStrictEqual(parsed, { rows: 3, volumes: [1000, 0, 0], missing_rows: 0 });
});

test('H7 stock info and market indexes survive a latest bar with valid OHLC but NaN/infinite volume', () => {
    const source = `
import sys
import pandas as pd

sys.path.insert(0, 'python')
import yf_wrapper

class FakeTicker:
    info = {'shortName': 'Test', 'longName': 'Test'}
    def history(self, **kwargs):
        idx = pd.date_range('2026-09-18', periods=3, tz='America/New_York')
        return pd.DataFrame([
            {'Open': 100.0, 'High': 101.0, 'Low': 99.0, 'Close': 100.0, 'Volume': 1000},
            {'Open': 100.0, 'High': 102.0, 'Low': 99.5, 'Close': 101.0, 'Volume': float('inf')},
            {'Open': 101.0, 'High': 103.0, 'Low': 100.0, 'Close': 102.0, 'Volume': float('nan')},
        ], index=idx)

yf_wrapper.yf.Ticker = lambda _symbol: FakeTicker()
yf_wrapper.main()
`;
    const info = runPython(source, { input: JSON.stringify({ action: 'info', symbol: 'SPY' }) });
    assert.strictEqual(info.status, 'success');
    assert.strictEqual(info.data.price, 102);
    const indexes = runPython(source, { input: JSON.stringify({ action: 'indexes' }) });
    assert.strictEqual(indexes.status, 'success');
    for (const entry of Object.values(indexes.data)) {
        assert.strictEqual(entry.error, undefined, `index ${entry.symbol} must not error: ${entry.error}`);
        assert.strictEqual(entry.price, 102);
        assert.strictEqual(entry.volume, 0);
    }
});

test('H8 market direction and sector performance ignore a latest non-finite Yahoo bar', () => {
    const source = `
import sys
import pandas as pd

sys.path.insert(0, 'python')
import yf_wrapper

idx = pd.date_range('2026-06-01', periods=70, tz='America/New_York')
closes = [100.0] * 70
closes[50] = 110.0
closes[51] = 100.0
closes[52] = 101.0
closes[53] = 100.5
closes[54] = 100.8
closes[55] = 102.5
for i in range(56, 69):
    closes[i] = 102.0
closes[69] = float('inf')
rows = []
for i, close in enumerate(closes):
    rows.append({
        'Open': close - 0.5,
        'High': close + 1.0,
        'Low': close - 1.0,
        'Close': close,
        'Volume': 2000 if i == 55 else 1000,
    })
frame = pd.DataFrame(rows, index=idx)

class FakeTicker:
    def history(self, **kwargs):
        return frame.copy()

yf_wrapper.yf.Ticker = lambda _symbol: FakeTicker()
direction = yf_wrapper.detect_market_direction()
sectors = yf_wrapper.get_sector_performance()
print(yf_wrapper._nan_safe_dumps({'direction': direction, 'sectors': sectors}))
`;
    const parsed = runPython(source);
    assert.strictEqual(parsed.direction.status, 'Confirmed Uptrend');
    assert.strictEqual(parsed.direction.ftd_detected, true);
    assert.strictEqual(parsed.sectors.status, 'success');
    assert.strictEqual(parsed.sectors.data.length, 11);
    for (const row of parsed.sectors.data) {
        assert.ok(Number.isFinite(row.price), `${row.ticker} price must be finite`);
        assert.ok(Number.isFinite(row.change1M), `${row.ticker} 1M return must be finite`);
        assert.ok(Number.isFinite(row.change3M), `${row.ticker} 3M return must be finite`);
        assert.ok(Number.isFinite(row.change6M), `${row.ticker} 6M return must be finite`);
    }
});

test('H9 universe updater drops non-finite bars before storing weighted performance', () => {
    const source = `
import json
import sys
import math
import contextlib
import pandas as pd

sys.path.insert(0, 'python')
import universe_updater

idx = pd.date_range('2025-09-01', periods=260, tz='America/New_York')
rows = []
for i in range(260):
    close = 100.0 + i * 0.1
    rows.append({'Open': close - 0.5, 'High': close + 1.0, 'Low': close - 1.0, 'Close': close, 'Volume': 1000 + i})
rows[-1] = {'Open': float('inf'), 'High': float('inf'), 'Low': float('inf'), 'Close': float('inf'), 'Volume': float('inf')}
frame = pd.DataFrame(rows, index=idx)

class FakeTicker:
    def history(self, **kwargs):
        return frame.copy()

class FakeCursor:
    def __init__(self):
        self.writes = []
    def execute(self, sql, params):
        self.writes.append(params)

class FakeConnection:
    def __init__(self):
        self.cursor_obj = FakeCursor()
    def cursor(self):
        return self.cursor_obj
    def commit(self):
        pass
    def close(self):
        pass

connection = FakeConnection()
universe_updater.SP500_TOP100 = ['TEST']
universe_updater.yf.Ticker = lambda _symbol: FakeTicker()
universe_updater.sqlite3.connect = lambda _path: connection
universe_updater.time.sleep = lambda _seconds: None
with contextlib.redirect_stdout(sys.stderr):
    universe_updater.update_universe_cache()
score = connection.cursor_obj.writes[0][1] if connection.cursor_obj.writes else None
print(json.dumps({
    'write_count': len(connection.cursor_obj.writes),
    'symbol': connection.cursor_obj.writes[0][0] if connection.cursor_obj.writes else None,
    'score_is_finite': score is not None and math.isfinite(score),
}))
`;
    const parsed = runPython(source);
    assert.strictEqual(parsed.write_count, 1);
    assert.strictEqual(parsed.symbol, 'TEST');
    assert.strictEqual(parsed.score_is_finite, true);
});

test('H10 universe updater never stores an overflowed weighted score from extreme but finite prices', () => {
    const source = `
import json
import sys
import contextlib
import pandas as pd

sys.path.insert(0, 'python')
import universe_updater

idx = pd.date_range('2025-09-01', periods=260, tz='America/New_York')
rows = []
for i in range(260):
    close = 1e-308
    rows.append({'Open': close, 'High': close, 'Low': close, 'Close': close, 'Volume': 1000})
rows[-1] = {'Open': 1e308, 'High': 1e308, 'Low': 1e308, 'Close': 1e308, 'Volume': 1000}
frame = pd.DataFrame(rows, index=idx)

class FakeTicker:
    def history(self, **kwargs):
        return frame.copy()

class FakeCursor:
    def __init__(self):
        self.writes = []
    def execute(self, sql, params):
        self.writes.append(params)

class FakeConnection:
    def __init__(self):
        self.cursor_obj = FakeCursor()
    def cursor(self):
        return self.cursor_obj
    def commit(self):
        pass
    def close(self):
        pass

connection = FakeConnection()
universe_updater.SP500_TOP100 = ['TEST']
universe_updater.yf.Ticker = lambda _symbol: FakeTicker()
universe_updater.sqlite3.connect = lambda _path: connection
universe_updater.time.sleep = lambda _seconds: None
with contextlib.redirect_stdout(sys.stderr):
    universe_updater.update_universe_cache()
print(json.dumps({'write_count': len(connection.cursor_obj.writes)}))
`;
    const parsed = runPython(source);
    assert.strictEqual(parsed.write_count, 0);
});

test('H11 update_universe main action keeps progress logs off stdout and returns one strict JSON document', () => {
    const source = `
import sys
import pandas as pd

sys.path.insert(0, 'python')
import universe_updater
import yf_wrapper

idx = pd.date_range('2025-09-01', periods=260, tz='America/New_York')
rows = []
for i in range(260):
    close = 100.0 + i * 0.1
    rows.append({'Open': close - 0.5, 'High': close + 1.0, 'Low': close - 1.0, 'Close': close, 'Volume': 1000 + i})
frame = pd.DataFrame(rows, index=idx)

class FakeTicker:
    def history(self, **kwargs):
        return frame.copy()

class FakeCursor:
    def __init__(self):
        self.writes = []
    def execute(self, sql, params):
        self.writes.append(params)

class FakeConnection:
    def __init__(self):
        self.cursor_obj = FakeCursor()
    def cursor(self):
        return self.cursor_obj
    def commit(self):
        pass
    def close(self):
        pass

connection = FakeConnection()
universe_updater.SP500_TOP100 = ['TEST']
universe_updater.yf.Ticker = lambda _symbol: FakeTicker()
universe_updater.sqlite3.connect = lambda _path: connection
universe_updater.time.sleep = lambda _seconds: None
yf_wrapper.main()
`;
    const parsed = runPython(source, { input: JSON.stringify({ action: 'update_universe' }) });
    assert.deepStrictEqual(parsed, { status: 'success', message: 'Universe cache updated' });
});
