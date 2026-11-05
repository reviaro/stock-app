const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createV2Execution } = require('../services/alpaca_day_trade_v2_execution');

test('retired preview cannot be restored through a legacy execution policy', async () => {
    const dependency = new Proxy({}, { get() { throw new Error('unexpected dependency access'); } });
    const execution = createV2Execution({ store: dependency, client: dependency, policy: { enabled: true } });
    for (const input of [undefined, {}, { account_id: 2, qty: 100, symbol: 'NVDA' }]) {
        await assert.rejects(execution.previewEntry(input), { code: 'ALPACA_DAY_TRADING_RETIRED' });
    }
});
