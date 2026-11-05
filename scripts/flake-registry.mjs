#!/usr/bin/env node
// flake-registry: answer "is this red test mine, or a known flake?" with one lookup.
//
//   node scripts/flake-registry.mjs <test name or pasted failure line> [...]
//   node scripts/flake-registry.mjs --list          print the whole registry
//   node scripts/flake-registry.mjs --list-fields   what a lookup searches, and what a hit means
//   node scripts/flake-registry.mjs --validate      schema check (tests/unit/scripts/flakeRegistry.test.ts runs it too)
//   node scripts/flake-registry.mjs --update        move `:line` hints that sit above their test
//
// Or: pnpm flake:check <query> / pnpm flake:list / pnpm flake:fields.
//
// A hit is evidence for ATTRIBUTION, never permission: no red check becomes mergeable because of
// it. A `fixed` hit means the opposite of "ignore it": the cause was removed, so a fresh failure is
// a new defect, and the entry describes the old symptom so the two can be told apart.
//
// Exit codes are the branch point for a caller: 0 = a registered flake was identified,
// 1 = nothing identified (the failure is yours), 2 = the registry or the query is unusable.
//
// Matching. A query is folded (whitespace collapsed, lower case) and compared with `test`,
// `symptom`, `location`, `note` and `evidence`, in either direction: the field contains the query
// (a partial paste), or the query contains the whole field between word boundaries (a pasted log
// line around the name). What a match MEANS depends on where it landed:
//  - `test` is the name the runner prints; a match there identifies the flake.
//  - a PHRASE of at least MIN_PROSE_QUERY_LENGTH characters matching the prose fields identifies
//    it too: that is a pasted failure signature.
//  - a single token, or a short phrase, in prose is only a MENTION; so is any match in `location`
//    (a path says where a test lives, not which one failed). Mentions are printed as leads but
//    never set exit 0, so a directory or package name cannot read as "a known flake matches".

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REGISTRY_PATH = resolve(HERE, '..', '.github', 'flake-registry.json')
const ROOT = resolve(REGISTRY_PATH, '..', '..')

// Only `known-risk` renders `evidence`; the other statuses render `note` and the citation. So an
// entry promoted out of `known-risk` must move its evidence into `note`, or `--list` and a lookup
// show none of it. Check the rendered lookup, not the JSON.
/** Statuses and what each one licenses, in report order. */
export const STATUSES = {
  open: {
    blurb: 'KNOWN FLAKY, filed and unfixed',
    advice: 'Not yours. Cite the issue explicitly instead of silently re-running.',
  },
  'known-risk': {
    blurb: 'KNOWN RISK, diagnosed but NOT filed',
    advice: 'Someone judged this site fragile and recorded why. Treat the failure as unattributed: read the evidence, then decide. It excuses nothing on its own.',
  },
  fixed: {
    blurb: 'FIXED -- a fresh failure here is a NEW defect',
    advice: 'Do NOT wave this off. The cause was removed; the entry describes the OLD symptom so you can tell a regression from the original flake.',
  },
}

const nonEmpty = (v) => typeof v === 'string' && v.trim() !== ''
const positiveInt = (v) => Number.isInteger(v) && v > 0

/**
 * Parse and validate; throws on anything malformed. Strict on purpose: a registry that silently
 * drops a bad entry answers "not a known flake" for a test that is one.
 */
