import { useState } from 'react'
import type { FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import type { OperatorSecurity } from '@/hooks/useAlpacaLive'

export function LiveActionVerification({ security, verified, error, onVerified }: {
  security?: OperatorSecurity
  verified: boolean
  error?: Error | null
  onVerified: () => Promise<unknown>
}) {
  const [password, setPassword] = useState('')
  const [otp, setOtp] = useState('')
  const [failure, setFailure] = useState('')
  const [pending, setPending] = useState(false)
  async function submit(event: FormEvent) {
    event.preventDefault()
    setPending(true); setFailure('')
    try {
      const response = await fetch('/api/auth/reauthenticate', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, otp }),
      })
      const json = await response.json()
      if (!response.ok || json.status !== 'success') throw new Error(json.error || 'Unable to verify. Try a new authenticator code.')
      await onVerified()
    } catch (error) { setFailure(error instanceof Error ? error.message : 'Unable to verify your sign-in.') }
    finally { setPassword(''); setOtp(''); setPending(false) }
  }
  return <section aria-labelledby="live-verification-heading" className="rounded-xl border border-border bg-card p-4 sm:p-6">
    <h2 id="live-verification-heading" className="text-lg font-semibold">Verify live actions</h2>
    <p className="mt-1 text-sm text-muted-foreground">Changing live settings, submitting orders and adopting holdings require a recent password and authenticator check. Pausing new orders and canceling orders remain available.</p>
    {error && <p role="alert" className="mt-3 text-sm text-destructive">{error.message}</p>}
    {!security && !error && <p role="status" className="mt-3 text-sm text-muted-foreground">Checking verification status…</p>}
    {security && !security.mfaConfigured && <p role="status" className="mt-3 text-sm text-amber-700 dark:text-amber-300">Set up an authenticator on the server before authorizing live actions.</p>}
    {verified && <p role="status" className="mt-3 text-sm">Verified until {new Date(security!.recentAuthUntil!).toLocaleTimeString()}. Review and submit each action yourself.</p>}
    {security?.mfaConfigured && !verified && <form className="mt-4 grid max-w-xl gap-3 sm:grid-cols-2" onSubmit={submit}>
      <label className="text-sm">Verify password<input className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} /></label>
      <label className="text-sm">Authenticator code<input className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required value={otp} onChange={e => setOtp(e.target.value.replace(/\D/g, ''))} /></label>
      <div className="sm:col-span-2"><Button type="submit" disabled={pending}>{pending ? 'Verifying…' : 'Verify for five minutes'}</Button></div>
    </form>}
    {failure && <p role="alert" className="mt-3 text-sm text-destructive">{failure}</p>}
  </section>
}
