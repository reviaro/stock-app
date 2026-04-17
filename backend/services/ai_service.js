const { google } = require('@ai-sdk/google');
const { createOpenAI } = require('@ai-sdk/openai');
const { tool } = require('ai');
const { z } = require('zod');
const pybridge = require('./pybridge');
const dbModule = require('../database/db');

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
};

// chatTools is what the AI is allowed to call during chat.
// getCanslimAnalysis is excluded: the CANSLIM scorecard already lives in the main dashboard.
const chatTools = {
  getStockInfo: tools.getStockInfo,
  getTechnicalIndicators: tools.getTechnicalIndicators,
  getMarketDirection: tools.getMarketDirection,
  getNews: tools.getNews,
  getMemo: tools.getMemo,
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
