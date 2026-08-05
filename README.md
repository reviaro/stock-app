# Stock Dashboard

A personal stock research and portfolio management app: a market dashboard, a
transaction-ledger portfolio, an AI analyst, and a paper-trading simulator —
built with Express + SQLite on the backend, React + Vite on the frontend, and a
small Python bridge to yfinance for market data.

## Features

- **Market dashboard** — market pulse, sector rotation, stock charts, CANSLIM
  scorecard, quality scorecard (moat/health metrics), daily price history
  snapshots with range filtering, and a glossary.
- **Watchlist with buckets** — compounders / buy soon / expensive / speculative /
  owned / unsorted, with automatic bucket flips as you buy and sell.
- **Portfolio ledger** — every buy, sell, dividend, deposit, and withdrawal is a
  transaction row; cost basis (weighted average), cash, and realized/unrealized
  P&L are derived from the ledger, never stored.
- **Risk rails** — configurable position/sector/cash limits and per-symbol stop
  losses, with breach chips surfaced in the portfolio panel.
- **Research journal** — per-stock memos (thesis, fair value range, buy/trim
  levels, invalidation, conviction) plus structured research notes, with AI
  draft and bear-case pressure-test helpers.
- **Value screener** — scores candidates on quality vs. valuation.
- **AI analyst** — chat agent with tool access to live quotes, technicals,
  news, quality metrics, risk checks, and the simulator; plus five one-shot
  analyst modes (decision memo, bear case, compare, weekly review, monthly
  review). Gemini primary with LM Studio local fallback.
- **Paper-trading simulator** — two isolated sleeves (Long-Term Investing and
  Day Trading), each with its own cash, holdings, trade history, FIFO tax
  preview (short/long-term split by your bracket), performance review, and CSV
  export. The AI agent can trade in either sleeve via `account_id`.

## Architecture

```
frontend/   React 18 + TypeScript + Vite + Tailwind + React Query (port 5173, proxies /api → 3002)
backend/    Express (port 3002) + SQLite (backend/database/stocks.db) + node:test
  python/   yf_wrapper.py — yfinance quotes/quality/news via a venv (pybridge spawns it)
docs/       dated plans and progress handoffs
HANDOFF.md  current repo status for the next session
```

The backend also serves `frontend/dist`, so a production build runs entirely
from port 3002.

## Setup

### Backend

```bash
cd backend
npm install
python3 -m venv venv && venv/bin/pip install yfinance pandas beautifulsoup4
cp .env.example .env   # or create .env — see below
node server.js         # http://localhost:3002
```

`.env` keys:

| Key | Purpose |
|-----|---------|
| `GOOGLE_GENERATIVE_AI_API_KEY` | Gemini for the AI analyst (read automatically by `@ai-sdk/google`) |
| `LMSTUDIO_BASE_URL` | Optional local-model fallback (default `http://localhost:1234/v1`) |
| `LMSTUDIO_MODEL` | Model name as shown in LM Studio's server tab |
| `PYTHON_PATH` | Optional override for the venv python used by pybridge |
| `DB_PATH_OVERRIDE` | Tests only — point db.js at a scratch database |
| `ENABLE_LEDGER_MIGRATION` | One-time portfolio→ledger migration gate. Already run on the live DB — do not set again. |

### Frontend

```bash
cd frontend
npm install
npm run dev     # http://localhost:5173 (proxies /api to 3002)
npm run build   # emits frontend/dist, served by the backend
```

## Tests

```bash
cd backend && npm test        # node --test — routes, ledger, tax math, migration, AI simulator tools
cd frontend && npm test       # vitest + testing-library
cd frontend && npx tsc -b     # type check
```

Backend tests stub the Python bridge and run against throwaway SQLite files, so
they need no network and never touch `stocks.db`.

## Notes

- The simulator's two sleeves live in `simulator_sleeves`; all simulator API
  routes and AI tools accept `account_id` (1 = long-term, default; 2 = day
  trading).
- Tax preview uses FIFO lot matching and your configured US bracket; long-term
  rates apply to lots held ≥ 365 days.
- `stocks.db` is live personal data — the `*.backup.*` files beside it are
  pre-migration safety copies, not fixtures.
