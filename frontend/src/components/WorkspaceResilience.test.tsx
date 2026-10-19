import { useRef, useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Glossary } from './Glossary'
import { WorkspaceErrorBoundary } from './WorkspaceErrorBoundary'
import { QuoteRefresh } from './QuoteRefresh'

function GlossaryHost() {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  return <><button ref={trigger} onClick={() => setOpen(true)}>Open glossary</button><button>Background action</button><Glossary isOpen={open} onClose={() => setOpen(false)} returnFocusRef={trigger} /></>
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('workspace recovery and accessibility', () => {
  it('opens a named dialog, focuses search, traps focus, and restores the trigger on Escape', async () => {
    render(<GlossaryHost />)
    const trigger = screen.getByRole('button', { name: 'Open glossary' })
    trigger.focus()
    fireEvent.click(trigger)
    expect(screen.getByRole('dialog', { name: 'Glossary' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('searchbox', { name: 'Search terms' })).toHaveFocus())
    const lastButton = screen.getByRole('button', { name: 'Market Terms' })
    lastButton.focus()
    fireEvent.keyDown(lastButton, { key: 'Tab' })
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()
  })

  it('keeps a failed page recoverable without revealing the internal exception', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let fail = true
    function Page() { if (fail) throw new Error('private exception details'); return <p>Recovered page</p> }
    render(<WorkspaceErrorBoundary><Page /></WorkspaceErrorBoundary>)
    expect(screen.getByRole('alert')).toHaveTextContent('This workspace could not load')
    expect(screen.queryByText('private exception details')).not.toBeInTheDocument()
    fail = false
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(screen.getByText('Recovered page')).toBeInTheDocument()
  })

  it('identifies old responses and offers manual refresh without claiming live quotes', () => {
    const refresh = vi.fn()
    const { rerender } = render(<QuoteRefresh label="market indexes" updatedAt={Date.now() - 180_000} onRefresh={refresh} />)
    expect(screen.getByText(/Refresh overdue/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh market indexes' }))
    expect(refresh).toHaveBeenCalledOnce()
    rerender(<QuoteRefresh label="market indexes" updatedAt={Date.now()} isFetching onRefresh={refresh} />)
    expect(screen.getByRole('button', { name: 'Refresh market indexes' })).toBeDisabled()
    expect(screen.getByText(/Quotes may be delayed/)).toBeInTheDocument()
  })
})
