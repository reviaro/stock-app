import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Dashboard } from '@/components/Dashboard'
import { SimulatorPage } from '@/pages/SimulatorPage'
import { OpportunitiesPage } from '@/pages/OpportunitiesPage'
import { AlpacaPaperPage } from '@/pages/AlpacaPaperPage'
import { StrategyLabPage } from '@/pages/StrategyLabPage'

type Tab = 'dashboard' | 'opportunities' | 'simulator' | 'research-lab' | 'alpaca-paper'
type AuthState =
  | { status: 'loading' }
  | { status: 'guest'; error?: string }
  | { status: 'authenticated'; username: string }

const TABS: { id: Tab; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'opportunities', label: 'Opportunities' },
  { id: 'simulator', label: 'Simulator' },
  { id: 'research-lab', label: 'Research Lab' },
  { id: 'alpaca-paper', label: 'Alpaca Paper' },
]

function LoginPage({ onAuthenticated, initialError }: {
  onAuthenticated: (username: string) => void
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
      onAuthenticated(json.data.username)
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
          <h1 className="mt-2 text-2xl font-bold text-foreground">Stock Dashboard</h1>
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
  const [activeTab, setActiveTab] = useState<Tab>('dashboard')
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' })

  useEffect(() => {
    let active = true
    fetch('/api/auth/session', { credentials: 'same-origin' })
      .then(async (response) => {
        const json = await response.json()
        if (!active) return
        if (response.ok && json.data?.authenticated) {
          setAuth({ status: 'authenticated', username: json.data.username })
        } else {
          setAuth({ status: 'guest' })
        }
      })
      .catch(() => {
        if (active) setAuth({ status: 'guest', error: 'Unable to reach the dashboard server.' })
      })
    return () => { active = false }
  }, [])

  async function logout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
    } finally {
      setActiveTab('dashboard')
      setAuth({ status: 'guest' })
    }
  }

  if (auth.status === 'loading') {
    return <main className="min-h-screen flex items-center justify-center bg-background text-sm text-muted-foreground">Securing dashboard…</main>
  }
  if (auth.status === 'guest') {
    return <LoginPage initialError={auth.error} onAuthenticated={(username) => setAuth({ status: 'authenticated', username })} />
  }

  return (
    <div>
      <nav className="sticky top-0 z-50 flex items-end gap-1 border-b border-border bg-background/90 backdrop-blur-sm px-4 pt-3 pb-0">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={[
              'px-4 py-1.5 text-sm rounded-t-md border border-b-0 transition-colors',
              activeTab === tab.id
                ? 'border-border bg-card text-foreground font-semibold'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            ].join(' ')}
          >
            {tab.label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-3 pb-1.5 pl-4 text-xs text-muted-foreground">
          <span>{auth.username}</span>
          <button
            type="button"
            onClick={() => void logout()}
            className="rounded-md border border-border px-2.5 py-1 transition-colors hover:border-primary hover:text-foreground"
          >
            Sign out
          </button>
        </div>
      </nav>

      <AnimatePresence mode="wait">
        <motion.div
          key={activeTab}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -12 }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
        >
          {activeTab === 'dashboard'
            ? <Dashboard />
            : activeTab === 'opportunities'
              ? <OpportunitiesPage />
              : activeTab === 'simulator'
                ? <SimulatorPage />
                : activeTab === 'research-lab'
                  ? <StrategyLabPage />
                  : <AlpacaPaperPage /> }
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

export default App
