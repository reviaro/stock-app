'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createResearchMonitorRouter } = require('../routes/research_monitor');
const { authorizeApiRequest } = require('../services/api_capabilities');
let server, origin, writes = 0;
before(async () => {
    const app = express(); app.use(express.json());
    app.use((req, res, next) => { const role = req.get('X-Test-Role') || 'reader'; req.auth = { role, type: role === 'operator' ? 'session' : 'bearer' }; next(); });
    app.use('/api', authorizeApiRequest);
    const mutation = async () => { writes++; return {}; };
    app.use('/api/research/monitor', createResearchMonitorRouter({ service: { overview: async q => ({ events: [], ...q }), earnings: async () => ({}),
        check: mutation, importMemo: mutation, store: { saveRule: mutation, review: mutation, changeRule: mutation } } }));
    server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); origin = `http://127.0.0.1:${server.address().port}/api/research/monitor`;
});
after(() => new Promise(resolve => server.close(resolve)));
const request = (path, role = 'reader', body) => fetch(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Test-Role': role, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
test('scoped agents can read monitor evidence but only the operator can change alerts or review state', async () => {
    for (const role of ['reader', 'simulator-agent', 'alpaca-long-term-agent', 'alpaca-paper-investing-agent']) {
        assert.equal((await request('/', role)).status, 200);
        for (const path of ['/check', '/reviewed', '/alerts', '/alerts/import-memo', '/alerts/a/reset']) assert.equal((await request(path, role, {})).status, 403);
    }
    assert.equal(writes, 0);
    assert.equal((await request('/alerts', 'operator', {})).status, 200); assert.equal(writes, 1);
});
test('invalid inbox filters fail before service access', async () => {
    for (const query of ['?symbol[]=TEST', '?kind=unknown', '?before=-1', '?before=Infinity']) assert.equal((await request(query)).status, 400);
});
