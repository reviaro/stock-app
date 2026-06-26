const express = require('express');
const pybridge = require('../services/pybridge');

const router = express.Router();

router.get('/:symbol', async (req, res) => {
    try {
        const result = await pybridge.getQualityMetrics(req.params.symbol.toUpperCase());
        if (result.status !== 'success') {
            return res.status(404).json({ status: 'error', error: result.error || 'Quality metrics not found' });
        }
        res.json(result);
    } catch (err) {
        res.status(500).json({ status: 'error', error: err.message });
    }
});

module.exports = router;
