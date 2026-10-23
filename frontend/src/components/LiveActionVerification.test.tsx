import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { LiveActionVerification } from './LiveActionVerification'

afterEach(() => vi.unstubAllGlobals())
describe('Live action verification', () => {
  it('only refreshes authorization after verification and clears entered credentials', async () => {
    const onVerified = vi.fn().mockResolvedValue(undefined)
    const request = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'success' }) })
    vi.stubGlobal('fetch', request)
    render(<LiveActionVerification security={{ authenticated: true, mfaConfigured: true, recentMfa: false, recentAuthUntil: null }} verified={false} onVerified={onVerified} />)
    fireEvent.change(screen.getByLabelText('Verify password'), { target: { value: 'fictional-password' } })
    fireEvent.change(screen.getByLabelText('Authenticator code'), { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: 'Verify for five minutes' }))
    await waitFor(() => expect(onVerified).toHaveBeenCalledOnce())
    expect(request).toHaveBeenCalledExactlyOnceWith('/api/auth/reauthenticate', expect.objectContaining({ method: 'POST', credentials: 'same-origin', body: JSON.stringify({ password: 'fictional-password', otp: '123456' }) }))
    expect(screen.getByLabelText('Verify password')).toHaveValue('')
    expect(screen.getByLabelText('Authenticator code')).toHaveValue('')
  })
  it('does not refresh authorization after refused verification', async () => {
    const onVerified = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({ status: 'error', error: 'Use a new authenticator code.' }) }))
    render(<LiveActionVerification security={{ authenticated: true, mfaConfigured: true, recentMfa: false, recentAuthUntil: null }} verified={false} onVerified={onVerified} />)
    fireEvent.change(screen.getByLabelText('Verify password'), { target: { value: 'fictional-password' } })
    fireEvent.change(screen.getByLabelText('Authenticator code'), { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: 'Verify for five minutes' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Use a new authenticator code.')
    expect(onVerified).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Verify password')).toHaveValue('')
  })
})
