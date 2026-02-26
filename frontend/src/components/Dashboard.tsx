import { motion } from 'framer-motion'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useTickerStore } from '@/lib/store'
import { MarketPulse } from '@/components/MarketPulse'
import { Watchlist } from '@/components/Watchlist'
import { StockChart } from '@/components/StockChart'
import { CANSLIMScorecard } from '@/components/CANSLIMScorecard'
import { ChatPanel } from '@/components/chat/ChatPanel'

/** Animation variants for bento grid cards */
const cardVariants = {
  hidden: { opacity: 0, y: 16 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: {
      delay: i * 0.07,
      duration: 0.35,
      ease: 'easeOut',
    },
  }),
}

/** Shared hover/tap spring props for interactive cards */
const interactiveMotion = {
  whileHover: { scale: 1.015, transition: { type: 'spring', stiffness: 300, damping: 20 } },
  whileTap: { scale: 0.985, transition: { type: 'spring', stiffness: 400, damping: 25 } },
}

export function Dashboard() {
  const selectedTicker = useTickerStore((s) => s.selectedTicker)

  return (
    <div className="min-h-screen bg-background p-4">
      <div className="max-w-[1600px] mx-auto">
        <h1 className="text-2xl font-bold mb-4 text-foreground">Stock Dashboard</h1>

        {/*
          Bento Grid Layout — dense auto-flow prevents "swiss cheese" gaps.
          Mobile:  1 column  (all cards stack vertically)
          Tablet:  2 columns (md breakpoint)
          Desktop: 6 columns (lg breakpoint)

          Row spans give the grid vertical rhythm:
            - MarketPulse & Watchlist: shallow (auto height)
            - StockChart & CANSLIM:    min 380px
            - ChatPanel:               min 420px
        */}
        <div
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-6 gap-4"
          style={{ gridAutoFlow: 'dense' }}
        >

          {/* ── Market Pulse ─────────────────────────────────────
              Mobile:  full width  (col-span-1 / 1)
              Tablet:  full width  (md:col-span-2)
              Desktop: 2 of 6     (lg:col-span-2)
          ──────────────────────────────────────────────────────── */}
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

          {/* ── Active Chart ──────────────────────────────────────
              Mobile:  full width
              Tablet:  full width  (md:col-span-2)
              Desktop: 4 of 6     (lg:col-span-4)
          ──────────────────────────────────────────────────────── */}
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
                      transition={{ duration: 0.25, ease: 'easeOut' }}
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

          {/* ── Watchlist ─────────────────────────────────────────
              Mobile:  full width
              Tablet:  1 of 2     (md:col-span-1)
              Desktop: 2 of 6     (lg:col-span-2)
          ──────────────────────────────────────────────────────── */}
          <motion.div
            className="lg:col-span-2 min-h-[320px]"
            custom={2}
            initial="hidden"
            animate="visible"
            variants={cardVariants}
            {...interactiveMotion}
          >
            <Watchlist />
          </motion.div>

          {/* ── CANSLIM Scorecard ─────────────────────────────────
              Mobile:  full width
              Tablet:  1 of 2     (md:col-span-1)
              Desktop: 4 of 6     (lg:col-span-4)
          ──────────────────────────────────────────────────────── */}
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

          {/* ── AI Financial Analyst Chat ─────────────────────────
              All breakpoints: full width (6 of 6)
          ──────────────────────────────────────────────────────── */}
          <motion.div
            className="md:col-span-2 lg:col-span-6 min-h-[420px]"
            custom={4}
            initial="hidden"
            animate="visible"
            variants={cardVariants}
          >
            <ChatPanel />
          </motion.div>

        </div>
      </div>
    </div>
  )
}

export default Dashboard
