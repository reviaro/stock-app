const { google } = require('@ai-sdk/google');
const { createOpenAI } = require('@ai-sdk/openai');
const { tool } = require('ai');
const { z } = require('zod');
const pybridge = require('./pybridge');
const dbModule = require('../database/db');
const { buildSummary } = require('./portfolio_ledger');
const { computeBreaches } = require('./risk_engine');
const {
    computeLotsForSymbol,
    computeTaxPreview,
    computeHoldings,
    computeCashBalance,
    computeRealizedPnl,
} = require('./simulator_ledger');

const model = google('gemini-2.5-flash-preview-04-17');
const backupModel = google('gemini-2.5-flash');

// LM Studio local fallback — OpenAI-compatible API running locally
// Set LMSTUDIO_BASE_URL in .env (default: http://localhost:1234/v1)
// Set LMSTUDIO_MODEL to match the model loaded in LM Studio
// Common values: qwen2.5-7b-instruct, qwen3-8b, llama-3.2-8b-instruct
const lmstudio = createOpenAI({
  baseURL: process.env.LMSTUDIO_BASE_URL || 'http://localhost:1234/v1',
  apiKey: 'lm-studio', // LM Studio doesn't require a real key
});
const localModel = lmstudio(process.env.LMSTUDIO_MODEL || 'qwen2.5-7b-instruct');

