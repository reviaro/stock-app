const express = require('express');
const strategyLab = require('../services/strategy_lab');

const router = express.Router();

function sendError(res, error) {
    const status = error.statusCode || 500;
    res.status(status).json({ status: 'error', error: error.message });
}

router.get('/experiments', async (_req, res) => {
    try {
        const experiments = await strategyLab.listExperiments();
        res.json({ status: 'success', data: experiments });
    } catch (error) {
        sendError(res, error);
    }
});

router.post('/experiments', async (req, res) => {
    try {
        const experiment = await strategyLab.createExperiment(req.body || {});
        res.status(201).json({ status: 'success', data: experiment });
    } catch (error) {
        sendError(res, error);
    }
});

router.get('/experiments/:id', async (req, res) => {
    try {
        const experiment = await strategyLab.getExperiment(req.params.id);
        res.json({ status: 'success', data: experiment });
    } catch (error) {
        sendError(res, error);
    }
});

router.post('/experiments/:id/versions', async (req, res) => {
    try {
        const version = await strategyLab.addVersion(req.params.id, req.body || {});
        res.status(201).json({ status: 'success', data: version });
    } catch (error) {
        sendError(res, error);
    }
});

router.post('/versions/:id/runs', async (req, res) => {
    try {
        const run = await strategyLab.addRun(req.params.id, req.body || {});
        res.status(201).json({ status: 'success', data: run });
    } catch (error) {
        sendError(res, error);
    }
});

router.post('/versions/:id/evaluations', async (req, res) => {
    try {
        const result = await require('../services/strategy_evaluation').evaluateSession(Number(req.params.id), req.body?.simulator_run_id);
        res.status(201).json({ status: 'success', data: result });
    } catch (error) { sendError(res, error); }
});

router.get('/evaluations/:id', async (req, res) => {
    try {
        const controls = require('../services/simulator_controls');
        const row = await controls.connection((conn) => controls.get(conn, 'SELECT * FROM strategy_evaluation_artifacts WHERE id=?', [req.params.id]));
        if (!row) return res.status(404).json({ status: 'error', error: 'evaluation artifact not found' });
        res.json({ status: 'success', data: { ...row, artifact: JSON.parse(row.artifact_json), metrics: JSON.parse(row.metrics_json) } });
    } catch (error) { sendError(res, error); }
});

module.exports = router;
