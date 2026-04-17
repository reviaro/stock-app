import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Sun, Moon } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useTickerStore } from '@/lib/store'
import { MarketPulse } from '@/components/MarketPulse'
import { Watchlist } from '@/components/Watchlist'
import { StockChart } from '@/components/StockChart'
import { CANSLIMScorecard } from '@/components/CANSLIMScorecard'
import { ChatPanel } from '@/components/chat/ChatPanel'
import { Glossary } from '@/components/Glossary'
import { HistoryPanel } from '@/components/HistoryPanel'
import { PortfolioPanel } from '@/components/PortfolioPanel'
import { SectorRotation } from '@/components/SectorRotation'

/** Animation variants for bento grid cards */
const cardVariants = {
  hidden: { opacity: 0, y: 16 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: {
      delay: i * 0.07,
      duration: 0.35,
      ease: 'easeOut' as const,
    },
  }),
}

/** Shared hover/tap spring props for interactive cards */
const interactiveMotion = {
  whileHover: { scale: 1.015, transition: { type: 'spring' as const, stiffness: 300, damping: 20 } },
  whileTap: { scale: 0.985, transition: { type: 'spring' as const, stiffness: 400, damping: 25 } },
}

export function Dashboard() {
  const selectedTicker = useTickerStore((s) => s.selectedTicker)
  const [glossaryOpen, setGlossaryOpen] = useState(false)
  const [isDark, setIsDark] = useState(true)

  // Initialize theme from localStorage or default to dark
  useEffect(() => {
    const saved = localStorage.getItem('theme')
    const dark = saved ? saved === 'dark' : true
    setIsDark(dark)
    document.documentElement.classList.toggle('dark', dark)
  }, [])

  const toggleTheme = () => {
    const next = !isDark
    setIsDark(next)
    document.documentElement.classList.toggle('dark', next)
    localStorage.setItem('theme', next ? 'dark' : 'light')
  }

  return (
    <div className="min-h-screen bg-background p-4">
      <div className="max-w-[1600px] mx-auto">
        {/* Header with title and glossary button */}
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-2xl font-bold text-foreground">Stock Dashboard</h1>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={toggleTheme}
              className="flex items-center justify-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:border-primary hover:bg-accent transition-colors"
              aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
              title={isDark ? 'Light mode' : 'Dark mode'}
            >
              {isDark ? (
                <><Sun size={16} className="text-yellow-400" /> Light</>
              ) : (
                <><Moon size={16} className="text-blue-400" /> Dark</>
              )}
            </button>
            <button
              type="button"
              onClick={() => setGlossaryOpen(true)}
              className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:border-primary hover:bg-accent transition-colors"
            >
              <span>📖</span> Glossary
            </button>
          </div>
        </div>

        {/* Bento Grid Layout */}
        <div
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-6 gap-4"
          style={{ gridAutoFlow: 'dense' }}
        >

          {/* ── Market Pulse ── */}
          <motion.div
            className="lg:col-span-2 min-h-[180px]"
            custom={0}
            initial="hidden"
            animate="visible"
            variants={cardVariants}
            {...interactiveMotion}
          >
            <MarketPulse />
          </motion.div>

          {/* ── Active Chart ── */}
          <motion.div
            className="md:col-span-2 lg:col-span-4 min-h-[420px]"
            custom={1}
            initial="hidden"
            animate="visible"
            variants={cardVariants}
          >
            <Card className="h-full">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2">
                  Active Chart
                  {selectedTicker && (
                    <motion.span
                      key={selectedTicker}
                      className="text-primary font-bold"
                      initial={{ opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ duration: 0.25, ease: 'easeOut' as const }}
                    >
                      {selectedTicker}
                    </motion.span>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="h-[calc(100%-4rem)] p-2">
                <StockChart />
              </CardContent>
            </Card>
          </motion.div>

          {/* ── Watchlist ── */}
          <motion.div
            className="lg:col-span-2 min-h-[320px]"
            custom={2}
            initial="hidden"
            animate="visible"
            variants={cardVariants}
          >
            <Watchlist />
          </motion.div>

          {/* ── CANSLIM Scorecard ── */}
          <motion.div
            className="lg:col-span-4 min-h-[320px]"
            custom={3}
            initial="hidden"
            animate="visible"
            variants={cardVariants}
            {...interactiveMotion}
          >
            <CANSLIMScorecard />
          </motion.div>

          {/* ── Portfolio Tracker ── */}
          <motion.div
            className="lg:col-span-2 min-h-[360px]"
            custom={5}
            initial="hidden"
            animate="visible"
            variants={cardVariants}
          >
            <PortfolioPanel />
          </motion.div>

          {/* ── Daily Price History ── */}
          <motion.div
            className="lg:col-span-4 min-h-[360px]"
            custom={6}
            initial="hidden"
            animate="visible"
            variants={cardVariants}
            {...interactiveMotion}
          >
            <HistoryPanel />
          </motion.div>

          {/* ── Sector Rotation ── */}
          <motion.div
            className="lg:col-span-2 min-h-[360px]"
            custom={7}
            initial="hidden"
            animate="visible"
            variants={cardVariants}
          >
            <SectorRotation />
          </motion.div>

          {/* ── AI Financial Analyst Chat ── */}
          <motion.div
            className="md:col-span-2 lg:col-span-6 min-h-[420px]"
            custom={8}
            initial="hidden"
            animate="visible"
            variants={cardVariants}
          >
            <ChatPanel />
          </motion.div>

        </div>
      </div>

      {/* Glossary Modal */}
      <Glossary isOpen={glossaryOpen} onClose={() => setGlossaryOpen(false)} />
    </div>
  )
}

export default Dashboard
