const express = require('express');
const router = express.Router();
const db = require('../database/db');

// GET /api/memos — list all memos
router.get('/', async (req, res) => {
  try {
    const data = await db.listMemos();
    res.json({ status: 'success', data });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// GET /api/memos/:symbol — single memo or 404
router.get('/:symbol', async (req, res) => {
  try {
    const memo = await db.getMemo(req.params.symbol);
    if (!memo) return res.status(404).json({ status: 'error', error: 'not found' });
    res.json({ status: 'success', data: memo });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// PUT /api/memos/:symbol — upsert
router.put('/:symbol', async (req, res) => {
  try {
    const result = await db.upsertMemo(req.params.symbol, req.body || {});
    res.json({ status: 'success', data: result });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// POST /api/memos/:symbol/reviewed — bump last_reviewed_at
router.post('/:symbol/reviewed', async (req, res) => {
  try {
    const result = await db.markMemoReviewed(req.params.symbol);
    res.json({ status: 'success', data: result });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// DELETE /api/memos/:symbol
router.delete('/:symbol', async (req, res) => {
  try {
    const result = await db.deleteMemo(req.params.symbol);
    res.json({ status: 'success', data: result });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

module.exports = router;