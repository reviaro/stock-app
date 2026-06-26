import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'

vi.mock('@/components/Dashboard', () => ({
  Dashboard: () => <div>Stock Dashboard</div>,
  default: () => <div>Stock Dashboard</div>,
}))

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { 
      queries: { 
        retry: false,
        staleTime: 0,
      } 
    },
  })
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
  )
}

describe('App', () => {
  it('renders the Stock Dashboard heading', () => {
    renderWithProviders(<App />)
    expect(screen.getByText('Stock Dashboard')).toBeInTheDocument()
  })
})
