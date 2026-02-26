const express = require('express');
const { streamText, convertToModelMessages } = require('ai');
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

    // AI SDK v6: convert UIMessage format (parts-based) to ModelMessage format
    // that streamText accepts. The frontend sends UIMessages with a `parts` array.
    const modelMessages = await convertToModelMessages(messages, { tools });

    const result = await streamText({
      model,
      system: SYSTEM_PROMPT,
      messages: modelMessages,
      tools,
      maxSteps: 5,
    });

    // AI SDK v6: use pipeUIMessageStreamToResponse instead of the removed toDataStreamResponse.
    // This streams UIMessageChunks (compatible with the @ai-sdk/react useChat client).
    result.pipeUIMessageStreamToResponse(res);
  } catch (err) {
    console.error('[AI Route] Error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'AI service error. Please try again.' });
    }
  }
});

module.exports = router;
