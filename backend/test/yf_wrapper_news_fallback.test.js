const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

const backendDir = path.join(__dirname, '..');
const python = path.join(backendDir, 'venv', 'bin', 'python');

// Runs get_news against a fake yfinance (no network) and returns the parsed result.
function newsWith({ tickerNews, searchNews, symbol }) {
    const source = `
import json
import sys

sys.path.insert(0, 'python')
import yf_wrapper

TICKER_NEWS = json.loads(${JSON.stringify(JSON.stringify(tickerNews))})
SEARCH_NEWS = json.loads(${JSON.stringify(JSON.stringify(searchNews))})
calls = {'search': 0}

class FakeTicker:
    @property
    def news(self):
        if TICKER_NEWS == 'raise':
            raise Exception('*** YAHOO! FINANCE IS CURRENTLY DOWN! ***')
        return TICKER_NEWS

class FakeSearch:
    def __init__(self, query, **kwargs):
        calls['search'] += 1
        if SEARCH_NEWS == 'raise':
            raise Exception('search unavailable')
        self.news = SEARCH_NEWS

yf_wrapper.yf.Ticker = lambda _symbol: FakeTicker()
yf_wrapper.yf.Search = FakeSearch
result = yf_wrapper.get_news(${JSON.stringify(symbol)})
print(json.dumps({'result': result, 'searchCalls': calls['search']}))
`;
    const run = spawnSync(python, ['-c', source], { cwd: backendDir, encoding: 'utf8' });
    assert.strictEqual(run.status, 0, run.stderr || run.stdout);
    return JSON.parse(run.stdout);
}

const searchItem = (title, relatedTickers, t = 1793931738) => ({
    title, publisher: 'Pub', link: 'https://example.com/' + encodeURIComponent(title), providerPublishTime: t, relatedTickers,
});

test('N1 Ticker.news failing falls back to Yahoo search news, keeping only items tagged with the symbol', () => {
    const { result } = newsWith({
        symbol: 'ADBE',
        tickerNews: 'raise',
        searchNews: [searchItem('Adobe story', ['ADBE', 'C']), searchItem('Unrelated story', ['XOM']), searchItem('Untagged story', null)],
    });
    assert.strictEqual(result.status, 'success');
    assert.deepStrictEqual(result.data.map((n) => n.title), ['Adobe story', 'Untagged story']);
    assert.strictEqual(result.data[0].providerPublishTime, 1793931738);
    assert.strictEqual(result.meta.endpoint, 'search');
    assert.match(result.meta.tickerNewsError, /CURRENTLY DOWN/);
});

test('N2 share-class alias: GOOGL keeps news Yahoo tagged as GOOG', () => {
    const { result } = newsWith({
        symbol: 'GOOGL',
        tickerNews: 'raise',
        searchNews: [searchItem('Alphabet story', ['GOOG', 'MSFT']), searchItem('Other', ['AAPL'])],
    });
    assert.deepStrictEqual(result.data.map((n) => n.title), ['Alphabet story']);
});

test('N3 working Ticker.news is used as before and search is not called', () => {
    const { result, searchCalls } = newsWith({
        symbol: 'ADBE',
        tickerNews: [{ content: { title: 'Ticker story', pubDate: '2026-11-06T10:00:00Z', provider: { displayName: 'Reuters' }, canonicalUrl: { url: 'https://example.com/t' } } }],
        searchNews: 'raise',
    });
    assert.strictEqual(searchCalls, 0);
    assert.strictEqual(result.meta.endpoint, 'ticker_news');
    assert.deepStrictEqual(result.data, [{ title: 'Ticker story', publisher: 'Reuters', link: 'https://example.com/t', providerPublishTime: '2026-11-06T10:00:00Z' }]);
});

test('N4 both endpoints failing stays an error (the research packet keeps its news blocker)', () => {
    const { result } = newsWith({ symbol: 'ADBE', tickerNews: 'raise', searchNews: 'raise' });
    assert.strictEqual(result.status, 'error');
    assert.match(result.error, /search unavailable/);
});
