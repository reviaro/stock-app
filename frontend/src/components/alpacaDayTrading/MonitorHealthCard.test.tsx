import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MonitorHealthCard } from './MonitorHealthCard'

const { mockSetMode, mockClearKillSwitch } = vi.hoisted(() => ({
  mockSetMode: vi.fn(),
  mockClearKillSwitch: vi.fn(),
}))

vi.mock('@/hooks/useAlpacaDayTrading', () => ({
  useAlpacaDayTradingMonitorHealth: () => ({
    data: {
      mode: 'shadow', killSwitch: true, healthCode: null, healthError: null,
      lastRestReconciliationAt: null, lastWebsocketEventAt: null, lastWebsocketReconnectAt: null,
      lastSyncedThrough: null, sessionDate: null, lastFlattenSweepAt: null,
    },
    isLoading: false, isError: false,
  }),
  useSetAlpacaDayTradingMode: () => ({ mutate: mockSetMode, isPending: false, isError: false, error: null }),
  useClearAlpacaDayTradingKillSwitch: () => ({ mutate: mockClearKillSwitch, isPending: false, isError: false, error: null }),
}))

describe('MonitorHealthCard controls', () => {
  it('only submits a mode change once the typed confirmation exactly matches the selected mode, and sends the operator token', () => {
    render(<MonitorHealthCard />)

    fireEvent.change(screen.getByLabelText(/operator token/i), { target: { value: 'secret-token' } })
    fireEvent.change(screen.getByLabelText(/new mode/i), { target: { value: 'paper_execute' } })

    const submit = screen.getByRole('button', { name: /change mode/i })
    expect(submit).toBeDisabled()

    fireEvent.change(screen.getByLabelText(/type "paper_execute" to confirm/i), { target: { value: 'wrong' } })
    expect(submit).toBeDisabled()

    fireEvent.change(screen.getByLabelText(/type "paper_execute" to confirm/i), { target: { value: 'paper_execute' } })
    expect(submit).not.toBeDisabled()

    fireEvent.click(submit)
    expect(mockSetMode.mock.calls[0][0]).toEqual({ mode: 'paper_execute', token: 'secret-token' })
  })

  it('requires typing CLEAR and the operator token before clearing a tripped kill switch', () => {
    render(<MonitorHealthCard />)

    fireEvent.change(screen.getByLabelText(/operator token/i), { target: { value: 'secret-token' } })

    const clearButton = screen.getByRole('button', { name: /clear kill switch/i })
    expect(clearButton).toBeDisabled()

    fireEvent.change(screen.getByLabelText(/type CLEAR to confirm/i), { target: { value: 'CLEAR' } })
    expect(clearButton).not.toBeDisabled()

    fireEvent.click(clearButton)
    expect(mockClearKillSwitch.mock.calls[0][0]).toEqual('secret-token')
  })
})
