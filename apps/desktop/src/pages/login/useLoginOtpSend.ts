import { useEffect, useRef, useState } from 'react'
import { authService } from '../../lib/auth'
import { userVisibleAuthError } from '../../lib/authErrors'

type SendingState = { phase: 'idle' | 'sending' | 'sent' | 'failed'; email: string; error?: string; retryAt: number }
const idle: SendingState = { phase: 'idle', email: '', retryAt: 0 }

export function useLoginOtpSend() {
  const [state, setState] = useState(idle)
  const [now, setNow] = useState(Date.now)
  const attempt = useRef(0)
  const flight = useRef<Promise<void> | null>(null)
  const cooldowns = useRef(new Map<string, SendingState>())
  useEffect(() => () => { attempt.current++ }, [])
  useEffect(() => {
    if (state.retryAt <= Date.now()) return
    const tick = () => setNow(Date.now())
    const timer = setInterval(tick, 1000)
    window.addEventListener('focus', tick)
    return () => { clearInterval(timer); window.removeEventListener('focus', tick) }
  }, [state.retryAt])

  function reset() {
    attempt.current++
    flight.current = null
    setState(idle)
  }
  function send(email: string): Promise<void> {
    if (flight.current) return flight.current
    const previous = cooldowns.current.get(email)
    const retryAt = previous?.retryAt ?? 0
    const started = Date.now()
    if (retryAt > started) {
      setNow(started)
      setState(previous!)
      return Promise.resolve()
    }
    const id = ++attempt.current
    setNow(started)
    setState({ phase: 'sending', email, retryAt: 0 })
    const request = Promise.resolve().then(() => authService.requestLoginOtp(email)).catch((error: unknown) => ({ success: false, error: userVisibleAuthError(error, 'sendOtp'), retryAfterSeconds: undefined })).then(result => {
      const finished = Date.now()
      // Keep the established 60-second successful-send cooldown, also across email edits.
      const next = result.success ? finished + 60_000
        : Math.max(cooldowns.current.get(email)?.retryAt ?? 0, finished + (result.retryAfterSeconds ?? 0) * 1000)
      const settled: SendingState = { phase: result.success ? 'sent' : 'failed', email, error: result.error, retryAt: next }
      cooldowns.current.set(email, settled)
      if (id !== attempt.current) return
      setNow(finished)
      setState(settled)
    }).finally(() => { if (id === attempt.current) flight.current = null })
    flight.current = request
    return request
  }
  return { ...state, countdown: Math.max(0, Math.ceil((state.retryAt - now) / 1000)), send, reset }
}
