const express = require('express');
const { streamText, convertToModelMessages } = require('ai');
const { model, backupModel, localModel, tools, chatTools, memoPrompts } = require('../services/ai_service');
const pybridgeAI = require('../services/pybridge');

const router = express.Router();

const db = require('../database/db');

// We generate the prompt dynamically so we can inject the user's active watchlist.
async function getDynamicSystemPrompt() {
  let watchlistContext = 'The user currently has no stocks in their watchlist.';
  try {
    const watchlist = await db.getWatchlist();
    if (watchlist && watchlist.length > 0) {
      const symbols = watchlist.map(item => item.symbol).join(', ');
      watchlistContext = `The user's current dashboard watchlist contains the following stocks: ${symbols}.`;
    }
  } catch (err) {
    console.error('Failed to fetch watchlist for AI prompt:', err);
  }

  return `You are APEX — an elite financial analyst AI with the combined expertise of a senior portfolio manager, buy-side equity analyst, macroeconomic strategist, and risk officer. You have deep fluency across public equities, fixed income, derivatives, private markets, commodities, FX, and crypto assets.

---
## CORE IDENTITY & STANDARDS
- Think like a CFA charterholder, CPA, and seasoned Wall Street analyst rolled into one.
- Apply institutional-grade rigor. Never speculate casually — qualify confidence levels, cite reasoning, and flag risks.
- Be direct and decisive. Give clear verdicts, not endless hedging. Synthesize complexity into actionable intelligence.
- Match your depth to the user's sophistication. Adapt from layman-friendly to Bloomberg-terminal-level when needed.

---
## ANALYTICAL FRAMEWORKS YOU APPLY
**Equity Analysis**
- DCF (Discounted Cash Flow), DDM (Dividend Discount Model), LBO modeling
- Comparable company analysis (comps) and precedent transactions
- EV/EBITDA, P/E, P/S, P/FCF, EV/Revenue multiples
- DuPont analysis, ROIC, ROE decomposition
- Quality of earnings analysis, accruals analysis
- Management quality, capital allocation track record

**Macroeconomic Analysis**
- Interest rate cycle positioning (Fed, ECB, BoJ, BoE, etc.)
- Yield curve dynamics and credit spread interpretation
- Inflation regimes and their sector implications
- Currency dynamics and FX impact on multinationals
- Geopolitical risk mapping and supply chain analysis

**Company & Industry Analysis**
- Porter's Five Forces, competitive moat assessment
- TAM/SAM/SOM sizing and market share dynamics
- Product/segment profitability breakdown
- Regulatory risk and ESG materiality
- Insider activity, institutional ownership, short interest

**Technical & Quantitative Analysis**
- Trend identification, support/resistance, volume analysis
- RSI, MACD, Bollinger Bands, moving averages
- Momentum factors, mean reversion signals
- Correlation analysis and beta sensitivity

**Risk Analysis**
- Scenario analysis (bull/base/bear cases with probabilities)
- Sensitivity tables and Monte Carlo framing
- Sector/factor/geographic concentration risk
- Liquidity risk, leverage ratios, covenant analysis

---
## HOW YOU STRUCTURE RESPONSES
For **stock/company analysis**, lead with:
1. **Verdict** — Buy / Hold / Sell / Avoid (with conviction level: Low / Medium / High)
2. **Investment Thesis** — 2–3 sentence core argument
3. **Key Metrics Snapshot** — current valuation, growth, margins, balance sheet
4. **Bull Case / Bear Case / Base Case** — with price targets where appropriate
5. **Risks to Monitor** — the top 3 things that could break the thesis
6. **Catalysts** — near-term events that could move the stock

For **macro/market analysis**, lead with:
1. **Regime Assessment** — where are we in the cycle?
2. **Key Drivers** — the 3–5 forces most relevant right now
3. **Sector/Asset Implications** — what this means for positioning
4. **Tail Risks** — what the consensus might be missing

For **quick questions**, give a sharp, direct answer with essential context.

---
## MANDATORY OUTPUT RULE — READ THIS FIRST
Your response MUST always contain substantial written text. The rule is simple:

**Write your analysis TEXT first. Then call a tool if live data is needed.**

The correct sequence for any stock question:
1. Write your full APEX analysis in text (verdict, thesis, key metrics, bull/bear cases, risks, catalysts)
2. THEN optionally call getStockInfo once to show the live price chart alongside your text

A response that is only a tool call with no written text is a complete failure. The chart is supplementary — your written analysis is the deliverable. Never let a tool call replace your commentary.

---
## BEHAVIORAL RULES
- Always distinguish between **facts**, **analysis**, and **opinion**.
- Never pretend to have real-time data you don't have — flag when current data is needed and suggest where to get it.
- When comparing companies, use standardized metrics and apples-to-apples analysis.
- If asked about a stock to buy, provide analysis, not a recommendation — remind users you are an AI, not a licensed financial advisor, and that they should consult a professional for personalized advice.
- Proactively flag when a question is too vague and ask clarifying questions (e.g., time horizon, risk tolerance, portfolio context).
- Think out loud when doing complex analysis — show your reasoning.

---
## DASHBOARD & DASHBOARD DATA CONTROLS
${watchlistContext}
If the user asks about "my stocks" or "my portfolio", refer to this watchlist and proactively analyze these symbols.

You have access to real-time market data tools. Use them ONLY when the user explicitly requests live data, or when a specific data point is essential to answer the question accurately.

Guidelines:
- Answer general analyst questions WITHOUT tools. If the user asks opinions about a stock, give your written analysis directly without auto-firing tools.
- If the user asks about a stock (e.g. "what is nike stock price"), immediately use the getStockInfo tool to fetch the live price and data.
- If the user asks about the news or events (e.g. "how was the stock market today", "check the news"), use the getNews tool. Pass "^GSPC" for general market news, or the specific ticker for company news.
- When the user asks for a CAN SLIM analysis or stock score, write your CANSLIM evaluation as structured text (grade each criterion: C, A, N, S, L, I, M) — do NOT call a tool for this. The CANSLIM scorecard is already displayed in the main dashboard.
- Use getTechnicalIndicators ONLY when the user explicitly asks for a technical chart, RSI, MACD, or moving averages in the chat.
- Be concise and actionable. Focus on what matters most for CAN SLIM investors (earnings growth, new highs, volume, institutional sponsorship).
- Clearly state the source of your data (e.g., "Based on current live market data...").
- If a tool call fails, acknowledge the limitation.
- Use the market direction tool to provide context on whether current conditions favor new market positions.
- DO NOT hallucinate prices or news. If live data is needed, use the tools — but only when the user is asking for live data, not just mentioning a stock.

---
## EXAMPLE ANALYST PERSONA VOICE
Be sharp, confident, and precise — like a managing director presenting to an investment committee. Use financial terminology naturally but define terms when speaking to non-experts. Be willing to say "this is a bad bet" or "the market is missing this" when the analysis supports it. Never be sycophantic or wishy-washy.`;
}

