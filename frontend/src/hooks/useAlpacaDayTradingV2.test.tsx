import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, expect, test, vi } from 'vitest'
import type { ReactNode } from 'react'
import { useApplyAlpacaHistory, useClearV2KillSwitch, useCreateV2Experiment, useDisableLegacyAlpacaMonitor, usePreviewAlpacaHistory, useResolveV2Plan, useSetV2Mode } from './useAlpacaDayTradingV2'

beforeEach(() => { vi.restoreAllMocks() })

function mount<T>(hook: () => T) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  return renderHook(hook, { wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> })
}

const ok = (data: unknown) => new Response(JSON.stringify({ status: 'success', data }), { status: 200 })

function sentHeaders(options: RequestInit | undefined) {
  return Object.keys((options?.headers as Record<string, string>) || {}).map((name) => name.toLowerCase())
}

test('v2 operator controls send exact confirmations over the session cookie with no token header', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(ok({ mode: 'paper_execute' }))
    .mockResolvedValueOnce(ok({ killSwitch: false }))
    .mockResolvedValueOnce(ok({ plan: {} }))
  const mode = mount(() => useSetV2Mode())
  const clear = mount(() => useClearV2KillSwitch())
  const resolve = mount(() => useResolveV2Plan())
  await act(async () => { await mode.result.current.mutateAsync({ mode: 'paper_execute', confirm: 'paper_execute' }) })
  await act(async () => { await clear.result.current.mutateAsync() })
  await act(async () => { await resolve.result.current.mutateAsync({ planId: 7, symbol: 'NVDA' }) })

  const calls = fetcher.mock.calls.map(([url, options]) => [url, JSON.parse(String(options?.body)), sentHeaders(options)])
  expect(calls).toEqual([
    ['/api/alpaca-paper/day-trading/v2/mode', { mode: 'paper_execute', confirm: 'paper_execute' }, ['content-type']],
    ['/api/alpaca-paper/day-trading/v2/kill-switch/clear', { confirm: 'CLEAR' }, ['content-type']],
    ['/api/alpaca-paper/day-trading/v2/plans/7/resolve', { confirm: 'NVDA' }, ['content-type']],
  ])
})

test('a failed v2 request surfaces only the stable code and a fixed message, never the response text', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
    status: 'error', code: 'ALPACA_V2_BROKER_UNAVAILABLE', error: 'request failed https://paper-api.alpaca.markets 9f1c2d3e-1111-4222-8333-444455556666',
  }), { status: 503 }))
  const mode = mount(() => useSetV2Mode())
  let caught: unknown
  await act(async () => { try { await mode.result.current.mutateAsync({ mode: 'shadow', confirm: 'shadow' }) } catch (error) { caught = error } })
  expect((caught as { code: string }).code).toBe('ALPACA_V2_BROKER_UNAVAILABLE')
  expect((caught as Error).message).not.toMatch(/https|9f1c2d3e|request failed/)
})

test('history controls send only explicit reviewed selections and refresh the separate journals after apply', async () => {
  const invalidate = vi.spyOn(QueryClient.prototype, 'invalidateQueries')
  const fetcher = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(ok({ reviewToken: 'synthetic-review' }))
    .mockResolvedValueOnce(ok({ disabled: true, alreadyDisabled: false, mode: 'disabled' }))
    .mockResolvedValueOnce(ok({ applied: true, replayed: false, repairedPlanCount: 1, importedFillCount: 1, linkedFillCount: 1 }))
  const preview = mount(usePreviewAlpacaHistory)
  const disable = mount(useDisableLegacyAlpacaMonitor)
  const apply = mount(useApplyAlpacaHistory)
  expect(fetcher).not.toHaveBeenCalled()
  await act(async () => { await preview.result.current.mutateAsync() })
  await act(async () => { await disable.result.current.mutateAsync() })
  await act(async () => { await apply.result.current.mutateAsync({ reviewToken: 'synthetic-review', selectedPlanIds: [12], attributionPlanIds: [12], confirm: 'APPLY_HISTORY_REPAIR' }) })
  expect(fetcher.mock.calls.map(([url, options]) => [url, JSON.parse(String(options?.body)), sentHeaders(options)])).toEqual([
    ['/api/alpaca-paper/day-trading/v2/history/preview', {}, ['content-type']],
    ['/api/alpaca-paper/day-trading/v2/history/disable-legacy', { confirm: 'DISABLE_LEGACY' }, ['content-type']],
    ['/api/alpaca-paper/day-trading/v2/history/apply', { reviewToken: 'synthetic-review', selectedPlanIds: [12], attributionPlanIds: [12], confirm: 'APPLY_HISTORY_REPAIR' }, ['content-type']],
  ])
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['alpaca-day-trading'] })
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['alpaca-dt-v2'] })
})

test('a shadow experiment posts the future definition without execution controls', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok({ id: 3 }))
  const experiment = mount(useCreateV2Experiment)
  const definition = { name: 'Synthetic stall hypothesis', setupId: '*', strategyVersion: '*', kind: 'stall_exit' as const, parameters: { afterMinutes: 20, minimumProgressR: 0.5 }, durationDays: 10, minTrades: 30, costBps: 2 }
  await act(async () => { await experiment.result.current.mutateAsync(definition) })
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(fetcher.mock.calls[0][0]).toBe('/api/alpaca-paper/day-trading/v2/experiments')
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual(definition)
  expect(sentHeaders(fetcher.mock.calls[0][1])).toEqual(['content-type'])
})
