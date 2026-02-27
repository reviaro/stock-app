const { google } = require('@ai-sdk/google');
const { groq } = require('@ai-sdk/groq');
const { tool } = require('ai');
const { z } = require('zod');
const pybridge = require('./pybridge');
const model = google('gemini-3-flash-preview');
const backupModel = google('gemini-2.5-flash');
const fallbackModel = groq('llama-3.3-70b-versatile');

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
      'Fetches the current overall market direction assessment based on Follow-Through Day (FTD) analysis of the Nasdaq Composite. Returns whether the market is in a confirmed uptrend, under pressure, or in a correction, along with supporting evidence.',
    parameters: z.object({}),
    execute: async () => {
      return await pybridge.getMarketDirection();
    },
  }),

  getNews: tool({
    description:
      'Fetches the latest news articles for a specific stock symbol or the broader market. For general market news, try using index symbols like ^GSPC (S&P 500) or SPY. Returns a list of recent article titles, publishers, links, and publish timestamps.',
    parameters: z.object({
      symbol: z.string().describe('The stock ticker symbol or index (e.g. AAPL, MSFT, ^GSPC)').optional(),
    }),
    execute: async (args) => {
      const ticker = args?.symbol && typeof args.symbol === 'string' ? args.symbol.toUpperCase() : '^GSPC';
      return await pybridge.getNews(ticker);
    },
  }),
};

module.exports = { model, backupModel, fallbackModel, tools };
