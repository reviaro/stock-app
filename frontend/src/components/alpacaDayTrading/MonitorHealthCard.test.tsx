import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MonitorHealthCard } from './MonitorHealthCard'

const { mockSetMode, mockClearKillSwitch, mockResetMode, mockResetKillSwitch, modeMutation, killSwitchMutation, monitorData } = vi.hoisted(() => ({
  mockSetMode: vi.fn(),
  mockClearKillSwitch: vi.fn(),
  mockResetMode: vi.fn(),
  mockResetKillSwitch: vi.fn(),
  modeMutation: { mutate: vi.fn(), reset: vi.fn(), isPending: false, isError: false, isSuccess: false, error: null as Error | null },
  killSwitchMutation: { mutate: vi.fn(), reset: vi.fn(), isPending: false, isError: false, isSuccess: false, error: null as Error | null },
  monitorData: {
    mode: 'shadow', killSwitch: true, healthCode: null, healthError: null,
    lastRestReconciliationAt: null, lastWebsocketEventAt: null, lastWebsocketReconnectAt: null,
    lastSyncedThrough: null, sessionDate: null, lastFlattenSweepAt: null,
  },
}))

vi.mock('@/hooks/useAlpacaDayTrading', () => ({
  useAlpacaDayTradingMonitorHealth: () => ({
    data: monitorData,
    isLoading: false, isError: false,
  }),
  useSetAlpacaDayTradingMode: () => modeMutation,
  useClearAlpacaDayTradingKillSwitch: () => killSwitchMutation,
}))

describe('MonitorHealthCard controls', () => {
  beforeEach(() => {
    mockSetMode.mockClear()
    mockClearKillSwitch.mockClear()
    mockResetMode.mockClear()
    mockResetKillSwitch.mockClear()
    Object.assign(modeMutation, { mutate: mockSetMode, reset: mockResetMode, isPending: false, isError: false, isSuccess: false, error: null })
    Object.assign(killSwitchMutation, { mutate: mockClearKillSwitch, reset: mockResetKillSwitch, isPending: false, isError: false, isSuccess: false, error: null })
    Object.assign(monitorData, { mode: 'shadow', killSwitch: true })
  })
  it('lets the signed-in operator change shadow mode after the typed confirmation, without a server token field', () => {
    render(<MonitorHealthCard />)

    expect(screen.queryByLabelText(/operator token/i)).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/new mode/i), { target: { value: 'paper_execute' } })

    const submit = screen.getByRole('button', { name: /change mode/i })
    expect(submit).toBeDisabled()

    fireEvent.change(screen.getByLabelText(/type "paper_execute" to confirm/i), { target: { value: 'wrong' } })
    expect(submit).toBeDisabled()

    fireEvent.change(screen.getByLabelText(/type "paper_execute" to confirm/i), { target: { value: 'paper_execute' } })
    expect(submit).not.toBeDisabled()

    fireEvent.click(submit)
    expect(mockSetMode.mock.calls[0][0]).toEqual('paper_execute')
  })

  it('allows a one-click transition from shadow to disabled without requiring the paper-execution confirmation phrase', () => {
    render(<MonitorHealthCard />)

    const submit = screen.getByRole('button', { name: /change mode/i })
    expect(screen.getByLabelText(/new mode/i)).toHaveValue('disabled')
    expect(submit).not.toBeDisabled()

    fireEvent.click(submit)
    expect(mockSetMode.mock.calls[0][0]).toEqual('disabled')
  })

  it('allows a one-click transition from disabled to shadow', () => {
    monitorData.mode = 'disabled'
    render(<MonitorHealthCard />)

    fireEvent.change(screen.getByLabelText(/new mode/i), { target: { value: 'shadow' } })
    const submit = screen.getByRole('button', { name: /change mode/i })
    expect(submit).not.toBeDisabled()

    fireEvent.click(submit)
    expect(mockSetMode.mock.calls[0][0]).toEqual('shadow')
  })

  it('disables redundant mode writes when the pending mode already matches the live mode', () => {
    render(<MonitorHealthCard />)

    fireEvent.change(screen.getByLabelText(/new mode/i), { target: { value: 'shadow' } })
    expect(screen.getByRole('button', { name: /change mode/i })).toBeDisabled()
  })

  it('clears stale mode feedback when the operator changes the pending action', () => {
    modeMutation.isSuccess = true
    render(<MonitorHealthCard />)
    expect(screen.getByText('Mode updated.')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText(/new mode/i), { target: { value: 'paper_execute' } })
    expect(mockResetMode).toHaveBeenCalledTimes(1)
  })

  it('clears stale kill-switch feedback when the confirmation changes', () => {
    killSwitchMutation.isSuccess = true
    render(<MonitorHealthCard />)
    expect(screen.getByText('Kill switch cleared.')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText(/type CLEAR to confirm/i), { target: { value: 'C' } })
    expect(mockResetKillSwitch).toHaveBeenCalledTimes(1)
  })

  it('locks all operator controls while a mode change request is pending', () => {
    modeMutation.isPending = true
    render(<MonitorHealthCard />)

    expect(screen.getByLabelText(/new mode/i)).toBeDisabled()
    expect(screen.getByRole('button', { name: /changing mode/i })).toBeDisabled()
    expect(screen.getByLabelText(/type CLEAR to confirm/i)).toBeDisabled()
    expect(screen.getByRole('button', { name: /clear kill switch/i })).toBeDisabled()
    expect(mockResetMode).not.toHaveBeenCalled()
    expect(mockClearKillSwitch).not.toHaveBeenCalled()
  })

  it('locks all operator controls while a kill-switch clear request is pending', () => {
    killSwitchMutation.isPending = true
    render(<MonitorHealthCard />)

    expect(screen.getByLabelText(/type CLEAR to confirm/i)).toBeDisabled()
    expect(screen.getByRole('button', { name: /clearing/i })).toBeDisabled()
    expect(screen.getByLabelText(/new mode/i)).toBeDisabled()
    expect(screen.getByRole('button', { name: /change mode/i })).toBeDisabled()
    expect(mockResetKillSwitch).not.toHaveBeenCalled()
    expect(mockSetMode).not.toHaveBeenCalled()
  })

  it('requires typing CLEAR before the signed-in operator clears a tripped kill switch', () => {
    render(<MonitorHealthCard />)

    const clearButton = screen.getByRole('button', { name: /clear kill switch/i })
    expect(clearButton).toBeDisabled()

    fireEvent.change(screen.getByLabelText(/type CLEAR to confirm/i), { target: { value: 'CLEAR' } })
    expect(clearButton).not.toBeDisabled()

    fireEvent.click(clearButton)
    expect(mockClearKillSwitch).toHaveBeenCalledTimes(1)
  })
})
