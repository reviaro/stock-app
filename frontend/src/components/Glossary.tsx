import { useState, type RefObject } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { CardContent, CardHeader } from '@/components/ui/card'

/* ─── Term definitions ─────────────────────────────────────────────── */

interface GlossaryTerm {
    term: string
    description: string
    category: 'canslim' | 'fundamental' | 'technical' | 'market'
}

const GLOSSARY: GlossaryTerm[] = [
    // ── CANSLIM ──
    {
        term: 'C — Current Quarterly Earnings',
        description:
            'Look for stocks with current quarterly earnings per share (EPS) up 25% or more year-over-year. Accelerating earnings growth is a key sign of a winning stock.',
        category: 'canslim',
    },
    {
        term: 'A — Annual Earnings Growth',
        description:
            'Select stocks with annual EPS growth of 25%+ over each of the last 3–5 years. Consistent long-term earnings growth separates leaders from laggards.',
        category: 'canslim',
    },
    {
        term: 'N — New Product, Management, or Price High',
        description:
            'Look for companies with a new product, new management, or the stock reaching a new price high. Innovation and positive change drive big stock moves.',
        category: 'canslim',
    },
    {
        term: 'S — Supply & Demand',
        description:
            'Favor stocks with a smaller number of shares outstanding and rising trading volume on up days. High demand with limited supply drives prices higher.',
        category: 'canslim',
    },
    {
        term: 'L — Leader or Laggard',
        description:
            'Buy the leading stock in a leading industry. Use Relative Strength (RS) rating — look for stocks ranked 80+ out of 100 vs. the overall market.',
        category: 'canslim',
    },
    {
        term: 'I — Institutional Sponsorship',
        description:
            'Look for stocks owned by a growing number of quality mutual funds and institutions. Smart-money accumulation confirms fundamental strength.',
        category: 'canslim',
    },
    {
        term: 'M — Market Direction',
        description:
            'Always invest with the general market trend. 3 out of 4 stocks follow the market direction. Check major indexes for a confirmed uptrend before buying.',
        category: 'canslim',
    },

    // ── Fundamental ──
    {
        term: 'P/E Ratio (Price-to-Earnings)',
        description:
            'Stock price divided by earnings per share. A high P/E may indicate overvaluation or growth expectations; a low P/E may suggest undervaluation or declining earnings.',
        category: 'fundamental',
    },
    {
        term: 'EPS (Earnings Per Share)',
        description:
            'Net income divided by shares outstanding. Measures how much profit a company earns per share of stock. Higher and growing EPS is generally favorable.',
        category: 'fundamental',
    },
    {
        term: 'Market Capitalization',
        description:
            'Total market value of a company\'s outstanding shares (price × shares). Categories: Mega ($200B+), Large ($10B–$200B), Mid ($2B–$10B), Small ($300M–$2B).',
        category: 'fundamental',
    },
    {
        term: 'Dividend Yield',
        description:
            'Annual dividend per share divided by the stock price, expressed as a percentage. Indicates the cash return investors receive for holding the stock.',
        category: 'fundamental',
    },
    {
        term: 'Beta',
        description:
            'Measures a stock\'s volatility relative to the market. Beta > 1 means more volatile; Beta < 1 means less volatile; Beta = 1 moves with the market.',
        category: 'fundamental',
    },
    {
        term: 'Free Cash Flow',
        description:
            'Cash generated from operations minus capital expenditures. Represents the cash available for dividends, buybacks, and reinvestment. Positive FCF is crucial.',
        category: 'fundamental',
    },
    {
        term: 'FCF Margin (Free Cash Flow Margin)',
        description:
            'Free cash flow divided by revenue, shown as a percentage. It measures how much of each sales dollar turns into real cash that management can reinvest, save, or return to shareholders.',
        category: 'fundamental',
    },
    {
        term: 'Debt-to-Equity Ratio',
        description:
            'Total liabilities divided by shareholders\' equity. A high ratio may indicate excessive debt risk. Varies by industry — compare to sector peers.',
        category: 'fundamental',
    },
    {
        term: 'Debt / Equity',
        description:
            'Another way of writing debt-to-equity. It compares how much the business owes versus the equity base supporting it. Lower is usually safer, but capital-heavy industries naturally run higher ratios.',
        category: 'fundamental',
    },
    {
        term: 'Book Value',
        description:
            'Total assets minus total liabilities, divided by shares outstanding. Represents the company\'s net asset value per share.',
        category: 'fundamental',
    },
    {
        term: 'Profit Margin',
        description:
            'Net income as a percentage of revenue. Shows how much of each dollar of revenue becomes profit. Higher margins indicate better efficiency and pricing power.',
        category: 'fundamental',
    },
    {
        term: 'Return on Equity (ROE)',
        description:
            'Net income divided by shareholders\' equity. Measures how effectively management uses invested capital to generate profits. 15%+ is generally strong.',
        category: 'fundamental',
    },
    {
        term: 'ROIC (Return on Invested Capital)',
        description:
            'Measures how efficiently a company turns the capital invested in the business into after-tax operating profit. Higher ROIC usually signals stronger economics, better discipline, and more durable competitive advantages.',
        category: 'fundamental',
    },
    {
        term: 'Interest Coverage',
        description:
            'Operating earnings divided by interest expense. It shows how comfortably a company can pay interest on its debt. Higher coverage generally means lower balance-sheet stress.',
        category: 'fundamental',
    },
    {
        term: 'Earnings Consistency',
        description:
            'A stability measure showing how reliably profits hold up across multiple years. More consistent earnings usually indicate a steadier business model and less cyclical or erratic profitability.',
        category: 'fundamental',
    },
    {
        term: 'Gross Margin',
        description:
            'Revenue minus cost of goods sold, divided by revenue. It shows how much money remains after direct production costs and is a useful read on pricing power and product economics.',
        category: 'fundamental',
    },
    {
        term: 'Gross Margin Stability',
        description:
            'A measure of how steady gross margin stays over time. Stable margins usually suggest predictable unit economics, disciplined pricing, and less operational volatility.',
        category: 'fundamental',
    },
    {
        term: 'Revenue CAGR',
        description:
            'Compound annual growth rate of revenue over a multi-year period. It smooths out year-to-year swings and shows the average pace at which sales have grown.',
        category: 'fundamental',
    },
    {
        term: 'Quality Composite Score',
        description:
            'The Quality Scorecard\'s 0-100 roll-up score. It combines several business-quality signals such as returns on capital, cash generation, leverage, coverage, consistency, and growth into one summary number.',
        category: 'fundamental',
    },
    {
        term: 'PEG Ratio',
        description:
            'P/E ratio divided by earnings growth rate. A PEG < 1 may indicate the stock is undervalued relative to its growth. Useful for growth stock comparisons.',
        category: 'fundamental',
    },

    // ── Technical ──
    {
        term: 'SMA (Simple Moving Average)',
        description:
            'Average closing price over N periods. Common periods: SMA 50 (intermediate trend) and SMA 200 (long-term trend). Price above SMA = bullish signal.',
        category: 'technical',
    },
    {
        term: 'EMA (Exponential Moving Average)',
        description:
            'Like SMA but gives more weight to recent prices. Reacts faster to price changes. EMA 12 and EMA 26 are used in MACD calculation.',
        category: 'technical',
    },
    {
        term: 'RSI (Relative Strength Index)',
        description:
            'Momentum oscillator (0–100) measuring speed and magnitude of price changes. RSI > 70 = overbought; RSI < 30 = oversold; RSI between 40–60 = neutral.',
        category: 'technical',
    },
    {
        term: 'MACD (Moving Average Convergence Divergence)',
        description:
            'Trend-following momentum indicator. Calculated as EMA 12 minus EMA 26. A signal line (EMA 9 of MACD) crossover generates buy/sell signals.',
        category: 'technical',
    },
    {
        term: 'Bollinger Bands',
        description:
            'Three lines: middle (SMA 20), upper (SMA + 2 std dev), lower (SMA − 2 std dev). Price touching the upper band may signal overbought; lower band may signal oversold.',
        category: 'technical',
    },
    {
        term: 'ATR (Average True Range)',
        description:
            'Measures market volatility by calculating the average range between daily highs and lows over N periods. Higher ATR = more volatile.',
        category: 'technical',
    },

    // ── Market ──
    {
        term: 'Volume',
        description:
            'Number of shares traded during a given period. Higher-than-average volume on up days confirms buying interest; on down days, it signals selling pressure.',
        category: 'market',
    },
    {
        term: '52-Week High / Low',
        description:
            'The highest and lowest prices a stock has traded at over the past year. Stocks near 52-week highs often show momentum strength (CANSLIM principle N).',
        category: 'market',
    },
    {
        term: 'S&P 500 (^GSPC)',
        description:
            'Index tracking 500 large-cap U.S. companies. The most widely followed benchmark for overall U.S. stock market performance.',
        category: 'market',
    },
    {
        term: 'Dow Jones (^DJI)',
        description:
            'Price-weighted index of 30 major U.S. industrial companies. One of the oldest and most-watched market indicators.',
        category: 'market',
    },
    {
        term: 'NASDAQ Composite (^IXIC)',
        description:
            'Index of over 3,000 stocks listed on the NASDAQ exchange. Heavily weighted toward technology and growth companies.',
        category: 'market',
    },
    {
        term: 'Bull Market / Bear Market',
        description:
            'A bull market is a sustained rise of 20%+ from recent lows; a bear market is a sustained decline of 20%+ from recent highs. CANSLIM\'s "M" criterion tracks this.',
        category: 'market',
    },
]

