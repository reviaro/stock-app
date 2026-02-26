import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useTickerStore } from '@/lib/store'
import { MarketPulse } from '@/components/MarketPulse'
import { Watchlist } from '@/components/Watchlist'

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
            <Card className="h-full min-h-[200px]">
              <CardHeader>
                <CardTitle>
                  Active Chart
                  {selectedTicker && (
                    <span className="ml-2 text-primary font-bold">{selectedTicker}</span>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground text-sm">
                  Select a stock from the Watchlist to view its chart.
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Watchlist - spans 2 cols on desktop */}
          <div className="lg:col-span-2">
            <Watchlist />
          </div>

          {/* CANSLIM Scorecard - spans 4 cols on desktop */}
          <div className="lg:col-span-4">
            <Card className="h-full min-h-[200px]">
              <CardHeader>
                <CardTitle>CANSLIM Scorecard</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground text-sm">
                  Select a stock to view its CANSLIM analysis.
                </p>
              </CardContent>
            </Card>
          </div>

        </div>
      </div>
    </div>
  )
}

export default Dashboard
