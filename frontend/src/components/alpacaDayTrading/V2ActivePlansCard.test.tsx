import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { V2ActivePlansCard } from './V2ActivePlansCard'

const { resolve } = vi.hoisted(() => ({ resolve: { mutate: vi.fn(), isPending: false, isError: false } }))
vi.mock('@/hooks/useAlpacaDayTradingV2', () => ({
  useResolveV2Plan: () => resolve,
  useV2Plans: () => ({ isLoading: false, isError: false, data: [{ id: 7, symbol: 'SPY', state: 'active', exitDeadline: '2025-01-02T20:00:00Z', setup: 'Historical entry', plannedQty: 1, filledEntryQty: 1, filledExitQty: 0, plannedEntryPrice: 100, plannedStop: 95, plannedTarget: 110, plannedRiskDollars: 5 }] }),
}))

test('legacy recovery can request resolution of an active plan after exact symbol confirmation', () => {
  render(<V2ActivePlansCard recovery />)
  const button = screen.getByRole('button', { name: 'Resolve plan' })
  expect(button).toBeDisabled()
  const input = screen.getByLabelText('Type SPY to mark this plan resolved (the broker must be flat for it)')
  fireEvent.change(input, { target: { value: 'spy' } })
  expect(button).toBeDisabled()
  fireEvent.change(input, { target: { value: 'SPY' } })
  fireEvent.click(button)
  expect(resolve.mutate).toHaveBeenCalledWith({ planId: 7, symbol: 'SPY' })
})

test('labels handed-over plans as historical and removes misleading resolution controls', () => {
  render(<V2ActivePlansCard recovery transferredPlanIds={[7]} />)
  expect(screen.getByText('Transferred to long-term')).toBeInTheDocument()
  expect(screen.getByText('Historical state: active')).toBeInTheDocument()
  expect(screen.getByText('Legacy plans (0 unresolved)')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Resolve plan' })).not.toBeInTheDocument()
})
