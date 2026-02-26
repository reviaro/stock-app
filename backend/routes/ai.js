const express = require('express');
const { streamText } = require('ai');
const { model, tools } = require('../services/ai_service');

const router = express.Router();

const SYSTEM_PROMPT = `You are an expert AI financial analyst assistant for a stock market dashboard powered by CAN SLIM methodology.

You have access to real-time market data tools to help users analyze stocks, understand market conditions, and make informed investment decisions.

Guidelines:
- Always use the available tools to fetch live data before making analysis claims.
- When discussing a stock, proactively fetch its CAN SLIM analysis and technical indicators.
- Be concise and actionable. Focus on what matters most for CAN SLIM investors.
- Clearly state the source of your data (e.g., "Based on current technical indicators...").
- If a tool call fails, acknowledge the limitation and work with available data.
- Use the market direction tool to provide context on whether conditions favor new positions.`;

router.post('/chat', async (req, res) => {
  try {
    const { messages } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Invalid request: messages array is required.' });
    }

    const result = await streamText({
      model,
      system: SYSTEM_PROMPT,
      messages,
      tools,
      maxSteps: 5,
    });

    const response = result.toDataStreamResponse();

    // Copy headers from AI SDK response
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });

    res.status(response.status);

    // Pipe the readable stream body to Express response
    const reader = response.body.getReader();
    const pump = async () => {
      const { done, value } = await reader.read();
      if (done) {
        res.end();
        return;
      }
      res.write(value);
      return pump();
    };

    await pump();
  } catch (err) {
    console.error('[AI Route] Error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'AI service error. Please try again.' });
    }
  }
});

module.exports = router;
