import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, expect, test, vi } from 'vitest'
import type { ReactNode } from 'react'
import { useAlpacaDayTradingJournal } from './useAlpacaDayTrading'

beforeEach(() => { vi.restoreAllMocks() })

function mount<T>(hook: () => T) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  return renderHook(hook, { wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> })
}

const response = (status: number, data: unknown) =>
  new Response(JSON.stringify(status < 400 ? { status: 'success', data } : { status: 'error', error: 'Rejected' }), { status })

// Pins the /journal response as {analytics, trades, events}, not the flat analytics object it
// used to be -- a regression here silently breaks DayTradingJournalCard, which reads
// journal.analytics rather than the query data directly.
test('useAlpacaDayTradingJournal returns the nested analytics/trades/events shape', async () => {
  const data = {
    analytics: { closed_trade_count: 1, win_rate_pct: 100, expectancy: 35, profit_factor: null, average_r: 1.4, total_pnl: 35, by_setup: {} },
    trades: [{ id: 1, symbol: 'AMD', state: 'closed' }],
    events: [{ source: 'semantic', planId: 1, eventType: 'review', action: 'review', outcome: 'recorded', reason: null, detail: {}, occurredAt: '2026-09-21T00:00:00.000Z' }],
  }
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response(200, data))
  const { result } = mount(() => useAlpacaDayTradingJournal())
  await waitFor(() => expect(result.current.isSuccess).toBe(true))

  expect(result.current.data?.analytics.closed_trade_count).toBe(1)
  expect(result.current.data?.trades).toHaveLength(1)
  expect(result.current.data?.events[0].eventType).toBe('review')
})