export function parseRegistry(text) {
  let doc
  try {
    doc = JSON.parse(text)
  } catch (err) {
    throw new Error(`not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) throw new Error('top level must be an object')
  if (!Array.isArray(doc.flakes)) throw new Error('`flakes` must be an array')

  const seen = new Map()
  doc.flakes.forEach((f, i) => {
    const at = `flakes[${i}]`
    if (typeof f !== 'object' || f === null || Array.isArray(f)) throw new Error(`${at}: must be an object`)
    if (!nonEmpty(f.test)) throw new Error(`${at}: \`test\` must be a non-empty string`)
    if (seen.has(f.test)) {
      throw new Error(`${at}: duplicate entry for ${f.test} (first at flakes[${seen.get(f.test)}]); one of the two would never be found`)
    }
    seen.set(f.test, i)
    if (!nonEmpty(f.suite)) throw new Error(`${at}: \`suite\` must be a non-empty string (e.g. "vitest", "ci")`)
    // `location` is what makes an entry checkable: a reader can go and read the assertion.
    if (!nonEmpty(f.location)) throw new Error(`${at}: \`location\` must be a non-empty string (path, optionally :line)`)
    for (const k of ['package', 'note', 'evidence']) {
      if (k in f && !nonEmpty(f[k])) throw new Error(`${at}: \`${k}\` must be a non-empty string when present`)
    }
    if (!Object.hasOwn(STATUSES, f.status)) {
      throw new Error(`${at}: \`status\` must be one of ${Object.keys(STATUSES).join(', ')}, got ${JSON.stringify(f.status)}`)
    }
    if (!nonEmpty(f.symptom)) {
      throw new Error(`${at}: \`symptom\` must be a non-empty string; without it a reader cannot tell this flake from a real failure in the same test`)
    }
    // `open` and `fixed` claim a tracked defect, so they cite one. `known-risk` is "looked at and
    // not filed": it carries `evidence` instead and may not cite an issue (it would blur into `open`).
    if (f.status === 'known-risk') {
      if (!nonEmpty(f.evidence)) throw new Error(`${at}: a \`known-risk\` entry needs \`evidence\` (where the judgement is recorded)`)
      for (const k of ['issue', 'also']) {
        if (k in f) throw new Error(`${at}: a \`known-risk\` entry must not cite an issue (\`${k}\`); file it and mark it \`open\` instead`)
      }
    } else if (!positiveInt(f.issue)) {
      throw new Error(`${at}: \`issue\` must be a positive integer for status \`${f.status}\``)
    }
    if (f.status === 'fixed' && !positiveInt(f.fixed_by)) {
      throw new Error(`${at}: a \`fixed\` entry must name the PR that fixed it in \`fixed_by\`; otherwise nobody can check the claim`)
    }
    if (f.status !== 'fixed' && 'fixed_by' in f) throw new Error(`${at}: \`fixed_by\` on a non-fixed entry (status \`${f.status}\`)`)
    if ('also' in f && (!Array.isArray(f.also) || !f.also.every(positiveInt))) {
      throw new Error(`${at}: \`also\` must be an array of positive issue numbers`)
    }
  })
  return doc.flakes
}

