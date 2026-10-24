import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getDefaultAutoSelectFamilyAttemptTimeout, setDefaultAutoSelectFamilyAttemptTimeout, getDefaultAutoSelectFamily } from 'node:net'
import { getDefaultResultOrder } from 'node:dns'
import { configurePhoneNetwork } from './phone-network.mjs'

test('mobile connection startup allows slow address-family handshakes without disabling IPv6 or shortening an existing larger window', () => {
  const before = getDefaultAutoSelectFamilyAttemptTimeout()
  const familySelection = getDefaultAutoSelectFamily()
  const dnsOrder = getDefaultResultOrder()
  try {
    setDefaultAutoSelectFamilyAttemptTimeout(250)
    configurePhoneNetwork()
    assert.equal(getDefaultAutoSelectFamilyAttemptTimeout(), 2000)
    setDefaultAutoSelectFamilyAttemptTimeout(5000)
    configurePhoneNetwork()
    assert.equal(getDefaultAutoSelectFamilyAttemptTimeout(), 5000)
    assert.equal(getDefaultAutoSelectFamily(), familySelection)
    assert.equal(getDefaultResultOrder(), dnsOrder)
  } finally { setDefaultAutoSelectFamilyAttemptTimeout(before) }
})