const tools = {
  getStockInfo: tool({
    description:
      'Fetches basic stock information including price, market cap, company name, sector, and industry for a given ticker symbol.',
    parameters: z.object({
      symbol: z.string().describe('The stock ticker symbol (e.g. AAPL, MSFT)'),
    }),
    execute: async (args) => {
      const symbol = args?.symbol;
      if (!symbol || typeof symbol !== 'string') return { error: 'Symbol parameter is required and must be a string' };
      return await pybridge.getStockInfo(symbol.toUpperCase());
    },
  }),

  getCanslimAnalysis: tool({
    description:
      'Fetches CAN SLIM scores and fundamental data for a stock symbol. Returns letter grades (A–F) for each of the 7 CAN SLIM criteria: Current Earnings, Annual Earnings, New Products/Services, Supply/Demand, Leader/Laggard, Institutional Sponsorship, and Market Direction.',
    parameters: z.object({
      symbol: z.string().describe('The stock ticker symbol (e.g. AAPL, MSFT)'),
    }),
    execute: async (args) => {
      const symbol = args?.symbol;
      if (!symbol || typeof symbol !== 'string') return { error: 'Symbol parameter is required and must be a string' };
      return await pybridge.getCANSlimAnalysis(symbol.toUpperCase());
    },
  }),

  getTechnicalIndicators: tool({
    description:
      'Fetches key technical analysis indicators for a stock symbol, including RSI, MACD, moving averages (50-day, 200-day), Bollinger Bands, and volume trends.',
    parameters: z.object({
      symbol: z.string().describe('The stock ticker symbol (e.g. AAPL, MSFT)'),
    }),
    execute: async (args) => {
      const symbol = args?.symbol;
      if (!symbol || typeof symbol !== 'string') return { error: 'Symbol parameter is required and must be a string' };
      return await pybridge.getTechnicalIndicators(symbol.toUpperCase());
    },
  }),

  getMarketDirection: tool({
    description:
      'Fetches the current overall market direction assessment based on Follow-Through Day (FTD) analysis of the Nasdaq Composite. Returns whether the market is in a confirmed uptrend or not, along with supporting evidence.',
    parameters: z.object({}),
    execute: async () => {
      return await pybridge.getMarketDirection();
    },
  }),

  getNews: tool({
    description:
      'Fetches the latest news articles for a specific stock symbol or the broader market. For general market news, use index symbols like ^GSPC (S&P 500) or SPY. Returns a list of recent article titles, publishers, links, and publish timestamps.',
    parameters: z.object({
      symbol: z.string().describe('The stock ticker symbol or index (e.g. AAPL, MSFT, ^GSPC)').optional(),
    }),
    execute: async (args) => {
      const ticker = args?.symbol && typeof args.symbol === 'string' ? args.symbol.toUpperCase() : '^GSPC';
      return await pybridge.getNews(ticker);
    },
  }),

  getMemo: tool({
    description:
      'Fetches the user\'s saved research memo for a stock, including their thesis, fair-value band, buy-below price, sell rule, invalidation criteria, risks, and conviction level. Returns null if no memo exists.',
    parameters: z.object({
      symbol: z.string().describe('The stock ticker symbol (e.g. AAPL, MSFT)'),
    }),
    execute: async (args) => {
      const symbol = args?.symbol;
      if (!symbol || typeof symbol !== 'string') return { error: 'Symbol required' };
      const memo = await dbModule.getMemo(symbol.toUpperCase());
      return memo ? { data: memo } : { data: null };
    },
  }),

  getQualityMetrics: tool({
    description:
      'Fetches Buffett-style business quality metrics for a stock, including ROIC, FCF margin, debt/equity, interest coverage, earnings consistency, gross margin stability, revenue CAGR, and a composite quality score.',
    parameters: z.object({
      symbol: z.string().describe('The stock ticker symbol (e.g. AAPL, MSFT)'),
    }),
    execute: async (args) => {
      const symbol = args?.symbol;
      if (!symbol || typeof symbol !== 'string') return { error: 'Symbol required' };
      return await pybridge.getQualityMetrics(symbol.toUpperCase());
    },
  }),

  getRiskRules: tool({
    description:
      'Fetches the current portfolio risk rules including max position size, max sector size, max risk per trade, and target cash percentage.',
    parameters: z.object({}),
    execute: async () => {
      return { status: 'success', data: await dbModule.getRiskRules() };
    },
  }),

  checkPortfolioRisk: tool({
    description:
      'Checks the current portfolio against risk rules and returns any active breaches for position size, sector concentration, risk per trade, and cash target.',
    parameters: z.object({}),
    execute: async () => {
      const [transactions, rules, stops] = await Promise.all([
        dbModule.listTransactions ? dbModule.listTransactions() : Promise.resolve([]),
        dbModule.getRiskRules ? dbModule.getRiskRules() : Promise.resolve(null),
        dbModule.listPositionStops ? dbModule.listPositionStops() : Promise.resolve([]),
      ]);

      if (!rules) return { status: 'success', data: { breaches: [] } };

      const stopBySymbol = Object.fromEntries((stops || []).map((stop) => [stop.symbol, stop.stop_loss]));
      const symbols = [...new Set(transactions.map((txn) => txn.symbol).filter(Boolean))];
      const prices = {};
      const sectors = {};

      await Promise.all(symbols.map(async (symbol) => {
        try {
          const info = await pybridge.getStockInfo(symbol);
          if (typeof info?.data?.price === 'number') prices[symbol] = info.data.price;
          sectors[symbol] = info?.data?.sector ?? null;
        } catch {
          sectors[symbol] = null;
        }
      }));

      const summary = buildSummary(transactions, prices);
      const positions = Object.entries(summary.holdings).map(([symbol, holding]) => ({
        symbol,
        shares: holding.shares,
        currentPrice: prices[symbol] ?? null,
        currentValue: prices[symbol] != null ? prices[symbol] * holding.shares : null,
        sector: sectors[symbol] ?? null,
        stop_loss: stopBySymbol[symbol] ?? null,
      }));

      return {
        status: 'success',
        data: computeBreaches({ positions, cash: summary.cash, rules }),
      };
    },
  }),

  simulator_get_account: tool({
    description: 'Fetches the paper trading simulator account: cash balance, realized P&L, and configured tax bracket. For live portfolio value and unrealized P&L, use simulator_get_holdings instead.',
    parameters: z.object({}),
    execute: async () => {
      try {
        const [account, txns] = await Promise.all([dbModule.getSimAccount(), dbModule.listSimTransactions()]);
        const cash = computeCashBalance(txns);
        const realized = computeRealizedPnl(txns).total;
        return { status: 'success', data: { ...account, cash, realized_pnl: Math.round(realized * 100) / 100 } };
      } catch (err) {
        return { error: err.message };
      }
    },
  }),

  simulator_get_holdings: tool({
    description: 'Lists all open positions in the paper trading simulator with shares, average cost, current price (live), unrealized P&L, and holding period.',
    parameters: z.object({}),
    execute: async () => {
      try {
        const txns = await dbModule.listSimTransactions();
        const holdings = computeHoldings(txns);
        const symbols = Object.keys(holdings);
        const prices = {};
        await Promise.all(symbols.map(async (s) => {
          try {
            const info = await pybridge.getStockInfo(s);
            if (typeof info?.data?.price === 'number') prices[s] = info.data.price;
          } catch { /* non-fatal */ }
        }));
        const result = symbols.map((s) => {
          const h = holdings[s];
          const price = prices[s] ?? null;
          const pnl = price != null ? price * h.shares - h.total_cost : null;
          const lots = computeLotsForSymbol(txns, s);
          return { symbol: s, shares: h.shares, avg_cost: h.avg_cost, currentPrice: price, pnl, oldest_lot_date: lots[0]?.txn_date ?? null };
        });
        return { status: 'success', data: result };
      } catch (err) {
        return { error: err.message };
      }
    },
  }),

  simulator_buy: tool({
    description: 'Places a simulated buy order in the paper trading simulator. Deducts cash and records the trade. Price is fetched live from the market.',
    parameters: z.object({
      symbol: z.string().describe('Ticker symbol (e.g. AAPL)'),
      shares: z.number().describe('Number of shares to buy'),
    }),
    execute: async ({ symbol, shares }) => {
      try {
        const info = await pybridge.getStockInfo(symbol);
        const price = info?.data?.price;
        if (typeof price !== 'number' || !isFinite(price)) {
          return { error: 'price unavailable for ' + symbol };
        }
        const txns = await dbModule.listSimTransactions();
        const cash = computeCashBalance(txns);
        const cost = shares * price;
        if (cash < cost) {
          return { error: `insufficient cash: have $${Math.round(cash * 100) / 100}, need $${Math.round(cost * 100) / 100}` };
        }
        const result = await dbModule.addSimTransaction({
          type: 'buy', symbol, shares, price,
          txn_date: new Date().toISOString().slice(0, 10),
        });
        return { status: 'success', data: result };
      } catch (err) {
        return { error: err.message };
      }
    },
  }),

  simulator_sell: tool({
    description: 'Places a simulated sell order in the paper trading simulator. Credits cash and records the trade. Price is fetched live from the market.',
    parameters: z.object({
      symbol: z.string().describe('Ticker symbol (e.g. AAPL)'),
      shares: z.number().describe('Number of shares to sell'),
    }),
    execute: async ({ symbol, shares }) => {
      try {
        const info = await pybridge.getStockInfo(symbol);
        const price = info?.data?.price;
        if (typeof price !== 'number' || !isFinite(price)) {
          return { error: 'price unavailable for ' + symbol };
        }
        const txns = await dbModule.listSimTransactions();
        const holdings = computeHoldings(txns);
        const owned = holdings[symbol.toUpperCase()]?.shares ?? 0;
        if (shares > owned + 0.000001) {
          return { error: `insufficient shares: own ${owned}, tried to sell ${shares}` };
        }
        const result = await dbModule.addSimTransaction({
          type: 'sell', symbol, shares, price,
          txn_date: new Date().toISOString().slice(0, 10),
        });
        return { status: 'success', data: result };
      } catch (err) {
        return { error: err.message };
      }
    },
  }),

  simulator_tax_preview: tool({
    description: 'Returns a detailed tax breakdown for selling a given number of shares in the simulator: proceeds, cost basis, gross gain, ST/LT split, total tax owed, after-tax net gain, and whether it is worth selling. Uses FIFO lot matching and the account\'s configured US tax bracket. Price is fetched live from the market.',
    parameters: z.object({
      symbol: z.string().describe('Ticker symbol'),
      shares: z.number().describe('Shares to sell'),
    }),
    execute: async ({ symbol, shares }) => {
      try {
        const info = await pybridge.getStockInfo(symbol);
        const price = info?.data?.price;
        if (typeof price !== 'number' || !isFinite(price)) {
          return { error: 'price unavailable for ' + symbol };
        }
        const [txns, account] = await Promise.all([dbModule.listSimTransactions(), dbModule.getSimAccount()]);
        const lots = computeLotsForSymbol(txns, symbol);
        if (lots.length === 0) return { error: `no open position in ${symbol}` };
        const preview = computeTaxPreview({
          lots, sharesToSell: shares, currentPrice: price,
          taxBracket: account.tax_bracket,
          sellDate: new Date().toISOString().slice(0, 10),
        });
        return { status: 'success', data: { symbol, shares, current_price: price, ...preview } };
      } catch (err) {
        return { error: err.message };
      }
    },
  }),

  simulator_get_transactions: tool({
    description: 'Returns the full trade history for the paper trading simulator: all buys, sells, deposits, and withdrawals.',
    parameters: z.object({}),
    execute: async () => {
      try {
        const txns = await dbModule.listSimTransactions();
        return { status: 'success', data: txns.reverse() };
      } catch (err) {
        return { error: err.message };
      }
    },
  }),

  simulator_deposit: tool({
    description: 'Adds cash to the paper trading simulator account.',
    parameters: z.object({
      amount: z.number().describe('Dollar amount to deposit'),
    }),
    execute: async ({ amount }) => {
      try {
        if (amount <= 0) return { error: 'amount must be positive' };
        await dbModule.addSimTransaction({
          type: 'deposit', amount,
          txn_date: new Date().toISOString().slice(0, 10),
        });
        const txns = await dbModule.listSimTransactions();
        return { status: 'success', data: { cash: computeCashBalance(txns) } };
      } catch (err) {
        return { error: err.message };
      }
    },
  }),

  simulator_reset: tool({
    description: 'Wipes all transactions in the paper trading simulator, resetting cash to $0. Use with caution.',
    parameters: z.object({}),
    execute: async () => {
      try {
        const result = await dbModule.deleteAllSimTransactions();
        return { status: 'success', data: result };
      } catch (err) {
        return { error: err.message };
      }
    },
  }),
};