export function loadRegistry(path = REGISTRY_PATH) {
  try {
    return parseRegistry(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Error(`flake-registry: cannot load ${path}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ── location containment ────────────────────────────────────────────────────────────────

/**
 * Which identity shape an entry's `test` has:
 *  - `ci-step`      a job id plus the failing step (`suite: "ci"`); not a test, nothing to resolve.
 *  - `vitest-file`  `test` is a test file path; the entry names the whole file.
 *  - `vitest-name`  a `file > describe > it` path, as vitest prints it; its leaf is checked as text.
 * `dir-location` (a `location` that is a directory) is decided in resolveEntry.
 */
export function classifyEntry(f) {
  if (f.suite === 'ci') return 'ci-step'
  if (/\.(test|spec)\.(ts|tsx|js|mjs)$/.test(f.test)) return 'vitest-file'
  return 'vitest-name'
}

/** Split `location` into its path and its optional, advisory line. */
export function splitLocation(location) {
  const m = location.match(/^(.*):(\d+)$/)
  return m ? { path: m[1], line: Number(m[2]) } : { path: location, line: null }
}

/**
 * Check that the file `location` names really declares the test, so an entry cannot point at a
 * DIFFERENT test (a real line in a real file, which an exists-check cannot catch). Found by NAME,
 * not position: lines drift with every edit, so `:line` is only reported (`trueLine`), never a
 * failure. `test` and `location` need not name the same path: `test` is the lookup key, `location`
 * is where a reader goes to check the note.
 *
 * @param readText `(path) => string | null`, null when the path is not a readable file
 * @param isDir `(path) => boolean`
 * @returns `{ shape, verdict, trueLine, detail }`; verdict is RESOLVED | EXEMPT | UNRESOLVED | MISSING-FILE
 */
export function resolveEntry(f, readText, isDir) {
  const shape = classifyEntry(f)
  const { path } = splitLocation(f.location)
  if (isDir(path)) {
    return { shape: 'dir-location', verdict: 'EXEMPT', trueLine: null, detail: 'location names a directory - no file, no symbol to resolve' }
  }
  const src = readText(path)
  if (src === null) return { shape, verdict: 'MISSING-FILE', trueLine: null, detail: `no such file: ${path}` }
  if (shape === 'ci-step') return { shape, verdict: 'EXEMPT', trueLine: null, detail: 'suite:ci - a job step, not a test symbol' }
  if (shape === 'vitest-file') return { shape, verdict: 'EXEMPT', trueLine: null, detail: 'file-keyed - names a whole file, no symbol to resolve' }
  const leaf = f.test.split('>').map((s) => s.trim()).filter(Boolean).pop() ?? f.test
  const at = src.indexOf(leaf)
  if (at === -1) {
    return { shape, verdict: 'UNRESOLVED', trueLine: null, detail: `leaf name not found in ${path}: "${leaf.slice(0, 60)}" - is the location pointing at a different test?` }
  }
  return { shape, verdict: 'RESOLVED', trueLine: src.slice(0, at).split('\n').length, detail: 'name-keyed - matched as text' }
}

// ── lookup ──────────────────────────────────────────────────────────────────────────────

/** Below this a substring match is noise; a shorter query is refused (exit 2), not answered. */
export const MIN_QUERY_LENGTH = 8
/**
 * A phrase must be at least this long to identify a flake through the prose fields: notes share
 * boilerplate ("in isolation", "under load"), and a short phrase matching many entries names none.
 * This narrows the class, it does not close it; a query that matches many entries is a reading
 * list, not an attribution.
 */
export const MIN_PROSE_QUERY_LENGTH = 24

/** The fields a lookup searches, in report order. Identifiers and bookkeeping are not searched. */
export const SEARCH_FIELDS = ['test', 'symptom', 'location', 'note', 'evidence']
/** A match here names the flake rather than mentioning it. */
export const IDENTITY_FIELD = 'test'
const PLACE_FIELD = 'location'

const collapse = (s) => s.replace(/\s+/g, ' ').trim()
/** Both sides of a match are compared in this form, so a reflowed paste still matches. */
const fold = (s) => collapse(s).toLowerCase()

/** A phrase (two or more words) is a pasted signature; a single token is an identifier. */
export function isPhrase(query) {
  return collapse(query).includes(' ')
}

// Forward: the field contains the query. Reverse: the query contains the whole field, bounded on
// both sides, so `foo_bar` cannot claim a new `foo_bar_v2`. The reverse direction needs the field
// itself to clear MIN_QUERY_LENGTH, and tries every occurrence (a paste may carry the field once
// inside a longer identifier and once cleanly).
function fieldMatches(text, q) {
  const t = fold(text)
  if (t.includes(q)) return true
  if (t.length < MIN_QUERY_LENGTH) return false
  const boundary = (c) => c === undefined || !/[A-Za-z0-9_-]/.test(c)
  for (let at = q.indexOf(t); at !== -1; at = q.indexOf(t, at + 1)) {
    if (boundary(q[at - 1]) && boundary(q[at + t.length])) return true
  }
  return false
}

/** Which SEARCH_FIELDS the entry matches the (already length-checked) query in. */
export function matchedFields(f, query) {
  const q = fold(query)
  if (!q) return []
  return SEARCH_FIELDS.filter((k) => typeof f[k] === 'string' && fieldMatches(f[k], q))
}

/** Does a match identify the flake, or merely mention it? See the header. */
export function identifiesFlake(fields, query) {
  if (fields.includes(IDENTITY_FIELD)) return true
  const q = fold(query)
  return q.length >= MIN_PROSE_QUERY_LENGTH && isPhrase(q) && fields.some((k) => k !== PLACE_FIELD)
}

function normalizeQuery(query) {
  const q = fold(query)
  if (!q) return null
  if (q.length < MIN_QUERY_LENGTH) {
    throw new Error(`query ${JSON.stringify(query)} is too short (< ${MIN_QUERY_LENGTH} chars) to identify a test. Pass the test name as the runner printed it, or use --list.`)
  }
  return q
}

/** Entries the query IDENTIFIES. Throws on a query too short to discriminate. */
export function findFlakes(flakes, query) {
  const q = normalizeQuery(query)
  if (q === null) return []
  return flakes.filter((f) => identifiesFlake(matchedFields(f, q), q))
}

/** Entries the query only MENTIONS; disjoint from findFlakes. */
export function findMentions(flakes, query) {
  const q = normalizeQuery(query)
  if (q === null) return []
  return flakes.filter((f) => {
    const fields = matchedFields(f, q)
    return fields.length > 0 && !identifiesFlake(fields, q)
  })
}

const EXCERPT_CHARS = 72

/**
 * A window of `field` around the query, cut over code points (never through a surrogate pair).
 * When the query is not found per code point (a reverse match, or a fold that changes length),
 * the field's opening is shown: the window may be early, never beside the match.
 */
export function excerpt(field, query) {
  const cps = Array.from(collapse(field))
  const needle = Array.from(query)
  let at = -1
  for (let i = 0; i + needle.length <= cps.length && at === -1; i += 1) {
    if (needle.every((c, j) => cps[i + j].toLowerCase() === c)) at = i
  }
  const from = at === -1 ? 0 : Math.max(0, at - Math.floor(EXCERPT_CHARS / 2))
  const to = Math.min(cps.length, from + EXCERPT_CHARS + (at === -1 ? 0 : needle.length))
  return `${from > 0 ? '…' : ''}${cps.slice(from, to).join('')}${to < cps.length ? '…' : ''}`
}

function render(f, matched, query) {
  const s = STATUSES[f.status]
  const cite = f.status === 'known-risk'
    ? `evidence: ${f.evidence}`
    : `#${f.issue}${f.also?.length ? ` (also ${f.also.map((n) => `#${n}`).join(', ')})` : ''}${f.status === 'fixed' ? `, fixed by #${f.fixed_by}` : ''}`
  return [
    `  ${f.test}`,
    matched ? `    matched: ${matched.join(', ')}` : null,
    `    status:  ${f.status} -- ${s.blurb}`,
    `    suite:   ${f.suite}${f.package ? ` (${f.package})` : ''}`,
    `    at:      ${f.location}`,
    `    cite:    ${cite}`,
    `    symptom: ${f.symptom}`,
    f.note ? `    note:    ${f.note}` : null,
    // A hit can rest on `evidence`, which is otherwise shown only for known-risk.
    matched?.includes('evidence') && f.status !== 'known-risk' && query ? `    evidence: ${excerpt(f.evidence, fold(query))}` : null,
    `    -> ${s.advice}`,
  ].filter(Boolean).join('\n')
}

function mentionLine(f, query) {
  const q = fold(query)
  return [`  ${f.test}`, ...matchedFields(f, q).map((k) => `    matched: ${k} -- ${excerpt(f[k], q)}`)].join('\n')
}

function fieldHelp() {
  return [
    'flake-registry: what a query searches, and what a hit means',
    '',
    '  test       the name the runner prints. A hit IDENTIFIES the flake; a partial paste counts,',
    '             a path component included, so read the list it returns.',
    '  symptom    the recorded failure signature. A PHRASE hit (two or more words, at least',
    `  note       ${MIN_PROSE_QUERY_LENGTH} characters) identifies the flake too; a single token or a shorter phrase`,
    '  evidence   here is reported as a MENTION.',
    '  location   ALWAYS a mention: a path says where a test LIVES, never which one failed.',
    '',
    '  Matching is a case-insensitive substring in EITHER direction (a partial paste of a field, or',
    `  a field inside a longer pasted line), whitespace-folded. A query below ${MIN_QUERY_LENGTH} characters is`,
    '  refused. A query matching MANY entries is a reading list, not an attribution.',
    '',
    '  NOT searched: package, suite, job, status, issue, fixed_by, also. They are identifiers and',
    '  bookkeeping: matching one would return every entry for a package as "a known flake".',
  ].join('\n')
}

function readText(p) {
  const abs = resolve(ROOT, p)
  return existsSync(abs) && !statSync(abs).isDirectory() ? readFileSync(abs, 'utf8') : null
}
function isDir(p) {
  const abs = resolve(ROOT, p)
  return existsSync(abs) && statSync(abs).isDirectory()
}

function main(argv) {
  // Documents the tool, not the data, so it answers even when the registry will not load.
  if (argv.includes('--list-fields')) {
    console.log(fieldHelp())
    return 0
  }
  let flakes
  try {
    flakes = loadRegistry()
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    return 2
  }
  if (argv.includes('--validate')) {
    console.log(`flake-registry: OK -- ${flakes.length} entries, schema valid.`)
    return 0
  }
  if (argv.includes('--update')) {
    // Moves a hint only when it sits ABOVE its own declaration (it then points into whatever
    // precedes the test). A hint at or below the declaration may deliberately name the failing
    // assertion, so it is left alone.
    const raw = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'))
    let moved = 0
    for (const f of raw.flakes) {
      const { path, line } = splitLocation(f.location)
      if (line === null) continue
      const r = resolveEntry(f, readText, isDir)
      if (r.verdict !== 'RESOLVED' || r.trueLine === null || line >= r.trueLine) continue
      console.log(`  ${f.test}\n    ${line} -> ${r.trueLine}  (hint was above the declaration)`)
      f.location = `${path}:${r.trueLine}`
      moved += 1
    }
    if (moved === 0) {
      console.log('flake-registry: no advisory hint is provably stale; nothing to do.')
      return 0
    }
    writeFileSync(REGISTRY_PATH, `${JSON.stringify(raw, null, 2)}\n`)
    console.log(`flake-registry: refreshed ${moved} advisory line hint(s).`)
    return 0
  }
  if (argv.includes('--list')) {
    for (const f of flakes) console.log(`${render(f)}\n`)
    return 0
  }

  // Blank arguments are dropped: an empty query must not get the confident "this is yours".
  const queries = argv.filter((a) => !a.startsWith('--') && a.trim() !== '')
  if (queries.length === 0) {
    console.error('usage: node scripts/flake-registry.mjs <test-name-or-phrase> [...]\n       node scripts/flake-registry.mjs --list | --list-fields | --validate | --update')
    return 2
  }
  let anyHit = false
  for (const q of queries) {
    let hits
    let mentions
    try {
      hits = findFlakes(flakes, q)
      mentions = findMentions(flakes, q)
    } catch (err) {
      // Too vague is operator error (2), never "not a known flake" (1).
      console.error(`flake-registry: ${err instanceof Error ? err.message : String(err)}`)
      return 2
    }
    if (hits.length === 0 && mentions.length === 0) {
      console.log(`NOT REGISTERED: ${q}`)
      console.log('  No known flake matches. Treat the failure as YOURS until you have evidence\n  otherwise -- and if you prove it pre-existing, add it here so the next\n  person does not repeat the investigation.\n')
      continue
    }
    if (hits.length > 0) {
      anyHit = true
      console.log(`MATCH (${hits.length}) for: ${q}`)
      for (const f of hits) console.log(`${render(f, matchedFields(f, q), q)}\n`)
    }
    if (mentions.length > 0) {
      console.log(`MENTIONED IN (${mentions.length}) for: ${q}`)
      console.log('  A mention is a LEAD, not an attribution: the string appears in these entries\n  without identifying your failure as one of them.\n')
      for (const f of mentions) console.log(`${mentionLine(f, q)}\n`)
    }
  }
  return anyHit ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2))
}
