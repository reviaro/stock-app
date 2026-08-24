import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { RiskRulesDrawer } from './RiskRulesDrawer'

vi.mock('@/hooks/useRisk', () => ({
  useSaveRiskRules: () => ({ mutateAsync: vi.fn(), isPending: false, isError: false }),
}))

vi.mock('@/components/ui/sheet', () => ({
  Sheet: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? children : null,
  SheetContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}))

const rules = {
  max_position_pct: 10,
  max_sector_pct: 30,
  max_risk_per_trade_pct: 1,
  target_cash_pct: 20,
}

function Harness() {
  const [open, setOpen] = useState(true)
  return (
    <>
      <button onClick={() => setOpen(true)}>Open rules</button>
      <RiskRulesDrawer open={open} onOpenChange={setOpen} rules={rules} />
    </>
  )
}

describe('RiskRulesDrawer', () => {
  it('discards unsaved edits after cancel and reopen', () => {
    render(<Harness />)
    const maxPosition = screen.getByLabelText('Max position %')
    fireEvent.change(maxPosition, { target: { value: '42' } })
    expect(maxPosition).toHaveValue(42)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open rules' }))

    expect(screen.getByLabelText('Max position %')).toHaveValue(10)
  })
})
