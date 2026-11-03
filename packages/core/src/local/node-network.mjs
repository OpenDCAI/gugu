import { getDefaultAutoSelectFamilyAttemptTimeout, setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net'

/** Keep dual-stack fallback without abandoning slower TCP handshakes after Node's 250 ms default. */
export function configureNodeNetwork() {
  const current = getDefaultAutoSelectFamilyAttemptTimeout()
  if (current < 2000) setDefaultAutoSelectFamilyAttemptTimeout(2000)
}