// chatTools is what the AI is allowed to call during chat.
// getCanslimAnalysis is excluded: the CANSLIM scorecard already lives in the main dashboard.
const chatTools = {
  getStockInfo: tools.getStockInfo,
  getTechnicalIndicators: tools.getTechnicalIndicators,
  getMarketDirection: tools.getMarketDirection,
  getNews: tools.getNews,
  getMemo: tools.getMemo,
  getQualityMetrics: tools.getQualityMetrics,
  getRiskRules: tools.getRiskRules,
  checkPortfolioRisk: tools.checkPortfolioRisk,
  simulator_get_account: tools.simulator_get_account,
  simulator_get_holdings: tools.simulator_get_holdings,
  simulator_buy: tools.simulator_buy,
  simulator_sell: tools.simulator_sell,
  simulator_tax_preview: tools.simulator_tax_preview,
  simulator_get_transactions: tools.simulator_get_transactions,
  simulator_deposit: tools.simulator_deposit,
  simulator_reset: tools.simulator_reset,
};

const memoPrompts = {
  draftSystem: `You are a disciplined value investor helping the user write a research memo for a single stock. You will be given the stock's basic info, technicals, and recent news. Respond with a JSON object matching this shape exactly (no prose, no code fences):
{
  "thesis": "<2–4 sentence business thesis>",
  "fair_value_low": <number|null>,
  "fair_value_high": <number|null>,
  "buy_below": <number|null>,
  "sell_rule": "<string>",
  "invalidation": "<string>",
  "risks": "<bulleted markdown list of top 3–5 risks>",
  "conviction": <1–5>
}
Fields you cannot justify from the data MUST be null (numbers) or empty string (strings). Do not invent numbers.`,

  pressureTestSystem: `You are a skeptical bear who will pressure-test the user's investment thesis. You will receive the user's current memo and the latest stock info/news. Write a focused bear case with 3–5 specific, falsifiable risks that would invalidate the thesis, and 2–3 conditions under which you would become bullish. Output as markdown only. Do not hedge with "on the other hand".`,
};

module.exports = { model, backupModel, localModel, tools, chatTools, memoPrompts };
