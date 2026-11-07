// A real single Node/Electron realm: CommonJS libraries and the extractor share
// the same Error constructor, unlike Vitest's isolated test realm.
const { readFileSync } = require('node:fs')
const { stripTypeScriptTypes } = require('node:module')
const { runInThisContext } = require('node:vm')
const uri = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
const summary = uri(stripTypeScriptTypes(readFileSync(process.argv[3], 'utf8')))
const stack = stripTypeScriptTypes(readFileSync(process.argv[4], 'utf8')).replace("'./error-summary'", JSON.stringify(summary))
const throwError = runInThisContext('()=>{throw new Error("ordinary")}', { filename: 'apps/desktop/electron/summary-throw.js' })
function thrown() {
  // Call outside runInThisContext: Node decorates/caches errors escaping vm.run.
  try { throwError() } catch (error) { return error }
  throw new Error('Fixture did not throw')
}
async function main() {
  const { errorSummaryStackLocations } = await import(uri(stack))
  const support = require(process.argv[2])
  support.install({ handleUncaughtExceptions: false })
  const library = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace')
  const location = errorSummaryStackLocations(thrown())[0]
  const restoredLibrary = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace').value === library.value
  const unrelatedFormatted = new Error('ordinary').stack.includes('ordinary')
  let getterCalls = 0, prepareCalls = 0
  const error = thrown()
  for (const key of ['name', 'message', 'constructor']) Object.defineProperty(error, key, { get() { getterCalls++; throw new Error('must not run') } })
  Object.defineProperty(Error, 'prepareStackTrace', { configurable: true, get() { prepareCalls++; throw new Error('must not run') } })
  const protectedLocation = errorSummaryStackLocations(error)[0]
  const restoredAccessor = typeof Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace').get === 'function'
  Object.defineProperty(Error, 'prepareStackTrace', library)
  const fresh = Array.from({ length: 20 }, thrown)
  const formatted = Array.from({ length: 20 }, () => { const value = thrown(); void value.stack; return value })
  const freshEmpty = fresh.filter(value => errorSummaryStackLocations(value).length === 0).length
  const formattedEmpty = formatted.filter(value => errorSummaryStackLocations(value).length === 0).length
  ;(function laterLibrary() { 'use strict'; Error.prepareStackTrace = () => 'next formatter' })()
  console.log(JSON.stringify({ electron: process.versions.electron, location, protectedLocation, getterCalls, prepareCalls, restoredAccessor, restoredLibrary, unrelatedFormatted, laterAssignment: Error.prepareStackTrace() === 'next formatter', freshEmpty, freshTotal: 20, formattedEmpty, formattedTotal: 20 }))
}
main().catch(error => { console.error(error); process.exitCode = 1 })
