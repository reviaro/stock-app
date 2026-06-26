const { z } = require('zod');

const modes = {
    decisionMemo: {
        name: 'Decision Memo',
        inputs: ['symbol'],
        inputSchema: z.object({ symbol: z.string().min(1).max(10) }),
        aggregator: 'fetchStockContext',
        systemPrompt: `You are APEX, generating a structured decision memo.
Output MUST be markdown with exactly these sections (use these headings verbatim):

## Thesis
2-4 sentences on why to own this business. Reference the moat and earnings power.

## Fair Value
Provide fair_value_low and fair_value_high as dollar ranges. Show the reasoning in one sentence.

## Buy Below
A single dollar price — the max you'd pay today given the fair-value range and margin of safety. Format: $NNN.NN.

## Sell Rule
One sentence describing when you'd trim or exit.

## Invalidation
Bullet list (3-5) of conditions that would disprove the thesis.

## Risks
Bullet list (3-5) of the top risks.

## Conviction
Integer 1–5 with a one-sentence justification.

Use the provided stock context. If data is missing, say so — do not invent numbers.`,
    },
    bearCase: {
        name: 'Bear Case',
        inputs: ['symbol'],
        inputSchema: z.object({ symbol: z.string().min(1).max(10) }),
        aggregator: 'fetchStockContext',
        systemPrompt: `You are APEX, acting as a skeptical short seller.

## Bear Case
3-5 concrete, specific risks that could break the thesis.

## Invalidation Conditions
3-5 measurable conditions that would confirm the bear case is playing out.

## Verdict
One paragraph: is the thesis robust to these risks, or does it have a weak flank?`,
    },
    compare: {
        name: 'Compare',
        inputs: ['symbolA', 'symbolB'],
        inputSchema: z.object({
            symbolA: z.string().min(1).max(10),
            symbolB: z.string().min(1).max(10),
        }),
        aggregator: 'fetchStockContextPair',
        systemPrompt: `You are APEX, producing a head-to-head comparison of two businesses.
Output a markdown table with these rows:
- Market cap
- Sector
- Revenue growth (latest)
- Gross margin
- FCF margin
- Debt / Equity
- ROIC
- P/E (trailing)
- Quality score (if available)

## Verdict
One paragraph on which is the better business today, at current prices, and why.`,
    },
    weeklyReview: {
        name: 'Weekly Review',
        inputs: [],
        inputSchema: z.object({}),
        aggregator: 'aggregateWatchlistContext',
        systemPrompt: `You are APEX, producing a weekly watchlist review grouped by bucket.
For each non-empty bucket, summarize the price trend, any notable headline, and any obvious flag.

## Action Items
3-5 bullets: what the user should look at this week.`,
    },
    monthlyReview: {
        name: 'Monthly Review',
        inputs: [],
        inputSchema: z.object({}),
        aggregator: 'aggregatePortfolioContext',
        systemPrompt: `You are APEX, producing a monthly portfolio review.

## Performance
Per-position P&L summary and a portfolio-level line.

## Rule Breaches
List each current risk-rule breach with actual vs. limit.

## Memos Overdue
List symbols whose memos have not been reviewed in >30 days.

## Suggested Actions
3-5 concrete action items.`,
    },
};

function validateInputs(modeName, inputs) {
    const mode = modes[modeName];
    if (!mode) return { ok: false, error: `unknown mode: ${modeName}` };
    const parsed = mode.inputSchema.safeParse(inputs ?? {});
    if (!parsed.success) {
        return { ok: false, error: parsed.error.issues.map((issue) => issue.message).join('; ') };
    }
    return { ok: true, value: parsed.data };
}

function getMode(name) {
    return modes[name] || null;
}

module.exports = { modes, validateInputs, getMode };
