import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useTickerStore } from '@/lib/store'
import { MarketPulse } from '@/components/MarketPulse'
import { Watchlist } from '@/components/Watchlist'
import { StockChart } from '@/components/StockChart'
import { CANSLIMScorecard } from '@/components/CANSLIMScorecard'
import { ChatPanel } from '@/components/chat/ChatPanel'

export function Dashboard() {
  const selectedTicker = useTickerStore((s) => s.selectedTicker)

  return (
    <div className="min-h-screen bg-background p-4">
      <div className="max-w-[1600px] mx-auto">
        <h1 className="text-2xl font-bold mb-4 text-foreground">Stock Dashboard</h1>

        {/* Bento Grid Layout
            Mobile:  1 column
            Tablet:  2 columns
            Desktop: 6 columns */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-6 gap-4">

          {/* Market Pulse - spans 2 cols on desktop */}
          <div className="lg:col-span-2">
            <MarketPulse />
          </div>

          {/* Active Chart - spans 4 cols on desktop */}
          <div className="lg:col-span-4">
            <Card className="h-full min-h-[450px]">
              <CardHeader className="pb-2">
                <CardTitle>
                  Active Chart
                  {selectedTicker && (
                    <span className="ml-2 text-primary font-bold">{selectedTicker}</span>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="h-[400px] p-2">
                <StockChart />
              </CardContent>
            </Card>
          </div>

          {/* Watchlist - spans 2 cols on desktop */}
          <div className="lg:col-span-2">
            <Watchlist />
          </div>

          {/* CANSLIM Scorecard - spans 4 cols on desktop */}
          <div className="lg:col-span-4">
            <CANSLIMScorecard />
          </div>

          {/* AI Financial Analyst Chat - spans full 6 cols on desktop */}
          <div className="lg:col-span-6">
            <ChatPanel />
          </div>

        </div>
      </div>
    </div>
  )
}

export default Dashboard