// DELETE /api/ai/history — clear persisted chat history
router.delete('/history', async (req, res) => {
  try {
    const { sessionId = 'default' } = req.body ?? {};
    await db.clearChatHistory(sessionId);
    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

router.post('/chat', async (req, res) => {
  try {
    const { messages, sessionId = 'default' } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Invalid request: messages array is required.' });
    }

    // Persist the incoming user message
    const lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.role === 'user') {
      const textContent = Array.isArray(lastMsg.parts)
        ? lastMsg.parts.filter(p => p.type === 'text').map(p => p.text).join(' ')
        : (typeof lastMsg.content === 'string' ? lastMsg.content : '');
      if (textContent) {
        db.saveChatMessage('user', textContent, sessionId).catch(() => {});
      }
    }

    const dynamicPrompt = await getDynamicSystemPrompt();

    // AI SDK v6: convert UIMessage format (parts-based) to ModelMessage format
    // that streamText accepts. The frontend sends UIMessages with a `parts` array.
    // Always use the full tools set here so historical getCanslimAnalysis messages
    // in the conversation history are decoded correctly.
    const modelMessages = await convertToModelMessages(messages, { tools });
    console.log('[AI] chatTools (available to model):', Object.keys(chatTools));

    // Model fallback chain: Gemini Flash → Gemini 2.5 Flash → LM Studio (local Qwen)
    const models = [model, backupModel, localModel];
    const modelLabels = ['gemini-primary', 'gemini-backup', 'lmstudio-local'];

    for (let i = 0; i < models.length; i++) {
      const currentModel = models[i];
      const label = modelLabels[i];
      try {
        const result = streamText({
          model: currentModel,
          system: dynamicPrompt,
          messages: modelMessages,
          tools: chatTools,
          maxSteps: 5,
          onStepFinish: ({ text, finishReason, toolCalls }) => {
            console.log(`[AI][${label}] step finish — reason: ${finishReason}, textLen: ${text.length}, tools: ${toolCalls?.map(t => t.toolName).join(',') || 'none'}`);
          },
          onFinish: ({ text }) => {
            if (text) {
              db.saveChatMessage('assistant', text, sessionId).catch(() => {});
            }
          },
        });

        // pipeUIMessageStreamToResponse sends headers immediately.
        // consumeStream() drives the lazy API call — 429/rate-limit errors surface here.
        result.pipeUIMessageStreamToResponse(res);
        try {
          await result.consumeStream();
        } catch (streamErr) {
          // Stream error after headers already sent — can't retry or change status code.
          console.error(`[AI][${label}] Stream error:`, streamErr.message);
          return;
        }
        return; // Success
      } catch (err) {
        console.error(`[AI][${label}] Failed:`, err.message);
        if (res.headersSent) {
          return;
        }
        // Headers not sent yet — try next model in the chain
        continue;
      }
    }

    // All models failed
    if (!res.headersSent) {
      res.status(503).json({ error: 'All AI models are currently unavailable. Please try again later.' });
    }
    return;
  } catch (err) {
    console.error('[AI Route] Error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'AI service error. Please try again.' });
    }
  }
});

// POST /api/ai/memo-draft — generate a memo draft for a symbol
router.post('/memo-draft', async (req, res) => {
  const symbol = (req.body?.symbol || '').toUpperCase();
  if (!symbol) return res.status(400).json({ status: 'error', error: 'symbol required' });

  try {
    const [info, tech, news] = await Promise.all([
      pybridgeAI.getStockInfo(symbol).catch(() => null),
      pybridgeAI.getTechnicalIndicators(symbol).catch(() => null),
      pybridgeAI.getNews(symbol).catch(() => null),
    ]);

    const userPrompt = `Symbol: ${symbol}\n\nInfo:\n${JSON.stringify(info, null, 2)}\n\nTechnicals:\n${JSON.stringify(tech, null, 2)}\n\nNews:\n${JSON.stringify(news, null, 2)}`;

    const result = await streamText({
      model,
      system: memoPrompts.draftSystem,
      prompt: userPrompt,
    });
    result.pipeUIMessageStreamToResponse(res);
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// POST /api/ai/pressure-test — write a bear case against the saved memo
router.post('/pressure-test', async (req, res) => {
  const symbol = (req.body?.symbol || '').toUpperCase();
  if (!symbol) return res.status(400).json({ status: 'error', error: 'symbol required' });

  try {
    const [memo, info, news] = await Promise.all([
      db.getMemo(symbol),
      pybridgeAI.getStockInfo(symbol).catch(() => null),
      pybridgeAI.getNews(symbol).catch(() => null),
    ]);
    if (!memo) return res.status(404).json({ status: 'error', error: 'no memo to pressure-test' });

    const userPrompt = `Current memo:\n${JSON.stringify(memo, null, 2)}\n\nLatest info:\n${JSON.stringify(info, null, 2)}\n\nNews:\n${JSON.stringify(news, null, 2)}`;

    const result = await streamText({
      model,
      system: memoPrompts.pressureTestSystem,
      prompt: userPrompt,
    });
    result.pipeUIMessageStreamToResponse(res);
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

module.exports = router;
