import { expect, it } from 'vitest'
import { displayIdentityFromRow } from '../../../../apps/desktop/src/lib/displayIdentity'
import { displayIdentity } from '../../../support/testHarness'

it('reads stable serial metadata without changing the identity name', () => {
  const row = { ...displayIdentity('agent', { type: 'agent', display_name: 'Fix login' }), name_serial: 93 }
  const identity = displayIdentityFromRow(row)
  expect(identity).toMatchObject({ id: 'agent', display_name: 'Fix login', nameSerial: 93 })
  expect(displayIdentityFromRow(identity)).toEqual(identity)
  expect(displayIdentityFromRow({ ...row, name_serial: null }).nameSerial).toBeNull()
  expect(() => displayIdentityFromRow({ ...row, name_serial: 0 })).toThrow()
})
