import { getDefaultAutoSelectFamilyAttemptTimeout, setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net'

/** Keep dual-stack fallback, but let a mobile TCP handshake take longer than Node's 250 ms default. */
export function configurePhoneNetwork() {
  const current = getDefaultAutoSelectFamilyAttemptTimeout()
  if (current < 2000) setDefaultAutoSelectFamilyAttemptTimeout(2000)
}
