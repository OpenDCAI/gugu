import { afterEach, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { runInThisContext } from 'node:vm'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { errorSummaryStackLocations } from '../../apps/desktop/shared/error-summary-stack'

const initialFormatter = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace')
afterEach(() => {
  if (initialFormatter) Object.defineProperty(Error, 'prepareStackTrace', initialFormatter)
  else Reflect.deleteProperty(Error, 'prepareStackTrace')
})

function thrown(message = 'ordinary') {
  // Vitest runs in a separate realm. Pass its constructor into a real script so
  // the runtime getter belongs to the same realm as the production extractor.
  const code = `(function originalThrowSite(ErrorType){ throw new ErrorType(${JSON.stringify(message)}); })`
  const throwError = runInThisContext(code, { filename: 'apps/desktop/electron/summary-throw.js' }) as (constructor: typeof TypeError) => never
  try { throwError(TypeError) } catch (error) {
    return { error: error as Error, location: `apps/desktop/electron/summary-throw.js:1:${code.indexOf('new ErrorType') + 1}` }
  }
  throw new Error('Fixture did not throw')
}

it('captures the real first throw frame, never a message-shaped account path', () => {
  const { error, location } = thrown('private\n    at account (apps/desktop/src/accounts/alice/account-1234.ts:12:3)')
  const locations = errorSummaryStackLocations(error)
  expect(locations[0]).toBe(location)
  expect(locations.join()).not.toMatch(/alice|account-1234|private/)
  expect(errorSummaryStackLocations(error)).toEqual(locations)
})

it.each(['getter', 'function'])('never calls tampered error fields or a prepareStackTrace %s', kind => {
  const { error, location } = thrown()
  const getter = vi.fn(() => { throw new Error('private getter ran') })
  for (const key of ['name', 'message', 'constructor']) Object.defineProperty(error, key, { get: getter })
  const prepare = vi.fn(() => { throw new Error('private formatter ran') })
  Object.defineProperty(Error, 'prepareStackTrace', kind === 'getter'
    ? { get: prepare, configurable: true, enumerable: true }
    : { value: prepare, configurable: true, writable: true })
  const before = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace')
  let locations: string[], after: PropertyDescriptor | undefined
  try {
    locations = errorSummaryStackLocations(error)
    after = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace')
  } finally {
    if (initialFormatter) Object.defineProperty(Error, 'prepareStackTrace', initialFormatter)
    else Reflect.deleteProperty(Error, 'prepareStackTrace')
  }
  expect(locations[0]).toBe(location)
  expect(getter).not.toHaveBeenCalled()
  expect(prepare).not.toHaveBeenCalled()
  expect(after).toEqual(before)
})

it('ignores custom stack getters and forged data stacks', () => {
  const getter = vi.fn(() => 'Error\n at apps/desktop/src/accounts/alice/account-1234.ts:12:3')
  const { error } = thrown()
  Object.defineProperty(error, 'stack', { get: getter, configurable: true })
  expect(errorSummaryStackLocations(error)).toEqual([])
  expect(getter).not.toHaveBeenCalled()
  Object.defineProperty(error, 'stack', { value: getter(), configurable: true })
  getter.mockClear()
  expect(errorSummaryStackLocations(error)).toEqual([])
  expect(getter).not.toHaveBeenCalled()
})

it('does not trust a stack already cached by another formatter', () => {
  const { error } = thrown()
  const prepare = vi.fn(() => 'Error\n at apps/desktop/src/accounts/alice/account-1234.ts:12:3')
  Object.defineProperty(Error, 'prepareStackTrace', { value: prepare, configurable: true, writable: true })
  void error.stack
  prepare.mockClear()
  expect(errorSummaryStackLocations(error)).toEqual([])
  expect(prepare).not.toHaveBeenCalled()
})

it.each(['0.5.13', '0.5.21'])('restores source-map-support %s in the same realm and permits later strict-mode installation', version => {
  // Both versions are existing pinned transitive dependencies; never install here.
  const require = createRequire(import.meta.url)
  const store = resolve(dirname(realpathSync(require.resolve('vitest/package.json'))), '../../..')
  const script = fileURLToPath(new URL('./error-summary-stack-child.cjs', import.meta.url))
  const summary = fileURLToPath(new URL('../../apps/desktop/shared/error-summary.ts', import.meta.url))
  const stack = fileURLToPath(new URL('../../apps/desktop/shared/error-summary-stack.ts', import.meta.url))
  const result = JSON.parse(execFileSync(process.execPath, [script, join(store, `source-map-support@${version}`, 'node_modules/source-map-support'), summary, stack], { encoding: 'utf8', timeout: 10_000, env: { ...process.env, NODE_NO_WARNINGS: '1' } }))
  expect(result).toMatchObject({ location: 'apps/desktop/electron/summary-throw.js:1:12', protectedLocation: 'apps/desktop/electron/summary-throw.js:1:12', getterCalls: 0, prepareCalls: 0, restoredAccessor: true, restoredLibrary: true, unrelatedFormatted: true, laterAssignment: true, freshEmpty: 0, freshTotal: 20, formattedEmpty: 20, formattedTotal: 20 })
})

it('measures a controlled 20 fresh / 20 previously formatted sample, not a production rate', () => {
  const fresh = Array.from({ length: 20 }, () => thrown().error)
  const formatted = Array.from({ length: 20 }, () => { const { error } = thrown(); void error.stack; return error })
  expect(fresh.filter(error => errorSummaryStackLocations(error).length === 0)).toHaveLength(0)
  expect(formatted.filter(error => errorSummaryStackLocations(error).length === 0)).toHaveLength(20)
})
