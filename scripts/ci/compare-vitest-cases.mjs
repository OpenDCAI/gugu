import { readFileSync, readdirSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Compare logical case IDs as multisets: parameterized tests may intentionally share a name. */
export function caseInventory(reports, root) {
  const cases = new Map(), files = new Set(), statuses = {}
  let healthy = true
  for (const report of reports) {
    if (!Array.isArray(report.testResults)) throw new Error('Not a Vitest JSON report')
    if (report.testResults.length === 0 || !(report.numTotalTests > 0)) throw new Error('Empty shard report cannot prove test coverage')
    healthy &&= report.success === true && report.numFailedTests === 0 && report.numFailedTestSuites === 0
    let count = 0
    for (const module of report.testResults) {
      const file = relative(resolve(root), module.name)
      if (isAbsolute(file) || file === '..' || file.startsWith(`..${sep}`)) throw new Error(`Test file outside source root: ${module.name}`)
      if (files.has(file)) throw new Error(`Test file executed in more than one report: ${file}`)
      files.add(file)
      if (!Array.isArray(module.assertionResults)) throw new Error(`Missing cases: ${file}`)
      healthy &&= module.status === 'passed'
      for (const test of module.assertionResults) {
        if (!test.fullName || !['passed', 'failed', 'pending', 'todo', 'skipped'].includes(test.status)) throw new Error(`Invalid case: ${file}`)
        const id = JSON.stringify([file.split(sep).join('/'), test.fullName])
        const key = JSON.stringify([id, test.status])
        cases.set(key, (cases.get(key) ?? 0) + 1)
        statuses[test.status] = (statuses[test.status] ?? 0) + 1
        healthy &&= test.status !== 'failed' && test.status !== 'pending'
        count++
      }
    }
    if (count !== report.numTotalTests) throw new Error(`Report case total mismatch: ${count} != ${report.numTotalTests}`)
  }
  return { cases, files: [...files].sort(), statuses, healthy, reports: reports.length }
}

export function compareCaseInventories(baseline, candidate) {
  const changes = [...new Set([...baseline.cases.keys(), ...candidate.cases.keys()])].sort()
    .flatMap(key => {
      const before = baseline.cases.get(key) ?? 0, after = candidate.cases.get(key) ?? 0
      const [id, status] = JSON.parse(key)
      return before === after ? [] : [{ id: JSON.parse(id), status, baseline: before, candidate: after }]
    })
  const sameFiles = JSON.stringify(baseline.files) === JSON.stringify(candidate.files)
  const identities = inventory => {
    const counts = new Map()
    for (const [key, count] of inventory.cases) {
      const [id] = JSON.parse(key)
      counts.set(id, (counts.get(id) ?? 0) + count)
    }
    return JSON.stringify([...counts].sort(([a], [b]) => a.localeCompare(b)))
  }
  const sameCases = identities(baseline) === identities(candidate)
  const sameSkips = !changes.some(change => ['skipped', 'todo'].includes(change.status))
  const summary = inventory => ({ reports: inventory.reports, files: inventory.files.length, statuses: inventory.statuses, healthy: inventory.healthy })
  return { equal: sameFiles && changes.length === 0, healthy: baseline.healthy && candidate.healthy,
    sameFiles, sameCases, sameSkips, baseline: summary(baseline), candidate: summary(candidate), changes }
}

function readReports(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name)
    return entry.isDirectory() ? readReports(path) : entry.name.endsWith('.json') ? [JSON.parse(readFileSync(path, 'utf8'))] : []
  })
}

function main() {
  const [before, after, root, expectedCount] = process.argv.slice(2)
  if (!before || !after || !root || !/^[1-9]\d*$/.test(expectedCount ?? '')) throw new Error('Usage: compare-vitest-cases.mjs baseline-dir candidate-dir source-root expected-report-count')
  const baseline = caseInventory(readReports(before), root), candidate = caseInventory(readReports(after), root)
  const result = compareCaseInventories(baseline, candidate)
  result.complete = baseline.reports === Number(expectedCount) && candidate.reports === Number(expectedCount)
  console.log(JSON.stringify(result, null, 2))
  process.exitCode = result.complete && result.equal && result.healthy ? 0 : 1
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
