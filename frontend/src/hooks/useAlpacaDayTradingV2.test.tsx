import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, expect, test, vi } from 'vitest'
import type { ReactNode } from 'react'
import { useClearV2KillSwitch, useResolveV2Plan, useSetV2Mode } from './useAlpacaDayTradingV2'

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
