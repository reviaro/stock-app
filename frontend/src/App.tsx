import { lazy, Suspense, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { WorkspaceErrorBoundary } from '@/components/WorkspaceErrorBoundary'
import { OaklineBrand } from '@/components/OaklineBrand'
import { useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion, MotionConfig } from 'framer-motion'

const Dashboard = lazy(() => import('@/components/Dashboard').then((module) => ({ default: module.Dashboard })))
const SimulatorPage = lazy(() => import('@/pages/SimulatorPage').then((module) => ({ default: module.SimulatorPage })))
const OpportunitiesPage = lazy(() => import('@/pages/OpportunitiesPage').then((module) => ({ default: module.OpportunitiesPage })))
const AlpacaPaperPage = lazy(() => import('@/pages/AlpacaPaperPage').then((module) => ({ default: module.AlpacaPaperPage })))
const AlpacaLivePage = lazy(() => import('@/pages/AlpacaLivePage').then((module) => ({ default: module.AlpacaLivePage })))
const StrategyLabPage = lazy(() => import('@/pages/StrategyLabPage').then((module) => ({ default: module.StrategyLabPage })))
const PortfolioLabPage = lazy(() => import('@/pages/PortfolioLabPage').then((module) => ({ default: module.PortfolioLabPage })))

type Tab = 'dashboard' | 'opportunities' | 'simulator' | 'research-lab' | 'portfolio-lab' | 'alpaca-paper' | 'alpaca-live'
type AuthState =
  | { status: 'loading' }
  | { status: 'guest'; error?: string }
  | { status: 'authenticated'; username: string; sampleData: boolean }

const TABS: { id: Tab; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'opportunities', label: 'Opportunities' },
  { id: 'simulator', label: 'Simulator' },
  { id: 'research-lab', label: 'Research Lab' },
  { id: 'portfolio-lab', label: 'Portfolio Lab' },
  { id: 'alpaca-paper', label: 'Alpaca Paper' },
  { id: 'alpaca-live', label: 'Long-Term Live' },
]

function LoginPage({ onAuthenticated, initialError }: {
  onAuthenticated: (username: string, sampleData: boolean) => void
  initialError?: string
}) {
  const [username, setUsername] = useState('dashboard-user')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(initialError || '')
  const [submitting, setSubmitting] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ username, password }),
      })
      const json = await response.json()
      if (!response.ok || json.status !== 'success') {
        throw new Error(json.error || 'Unable to sign in')
      }
      setPassword('')
      onAuthenticated(json.data.username, json.data.sampleData === true)
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : 'Unable to sign in')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-background px-4">
      <section className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-lg">
        <div className="mb-6">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">Private investment workspace</p>
          <h1 className="mt-3 text-3xl text-foreground"><OaklineBrand /></h1>
          <p className="mt-2 text-base text-foreground">Invest with perspective.</p>
          <p className="mt-2 text-sm text-muted-foreground">Sign in to access portfolio, simulator, research, and broker data.</p>
        </div>
        <form className="space-y-4" onSubmit={submit}>
          <label className="block text-sm font-medium text-foreground">
            Username
            <input
              aria-label="Username"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              className="mt-1.5 w-full rounded-md border border-border bg-background px-3 py-2 text-foreground outline-none focus:border-primary"
              required
            />
          </label>
          <label className="block text-sm font-medium text-foreground">
            Password
            <input
              aria-label="Password"
              autoComplete="current-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="mt-1.5 w-full rounded-md border border-border bg-background px-3 py-2 text-foreground outline-none focus:border-primary"
              required
            />
          </label>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </section>
    </main>
  )
}

