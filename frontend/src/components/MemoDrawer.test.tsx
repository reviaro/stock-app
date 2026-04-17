import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoDrawer } from './MemoDrawer'

function renderWithQuery(ui: React.ReactElement) {
  const qc = new QueryClient()
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

describe('MemoDrawer', () => {
  it('renders title and close button when open', () => {
    renderWithQuery(<MemoDrawer symbol="AAPL" open={true} onOpenChange={() => {}} />)
    expect(screen.getByText(/AAPL/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/thesis/i)).toBeInTheDocument()
  })
})
