import { afterEach, expect, it, vi } from 'vitest'
import { createErrorSummaryErrorEventReader } from '../../apps/desktop/src/lib/errorSummaryErrorEvent'
import { SummaryErrorEvent } from './error-summary-event-fixture'

afterEach(() => vi.unstubAllGlobals())
function reader() { vi.stubGlobal('ErrorEvent', SummaryErrorEvent); return createErrorSummaryErrorEventReader() }

it('uses the browser throw location even when an earlier logger cached the error stack', () => {
  const read = reader(), error = new Error('private')
  void error.stack
  expect(read(new SummaryErrorEvent('error', { trusted: true, error, filename: 'gugu-app://app/assets/main-abcd.js', lineno: 12, colno: 3 }))?.locations).toEqual(['dist/assets/main-abcd.js:12:3'])
})

it('ignores event-owned replacement getters and never inspects the original error', () => {
  const read = reader(), getter = vi.fn(() => { throw new Error('must not run') })
  const error = new Error('private')
  for (const key of ['stack', 'message', 'name']) Object.defineProperty(error, key, { get: getter })
  const event = new SummaryErrorEvent('error', { trusted: true, error, filename: 'gugu-app://app/assets/main-abcd.js', lineno: 12, colno: 3 })
  for (const key of ['error', 'filename', 'lineno', 'colno']) Object.defineProperty(event, key, { get: getter })
  expect(read(event)?.locations).toEqual(['dist/assets/main-abcd.js:12:3'])
  expect(getter).not.toHaveBeenCalled()
})

it.each(['apps/desktop/src/accounts/alice/account-1234.ts', 'gugu-app://app/assets/main-abcd.js?email=alice@example.test', 'https://evil.test/assets/main-abcd.js'])('rejects non-bundle or private event filenames: %s', filename => {
  expect(reader()(new SummaryErrorEvent('error', { trusted: true, filename, lineno: 12, colno: 3 }))?.locations).toEqual([])
})

it('rejects synthetic events and objects pretending to be browser events', () => {
  const read = reader()
  expect(read(new SummaryErrorEvent('error', { trusted: false, filename: 'gugu-app://app/assets/main-abcd.js', lineno: 12, colno: 3 }))).toBeNull()
  expect(read({ isTrusted: true, filename: 'gugu-app://app/assets/main-abcd.js', lineno: 12, colno: 3 })).toBeNull()
})
