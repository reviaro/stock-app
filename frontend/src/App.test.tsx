import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { beforeEach, describe, it, expect, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'

vi.mock('@/components/Dashboard', () => ({
  Dashboard: () => <h1>Market overview</h1>,
  default: () => <h1>Market overview</h1>,
}))

vi.mock('@/pages/AlpacaPaperPage', () => ({
  AlpacaPaperPage: () => <div>Paper broker screen</div>,
}))

vi.mock('@/pages/StrategyLabPage', () => ({
  StrategyLabPage: () => <div>Research evidence screen</div>,
}))

vi.mock('@/pages/PortfolioLabPage', () => ({
  PortfolioLabPage: () => <div>Portfolio allocation screen</div>,
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
      json: async () => ({ status: 'success', data: { authenticated: true, username: 'dashboard-user', mfaConfigured: false } }),
    }))
  })

  it('shows login instead of dashboard content for an unauthenticated visitor', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'success', data: { authenticated: false, mfaConfigured: false } }),
    } as Response)

    renderWithProviders(<App />)

    expect(await screen.findByRole('heading', { name: 'Oakline' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.queryByText('Research Lab')).not.toBeInTheDocument()
  })

  it('submits credentials and reveals the dashboard after successful login', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'success', data: { authenticated: false, mfaConfigured: false } }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'success', data: { authenticated: true, username: 'dashboard-user', mfaConfigured: false } }),
      } as Response)

    renderWithProviders(<App />)
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'dashboard-user' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Market overview' })).toBeInTheDocument())
    expect(fetch).toHaveBeenLastCalledWith('/api/auth/login', expect.objectContaining({ method: 'POST' }))
  })

  it('opens the market overview in the authenticated workspace', async () => {
    renderWithProviders(<App />)
    expect(await screen.findByRole('heading', { name: 'Market overview' })).toBeInTheDocument()
    expect(screen.queryByText('Sample data')).not.toBeInTheDocument()
  })
  it('asks for an authenticator code only when server login requires it', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: { authenticated: false, mfaConfigured: true } }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: { authenticated: true, username: 'dashboard-user', mfaConfigured: true } }) } as Response)
    renderWithProviders(<App />)
    fireEvent.change(await screen.findByLabelText('Password'), { target: { value: 'fictional-password' } })
    fireEvent.change(screen.getByLabelText('Authenticator code'), { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Market overview' })).toBeInTheDocument())
    expect(fetch).toHaveBeenLastCalledWith('/api/auth/login', expect.objectContaining({ body: JSON.stringify({ username: 'dashboard-user', password: 'fictional-password', otp: '123456' }) }))
  })

  it.each(['network failure', 'server error', 'missing capabilities'])('retries %s before allowing login and restores the required authenticator field', async (failure) => {
    if (failure === 'network failure') {
      vi.mocked(fetch).mockRejectedValueOnce(new Error('Offline'))
    } else {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: failure !== 'server error',
        json: async () => ({ status: 'success', data: { authenticated: false, ...(failure === 'server error' ? { mfaConfigured: false } : {}) } }),
      } as Response)
    }
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: { authenticated: false, mfaConfigured: true } }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: { authenticated: true, username: 'dashboard-user', mfaConfigured: true } }) } as Response)

    renderWithProviders(<App />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to verify sign-in requirements')
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()
    expect(fetch).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Retry connection' }))
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument()
    fireEvent.change(await screen.findByLabelText('Authenticator code'), { target: { value: '123456' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'fictional-password' } })
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/auth/session', { credentials: 'same-origin' })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByRole('heading', { name: 'Market overview' })).toBeInTheDocument()
    expect(fetch).toHaveBeenLastCalledWith('/api/auth/login', expect.objectContaining({ body: JSON.stringify({ username: 'dashboard-user', password: 'fictional-password', otp: '123456' }) }))
  })

  it('shows the sample badge when the server session identifies sample data', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'success', data: { authenticated: true, username: 'sample-investor', sampleData: true, mfaConfigured: false } }),
    } as Response)
    renderWithProviders(<App />)
    expect(await screen.findByText('Sample data')).toBeInTheDocument()
  })

  it('shows the sample badge immediately after sample login', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: { authenticated: false, mfaConfigured: false } }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: { authenticated: true, username: 'sample-investor', sampleData: true, mfaConfigured: false } }) } as Response)
    renderWithProviders(<App />)
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'sample-investor' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'sample-portfolio' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText('Sample data')).toBeInTheDocument()
  })

  it('opens the evidence-only strategy research screen', async () => {
    renderWithProviders(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Research Lab' }))
    expect(await screen.findByText('Research evidence screen')).toBeInTheDocument()
  })

  it('opens the separate read-only Portfolio Lab screen', async () => {
    renderWithProviders(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Portfolio Lab' }))
    expect(await screen.findByText('Portfolio allocation screen')).toBeInTheDocument()
  })

  it('opens the separate Alpaca paper broker screen', async () => {
    renderWithProviders(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Alpaca Paper' }))
    expect(await screen.findByText('Paper broker screen')).toBeInTheDocument()
  })
})
