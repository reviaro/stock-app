const { createAsyncRouter } = require('../services/http_errors');
const pybridge = require('../services/pybridge');

const router = createAsyncRouter();

router.get('/:symbol', async (req, res) => {
    try {
        const result = await pybridge.getQualityMetrics(req.params.symbol.toUpperCase());
        if (result.status !== 'success') {
            return res.status(404).json({ status: 'error', error: result.error || 'Quality metrics not found' });
        }
        res.json(result);
    } catch (err) {
        throw err;
    }
});

module.exports = router;