function App() {
  const queryClient = useQueryClient()
  const [logoutError, setLogoutError] = useState('')
  const [activeTab, setActiveTab] = useState<Tab>('dashboard')
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' })

  useEffect(() => {
    let active = true
    fetch('/api/auth/session', { credentials: 'same-origin' })
      .then(async (response) => {
        const json = await response.json()
        if (!active) return
        if (response.ok && json.data?.authenticated) {
          setAuth({ status: 'authenticated', username: json.data.username, sampleData: json.data.sampleData === true })
        } else {
          setAuth({ status: 'guest' })
        }
      })
      .catch(() => {
        if (active) setAuth({ status: 'guest', error: 'Unable to reach Oakline.' })
      })
    return () => { active = false }
  }, [])

  async function logout() {
    setLogoutError('')
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
      if (!response.ok) throw new Error('Sign out failed. Please try again.')
      queryClient.clear()
      setActiveTab('dashboard')
      setAuth({ status: 'guest' })
    } catch {
      setLogoutError('Unable to sign out. Check your connection and try again.')
    }
  }

  if (auth.status === 'loading') {
    return <main className="min-h-screen flex items-center justify-center bg-background text-sm text-muted-foreground">Opening Oakline…</main>
  }
  if (auth.status === 'guest') {
    return <LoginPage initialError={auth.error} onAuthenticated={(username, sampleData) => setAuth({ status: 'authenticated', username, sampleData })} />
  }

  return (
    <MotionConfig reducedMotion="user">
      <a href="#workspace-content" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[70] focus:rounded focus:bg-background focus:p-3 focus:text-foreground">Skip to workspace</a>
      <header className="sticky top-0 z-50 border-b border-border bg-background/95 backdrop-blur-sm">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
          <button type="button" onClick={() => setActiveTab('dashboard')} aria-label="Oakline home" className="rounded-md text-xl text-foreground">
            <OaklineBrand />
          </button>
          <div className="flex min-w-0 flex-wrap items-center gap-3 text-xs text-muted-foreground">
            {auth.sampleData && <span className="whitespace-nowrap rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 font-medium text-primary">Sample data</span>}
            <span className="max-w-40 truncate" title={auth.username}>{auth.username}</span>
            <button
              type="button"
              onClick={() => void logout()}
              className="shrink-0 rounded-md border border-border px-2.5 py-1 transition-colors hover:border-primary hover:text-foreground"
            >
              Sign out
            </button>
          </div>
        </div>
        <nav aria-label="Workspaces" className="flex items-end gap-1 overflow-x-auto px-4">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              aria-current={activeTab === tab.id ? 'page' : undefined}
              aria-controls="workspace-content"
              onClick={() => setActiveTab(tab.id)}
              className={[
                'shrink-0 whitespace-nowrap px-4 py-2 text-sm rounded-t-md border border-b-0 transition-colors',
                activeTab === tab.id
                  ? 'border-border bg-card text-foreground font-semibold'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              ].join(' ')}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </header>

      {logoutError && <p role="alert" className="p-3 text-sm text-destructive">{logoutError}</p>}
      <section id="workspace-content" tabIndex={-1} aria-label={TABS.find((tab) => tab.id === activeTab)?.label}>
      <WorkspaceErrorBoundary key={activeTab} onReturn={activeTab === 'dashboard' ? undefined : () => setActiveTab('dashboard')}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={activeTab}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -12 }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
        >
          <Suspense fallback={<main className="min-h-screen flex items-center justify-center bg-background text-sm text-muted-foreground">Loading workspace…</main>}>
            {activeTab === 'dashboard'
              ? <Dashboard />
              : activeTab === 'opportunities'
                ? <OpportunitiesPage />
                : activeTab === 'simulator'
                  ? <SimulatorPage />
                  : activeTab === 'research-lab'
                    ? <StrategyLabPage />
                    : activeTab === 'portfolio-lab'
                      ? <PortfolioLabPage />
                      : activeTab === 'alpaca-live' ? <AlpacaLivePage /> : <AlpacaPaperPage /> }
          </Suspense>
        </motion.div>
      </AnimatePresence>
      </WorkspaceErrorBoundary>
      </section>
    </MotionConfig>
  )
}

export default App
