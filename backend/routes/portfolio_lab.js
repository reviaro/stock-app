const express = require('express');
const portfolioLab = require('../services/portfolio_lab');

function createPortfolioLabRouter({ analyze = portfolioLab.analyze } = {}) {
    const router = express.Router();
    router.post('/analyze', async (req, res) => {
        try {
            const result = await analyze(req.body || {});
            res.json({ status: 'success', data: result });
        } catch (error) {
            const statusCode = Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode <= 599
                ? error.statusCode
                : 500;
            res.status(statusCode).json({
                status: 'error',
                error: statusCode < 500
                    ? (error.message || 'Portfolio Lab request failed')
                    : 'Portfolio Lab analysis failed',
            });
        }
    });
    return router;
}

module.exports = createPortfolioLabRouter();
module.exports.createPortfolioLabRouter = createPortfolioLabRouter;