const CATEGORY_LABELS: Record<string, string> = {
    canslim: 'CANSLIM Criteria',
    fundamental: 'Fundamental Analysis',
    technical: 'Technical Indicators',
    market: 'Market Terms',
}

const CATEGORY_COLORS: Record<string, string> = {
    canslim: 'bg-violet-500/20 text-highlight border-violet-500/30',
    fundamental: 'bg-emerald-500/20 text-positive border-emerald-500/30',
    technical: 'bg-sky-500/20 text-info border-sky-500/30',
    market: 'bg-amber-500/20 text-warning border-amber-500/30',
}

const CATEGORIES = ['canslim', 'fundamental', 'technical', 'market'] as const

interface GlossaryProps {
    isOpen: boolean
    onClose: () => void
    returnFocusRef?: RefObject<HTMLButtonElement | null>
}

export function Glossary({ isOpen, onClose, returnFocusRef }: GlossaryProps) {
    const [search, setSearch] = useState('')
    const [activeCategory, setActiveCategory] = useState<string | null>(null)
    const filtered = GLOSSARY.filter((term) => (
        (!search.trim() || `${term.term} ${term.description}`.toLowerCase().includes(search.trim().toLowerCase()))
        && (!activeCategory || term.category === activeCategory)
    ))
    const grouped = CATEGORIES.map((category) => ({
        category, terms: filtered.filter((term) => term.category === category),
    })).filter((group) => group.terms.length > 0)

    return (
        <Dialog.Root open={isOpen} onOpenChange={(open) => { if (!open) onClose() }}>
            <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/60" />
                <Dialog.Content
                    className="fixed left-1/2 top-1/2 z-[60] flex max-h-[85dvh] w-[calc(100%-2rem)] max-w-3xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-border bg-card text-card-foreground shadow-xl"
                    onCloseAutoFocus={(event) => {
                        if (returnFocusRef?.current) {
                            event.preventDefault()
                            returnFocusRef.current.focus()
                        }
                    }}
                >
                    <CardHeader className="shrink-0 pb-3">
                        <div className="flex items-center justify-between gap-2">
                            <Dialog.Title asChild><h2 className="text-lg font-semibold">Glossary</h2></Dialog.Title>
                            <Dialog.Close className="min-h-11 min-w-11 rounded-md border border-border px-3 text-sm">Close</Dialog.Close>
                        </div>
                        <Dialog.Description className="text-sm text-muted-foreground">Search investment terms or filter by category.</Dialog.Description>
                        <label className="block text-sm font-medium">
                            Search terms
                            <input autoFocus type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search terms…" className="mt-1 w-full rounded-md border border-border bg-secondary px-3 py-2 text-sm text-foreground" />
                        </label>
                        <div className="flex flex-wrap gap-2" aria-label="Glossary categories">
                            <button type="button" aria-pressed={!activeCategory} onClick={() => setActiveCategory(null)} className={`rounded-full border px-3 py-2 text-xs ${!activeCategory ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-muted-foreground'}`}>All</button>
                            {CATEGORIES.map((category) => (
                                <button key={category} type="button" aria-pressed={activeCategory === category} onClick={() => setActiveCategory(activeCategory === category ? null : category)} className={`rounded-full border px-3 py-2 text-xs ${activeCategory === category ? CATEGORY_COLORS[category] : 'border-border text-muted-foreground'}`}>
                                    {CATEGORY_LABELS[category]}
                                </button>
                            ))}
                        </div>
                    </CardHeader>
                    <CardContent className="min-h-0 overflow-y-auto pb-6">
                        {grouped.length === 0 && <p role="status" className="py-8 text-sm text-muted-foreground">No terms match your search. Try another term or category.</p>}
                        {grouped.map((group) => (
                            <section key={group.category} className="mb-5 last:mb-0">
                                <h3 className="mb-2 text-sm font-semibold text-muted-foreground">{CATEGORY_LABELS[group.category]}</h3>
                                <dl className="space-y-3">
                                    {group.terms.map((term) => (
                                        <div key={term.term} className="rounded-lg border border-border bg-secondary/30 px-4 py-3">
                                            <dt className="mb-1 text-sm font-semibold">{term.term}</dt>
                                            <dd className="text-sm leading-relaxed text-muted-foreground">{term.description}</dd>
                                        </div>
                                    ))}
                                </dl>
                            </section>
                        ))}
                    </CardContent>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    )
}
