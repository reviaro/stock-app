import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { beforeEach, describe, it, expect, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'

vi.mock('@/components/Dashboard', () => ({
  Dashboard: () => <div>Stock Dashboard</div>,
  default: () => <div>Stock Dashboard</div>,
}))

vi.mock('@/pages/AlpacaPaperPage', () => ({
  AlpacaPaperPage: () => <div>Paper broker screen</div>,
}))

vi.mock('@/pages/StrategyLabPage', () => ({
  StrategyLabPage: () => <div>Research evidence screen</div>,
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
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'success', data: { authenticated: true, username: 'dashboard-user' } }),
    }))
  })

  it('shows login instead of dashboard content for an unauthenticated visitor', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'success', data: { authenticated: false } }),
    } as Response)

    renderWithProviders(<App />)

    expect(await screen.findByRole('heading', { name: 'Stock Dashboard' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.queryByText('Research Lab')).not.toBeInTheDocument()
  })

  it('submits credentials and reveals the dashboard after successful login', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'success', data: { authenticated: false } }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'success', data: { authenticated: true, username: 'dashboard-user' } }),
      } as Response)

    renderWithProviders(<App />)
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'dashboard-user' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    await waitFor(() => expect(screen.getByText('Stock Dashboard')).toBeInTheDocument())
    expect(fetch).toHaveBeenLastCalledWith('/api/auth/login', expect.objectContaining({ method: 'POST' }))
  })

  it('renders the Stock Dashboard heading', async () => {
    renderWithProviders(<App />)
    expect(await screen.findByText('Stock Dashboard')).toBeInTheDocument()
  })

  it('opens the evidence-only strategy research screen', async () => {
    renderWithProviders(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Research Lab' }))
    expect(await screen.findByText('Research evidence screen')).toBeInTheDocument()
  })

  it('opens the separate Alpaca paper broker screen', async () => {
    renderWithProviders(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Alpaca Paper' }))
    expect(await screen.findByText('Paper broker screen')).toBeInTheDocument()
  })
})
