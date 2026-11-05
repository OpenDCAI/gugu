#!/usr/bin/env node
// Look up a red CI test in .github/flake-registry.json.
//
// Attribution only: a match tells you the failure's history, it never makes a red check acceptable.
// A match on a fixed entry means the cause came back or is new: treat it as a defect, not a flake.
//
// Usage: node scripts/flake-check.mjs <test name, file path or error text>

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const registryPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.github/flake-registry.json')
const FIELDS = ['test', 'file', 'symptom', 'status', 'fixPr', 'firstRun']

function load() {
  const { flakes } = JSON.parse(fs.readFileSync(registryPath, 'utf8'))
  flakes.forEach((f, i) => {
    const bad = (why) => { throw new Error(`flake-registry.json entry ${i} (${f.test}): ${why}`) }
    for (const k of FIELDS) if (!(k in f)) bad(`missing "${k}"`)
    if (f.status !== 'open' && f.status !== 'fixed') bad(`status must be "open" or "fixed", got ${JSON.stringify(f.status)}`)
    if (f.status === 'fixed' && !Number.isInteger(f.fixPr)) bad('a fixed entry names the PR that removed the cause')
  })
  return flakes
}

const flakes = load()
const query = process.argv.slice(2).join(' ').trim()
if (!query) {
  console.error('usage: node scripts/flake-check.mjs <test name, file path or error text>')
  process.exit(2)
}

const q = query.toLowerCase()
const hits = flakes.filter(f =>
  [f.test, f.file, f.symptom].some(s => s.toLowerCase().includes(q)) ||
  (f.file.endsWith('/') && q.startsWith(f.file.toLowerCase())),
)

if (hits.length === 0) {
  console.log(`No registered flake matches "${query}". Treat the failure as real.`)
  process.exit(1)
}
for (const f of hits) {
  const verdict = f.status === 'fixed'
    ? `FIXED in #${f.fixPr}: failing again means a new defect; investigate, do not rerun.`
    : `OPEN${f.fixPr ? ` (fix in #${f.fixPr})` : ''}: known, not yet root-caused. Attribution only; the check is still red.`
  console.log(`${f.test}\n  file:    ${f.file}\n  status:  ${verdict}\n  symptom: ${f.symptom}\n  first:   ${f.firstRun ?? 'not recorded'}\n`)
}
