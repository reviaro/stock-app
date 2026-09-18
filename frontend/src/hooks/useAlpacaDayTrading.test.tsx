import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, expect, test, vi } from 'vitest'
import type { ReactNode } from 'react'
import { useSetAlpacaDayTradingMode, useClearAlpacaDayTradingKillSwitch } from './useAlpacaDayTrading'

beforeEach(() => { vi.restoreAllMocks() })

function mount<T>(hook: () => T) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  return renderHook(hook, { wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> })
}

const response = (status: number, data: unknown) =>
  new Response(JSON.stringify(status < 400 ? { status: 'success', data } : { status: 'error', error: 'Rejected' }), { status })

// Locks the exact wire shape dayTradingGateOpen/the /mode route require -- header name and
// body shape are bare literals with nothing else (tsc, the mocked-hook component tests) to
// catch a silent typo or rename.
test('useSetAlpacaDayTradingMode POSTs the mode, confirm flag, and operator token header', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response(200, { mode: 'shadow', killSwitch: false }))
  const { result } = mount(() => useSetAlpacaDayTradingMode())
  await act(async () => { await result.current.mutateAsync({ mode: 'shadow', token: 'secret-token' }) })

  expect(fetcher).toHaveBeenCalledTimes(1)
  const [url, options] = fetcher.mock.calls[0]
  expect(url).toBe('/api/alpaca-paper/day-trading/mode')
  expect(options?.method).toBe('POST')
  expect((options?.headers as Record<string, string>)['X-Alpaca-Day-Trading-Token']).toBe('secret-token')
  expect(JSON.parse(options?.body as string)).toEqual({ mode: 'shadow', confirm: true })
})

test('useClearAlpacaDayTradingKillSwitch POSTs confirm and the operator token header', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response(200, { killSwitch: false }))
  const { result } = mount(() => useClearAlpacaDayTradingKillSwitch())
  await act(async () => { await result.current.mutateAsync('secret-token') })

  expect(fetcher).toHaveBeenCalledTimes(1)
  const [url, options] = fetcher.mock.calls[0]
  expect(url).toBe('/api/alpaca-paper/day-trading/kill-switch/clear')
  expect(options?.method).toBe('POST')
  expect((options?.headers as Record<string, string>)['X-Alpaca-Day-Trading-Token']).toBe('secret-token')
  expect(JSON.parse(options?.body as string)).toEqual({ confirm: true })
})
