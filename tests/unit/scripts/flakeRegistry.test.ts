// The flake registry's schema guard and lookup rules. The registry is only useful if it is
// trustworthy at a glance, and its value is in hand-typed fields, so every shape that would make
// it lie is pinned here by MUTATING a valid registry: a validator that silently accepts is
// indistinguishable from no validator.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  excerpt,
  findFlakes,
  findMentions,
  IDENTITY_FIELD,
  isPhrase,
  matchedFields,
  MIN_PROSE_QUERY_LENGTH,
  MIN_QUERY_LENGTH,
  parseRegistry,
  REGISTRY_PATH,
  resolveEntry,
  SEARCH_FIELDS,
  splitLocation,
  STATUSES,
  type FlakeEntry,
} from '../../../scripts/flake-registry.mjs'

const RAW = readFileSync(REGISTRY_PATH, 'utf8')
const ROOT = resolve(REGISTRY_PATH, '..', '..')
const CLI = resolve(ROOT, 'scripts/flake-registry.mjs')

type Doc = { flakes: Record<string, unknown>[] }
function valid(): Doc {
  return {
    flakes: [{
      test: 'tests/unit/some/area.test.ts > some describe > some case',
      suite: 'vitest',
      package: 'gugu',
      location: 'tests/unit/some/area.test.ts:42',
      status: 'open',
      issue: 1234,
      symptom: 'times out under load',
    }],
  }
}
const mutate = (fn: (d: Doc) => void) => {
  const doc = valid()
  fn(doc)
  return () => parseRegistry(JSON.stringify(doc))
}
const reg = (f: object) => parseRegistry(JSON.stringify({ flakes: [f] }))

describe('the checked-in registry', () => {
  it('is valid against its own schema', () => {
    expect(() => parseRegistry(RAW)).not.toThrow()
    expect(parseRegistry(RAW).length).toBeGreaterThan(0)
  })

  it('cites a fixing PR for every entry claimed fixed', () => {
    for (const f of parseRegistry(RAW).filter((x) => x.status === 'fixed')) {
      expect(f.fixed_by, `${f.test} claims fixed with no fixed_by`).toBeGreaterThan(0)
    }
  })

  it('names a location that actually exists in the tree', () => {
    // The one check that catches an invented entry: it would answer NOT REGISTERED for the very
    // failure it was written for, while reading as coverage.
    for (const f of parseRegistry(RAW)) {
      const path = f.location.replace(/:\d+$/, '')
      expect(existsSync(resolve(ROOT, path)), `${f.test}: no such file ${path}`).toBe(true)
    }
  })

  it('keeps every entry reachable by the name its runner prints', () => {
    const flakes = parseRegistry(RAW)
    for (const f of flakes) expect(findFlakes(flakes, f.test), `${f.test} is not findable by its own name`).toContainEqual(f)
  })
})

describe('the validator rejects registries that would lie', () => {
  it('rejects a duplicate test entry', () => {
    expect(mutate((d) => d.flakes.push({ ...d.flakes[0] }))).toThrow(/duplicate/i)
  })
  it('rejects an open entry with no cited issue', () => {
    expect(mutate((d) => { delete d.flakes[0].issue })).toThrow(/issue/i)
  })
  it('rejects a non-integer or non-positive issue', () => {
    expect(mutate((d) => { d.flakes[0].issue = 0 })).toThrow(/issue/i)
    expect(mutate((d) => { d.flakes[0].issue = '1234' })).toThrow(/issue/i)
  })
  it('rejects a fixed entry that does not name the fixing PR', () => {
    expect(mutate((d) => { d.flakes[0].status = 'fixed' })).toThrow(/fixed_by/i)
  })
  it('rejects fixed_by on an entry that is not fixed', () => {
    expect(mutate((d) => { d.flakes[0].fixed_by = 99 })).toThrow(/fixed_by/i)
  })
  it('rejects a missing or empty symptom', () => {
    expect(mutate((d) => { delete d.flakes[0].symptom })).toThrow(/symptom/i)
    expect(mutate((d) => { d.flakes[0].symptom = '   ' })).toThrow(/symptom/i)
  })
  it('rejects an unknown status', () => {
    expect(mutate((d) => { d.flakes[0].status = 'flaky-ish' })).toThrow(/status/i)
  })
  it('requires evidence for known-risk, and forbids it citing an issue', () => {
    expect(mutate((d) => { d.flakes[0].status = 'known-risk'; delete d.flakes[0].issue })).toThrow(/evidence/i)
    expect(mutate((d) => { d.flakes[0].status = 'known-risk'; d.flakes[0].evidence = 'CI run 1' })).toThrow(/must not cite an issue/i)
  })
  it('forbids known-risk citing issues through `also`, not just `issue`', () => {
    expect(mutate((d) => {
      d.flakes[0].status = 'known-risk'
      delete d.flakes[0].issue
      d.flakes[0].evidence = 'CI run 1'
      d.flakes[0].also = [1234]
    })).toThrow(/must not cite an issue/i)
  })
  it('rejects a missing location, so every entry stays checkable', () => {
    expect(mutate((d) => { delete d.flakes[0].location })).toThrow(/location/i)
  })
  it('rejects a non-string package, which would crash the lookup', () => {
    expect(mutate((d) => { d.flakes[0].package = 123 })).toThrow(/package/i)
  })
  it('rejects malformed JSON and a missing flakes array', () => {
    expect(() => parseRegistry('{oops')).toThrow(/valid JSON/i)
    expect(() => parseRegistry('[]')).toThrow(/object/i)
    expect(() => parseRegistry('{}')).toThrow(/flakes/i)
  })
})

describe('lookup', () => {
  const flakes = parseRegistry(RAW)
  const devNode = flakes.find((f) => f.test.startsWith('tests/unit/scripts/devNodeExternals.test.ts'))!

  it('matches the FAIL line vitest prints, project tag and all', () => {
    const printed = ` FAIL  |tooling| ${devNode.test}`
    expect(findFlakes(flakes, printed)).toEqual([devNode])
  })
  it('is case-insensitive and ignores surrounding whitespace', () => {
    expect(findFlakes(flakes, `  ${devNode.test.toUpperCase()}  `)).toEqual([devNode])
  })
  it('returns nothing for an empty query rather than everything', () => {
    expect(findFlakes(flakes, '')).toEqual([])
    expect(findFlakes(flakes, '   ')).toEqual([])
  })
  it('throws on a query too short to discriminate, rather than matching', () => {
    expect(() => findFlakes(flakes, 'test')).toThrow(/too short/i)
    expect(() => findFlakes(flakes, 'queue')).toThrow(/too short/i)
  })
  it('does not let a registered name claim a longer name built from it', () => {
    const f = { ...valid().flakes[0], test: 'message_queue_fifo_ordering' }
    expect(findFlakes(reg(f), 'message_queue_fifo_ordering_v2')).toEqual([])
    expect(findFlakes(reg(f), 'session::actor_state::message_queue_fifo_ordering')).toHaveLength(1)
  })
  it('does not let a query that merely ENDS with a registered name claim it', () => {
    const f = { ...valid().flakes[0], test: 'message_queue_fifo_ordering' }
    expect(findFlakes(reg(f), 'xmessage_queue_fifo_ordering')).toEqual([])
    expect(findMentions(reg(f), 'xmessage_queue_fifo_ordering')).toEqual([])
  })
  it('misses a test nobody has registered', () => {
    expect(findFlakes(flakes, 'definitely_not_registered_xyz')).toEqual([])
  })
})

describe('the lookup searches the whole record, not just the test name', () => {
  const entry = {
    test: 'tests/unit/some/area.test.ts > some case',
    suite: 'vitest',
    package: 'session-main',
    location: 'tests/unit/some/area.test.ts:42',
    status: 'open',
    issue: 1234,
    symptom: 'the mark element is absent, not misplaced',
    note: "the panel's async mount had not settled before the assertion",
    evidence: 'measured on the parent commit, three consecutive green runs',
  } as FlakeEntry
  const signatureOf = (text: string) => {
    const out: string[] = []
    for (const w of text.split(/\s+/).filter(Boolean)) {
      out.push(w)
      if (out.length >= 2 && out.join(' ').length >= MIN_PROSE_QUERY_LENGTH) break
    }
    return out.join(' ')
  }

  it('exposes the vocabulary the rules are written in', () => {
    expect(SEARCH_FIELDS).toEqual([IDENTITY_FIELD, 'symptom', 'location', 'note', 'evidence'])
    expect(MIN_PROSE_QUERY_LENGTH).toBeGreaterThan(MIN_QUERY_LENGTH)
    expect(isPhrase('the mark element is absent')).toBe(true)
    expect(isPhrase('session-main')).toBe(false)
    expect(isPhrase('  session-main  ')).toBe(false)
    expect(matchedFields(entry, '   ')).toEqual([])
  })
  it('pins the token floor at 8 characters, by behaviour', () => {
    const real = parseRegistry(RAW)
    expect(findFlakes(real, 'devNodeE').length, 'an 8-character query must be answered').toBeGreaterThan(0)
    expect(() => findFlakes(real, 'devNode')).toThrow(/too short/i)
  })
  it('finds a phrase that appears ONLY in `symptom`', () => {
    expect(findFlakes(reg(entry), 'the mark element is absent, not misplaced')).toHaveLength(1)
    expect(matchedFields(entry, 'the mark element is absent, not misplaced')).toEqual(['symptom'])
  })
  it('finds a phrase that appears only in `note`, and one only in `evidence`', () => {
    expect(findFlakes(reg(entry), 'async mount had not settled')).toHaveLength(1)
    expect(matchedFields(entry, 'async mount had not settled')).toEqual(['note'])
    expect(findFlakes(reg(entry), 'three consecutive green runs')).toHaveLength(1)
    expect(matchedFields(entry, 'three consecutive green runs')).toEqual(['evidence'])
  })
  it('matches a REFLOWED paste of a recorded phrase', () => {
    expect(findFlakes(reg(entry), 'the mark element is\nabsent,\tnot   misplaced')).toHaveLength(1)
    expect(findFlakes(reg(entry), 'THE MARK ELEMENT IS ABSENT, NOT MISPLACED')).toHaveLength(1)
  })
  it('finds a longer pasted line that contains a registered field', () => {
    const pasted = 'FAIL tests/unit/some/area.test.ts > some case at tests/unit/some/area.test.ts:42'
    expect(matchedFields(entry, pasted)).toEqual(['test', 'location'])
    expect(findFlakes(reg(entry), pasted)).toHaveLength(1)
    expect(findMentions(reg(entry), pasted)).toEqual([])
  })
  it('reports a bare path or a single token from the record as a MENTION, never a hit', () => {
    for (const q of ['tests/unit/some/area.test.ts:42', 'misplaced', 'assertion']) {
      expect(findFlakes(reg(entry), q), q).toEqual([])
      expect(findMentions(reg(entry), q), q).toHaveLength(1)
    }
    expect(findFlakes(reg(entry), 'the mark element is absent')).toHaveLength(1)
    const short = 'absent, not misplaced'
    expect(short.length).toBeLessThan(MIN_PROSE_QUERY_LENGTH)
    expect(findFlakes(reg(entry), short)).toEqual([])
    expect(findMentions(reg(entry), short)).toHaveLength(1)
  })
  it('never lets a match in `location` identify a flake, however long the query', () => {
    const located = { ...entry, test: 'some unrelated case name' }
    const pasted = 'error thrown at tests/unit/some/area.test.ts:42 during the run'
    expect(matchedFields(located, pasted)).toEqual(['location'])
    expect(findFlakes(reg(located), pasted)).toEqual([])
    expect(findMentions(reg(located), pasted)).toHaveLength(1)
  })
  it('does not reverse-match a field too short to identify anything', () => {
    const q = 'the harness reported x before it stopped'
    expect(q.length).toBeGreaterThanOrEqual(MIN_PROSE_QUERY_LENGTH)
    expect(findFlakes([{ ...entry, evidence: 'the harness reported' }], q), 'control').toHaveLength(1)
    expect(findFlakes([{ ...entry, evidence: 'x' }], q)).toEqual([])
    expect(findMentions([{ ...entry, evidence: 'x' }], q)).toEqual([])
  })
  it('keeps a LONG single token in prose a mention, not a match', () => {
    const token = 'some_very_long_token_identifier_here'
    const withToken = { ...entry, note: `the fixture ${token} is reset between runs` }
    expect(token.length).toBeGreaterThanOrEqual(MIN_PROSE_QUERY_LENGTH)
    expect(findFlakes(reg(withToken), token)).toEqual([])
    expect(findMentions(reg(withToken), token)).toHaveLength(1)
  })
  it('attributes a short recorded phrase that appears inside a longer paste', () => {
    const short = { ...entry, symptom: 'times out under load' }
    expect(findFlakes(reg(short), 'times out under load')).toEqual([])
    expect(findMentions(reg(short), 'times out under load')).toHaveLength(1)
    expect(findFlakes(reg(short), 'the harness said times out under load and then it stopped')).toHaveLength(1)
  })
  it('finds a field that appears twice in a paste, once cleanly', () => {
    const f = { ...entry, test: 'message_queue_fifo_ordering' }
    expect(findFlakes(reg(f), 'message_queue_fifo_ordering_v2 then message_queue_fifo_ordering')).toHaveLength(1)
  })
  it('pins the prose floor at 24 characters, by behaviour', () => {
    const symptom = '0123456789 abcdefghij klmnopqrst uvwxyz'
    const flakes = reg({ ...entry, symptom })
    const exact = symptom.slice(0, 24)
    const under = symptom.slice(0, 23)
    expect([exact.length, under.length]).toEqual([24, 23])
    expect(isPhrase(under)).toBe(true)
    expect(findFlakes(flakes, exact)).toHaveLength(1)
    expect(findFlakes(flakes, under)).toEqual([])
    expect(findMentions(flakes, under)).toHaveLength(1)
  })
  it('reports every entry in the real registry from its own recorded symptom', () => {
    const flakes = parseRegistry(RAW)
    for (const f of flakes) {
      const phrase = signatureOf(f.symptom)
      expect(phrase, `${f.test}: slice is a single token`).toMatch(/\s/)
      if (phrase.length >= MIN_PROSE_QUERY_LENGTH) expect(findFlakes(flakes, phrase), `${f.test}: its own symptom is not an attribution`).toContainEqual(f)
      else expect(findMentions(flakes, phrase), `${f.test}: its own symptom is not reported`).toContainEqual(f)
    }
  })
})

const CLI_STDIO: ['ignore', 'pipe', 'pipe'] = ['ignore', 'pipe', 'pipe']
function run(...args: string[]) {
  try {
    return { status: 0, out: execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: CLI_STDIO }) }
  } catch (err) {
    const e = err as { status: number; stdout?: string; stderr?: string }
    return { status: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

describe('--list-fields documents what is searchable', () => {
  it('names every searched field, and the ones it refuses', () => {
    const { out } = run('--list-fields')
    for (const field of [...SEARCH_FIELDS, 'package', 'suite', 'issue']) expect(out, `${field} is not listed`).toContain(field)
  })
  it('answers --list-fields ahead of the modes that need the registry', () => {
    const { out } = run('--list-fields', '--validate')
    expect(out).toContain('what a query searches')
    expect(out).toContain('reading list')
    expect(out).not.toContain('schema valid')
  })
})

describe('the CLI exit code is the documented branch point', () => {
  it('exits 0 for a phrase the registry holds', () => {
    const { status, out } = run('the case runs to the 60 s cap and never sees the rebuild')
    expect(status).toBe(0)
    expect(out).toContain('MATCH (')
    expect(out).toContain('matched: symptom')
  })
  it('exits 1, and still answers, for a name the registry only mentions', () => {
    const { status, out } = run('awaitCondition')
    expect(status).toBe(1)
    expect(out).toContain('MENTIONED IN (')
    expect(out).not.toContain('NOT REGISTERED')
    expect(out).toMatch(/matched: (symptom|location|note|evidence) -- /)
    expect(out).toContain('…')
  })
  it('prints the mentions of a query that ALSO has hits', () => {
    const { status, out } = run('extension-program-cancellation.test.ts')
    expect(status).toBe(0)
    expect(out).toContain('MATCH (')
    expect(out).toContain('MENTIONED IN (')
  })
  it('exits 1 with NOT REGISTERED for a failure nobody has registered', () => {
    const { status, out } = run('definitely_not_registered_xyz')
    expect(status).toBe(1)
    expect(out).toContain('NOT REGISTERED')
  })
  it('exits 2 for a query too short to discriminate', () => {
    expect(run('queue').status).toBe(2)
  })
})

describe('a mention windows the field instead of printing it whole', () => {
  it('shows the field whole while it fits, and elides it when it does not', () => {
    expect(excerpt('short field', 'field')).toBe('short field')
    const long = `${'a'.repeat(200)} needle ${'b'.repeat(200)}`
    const out = excerpt(long, 'needle')
    expect(out.startsWith('…') && out.endsWith('…')).toBe(true)
    expect(out).toContain('needle')
    expect(Array.from(out).length).toBeLessThanOrEqual(90)
  })
  it('slices over CODE POINTS, so an emoji is never cut in half', () => {
    const out = excerpt(`${'🙂'.repeat(80)} needle`, 'needle')
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    expect(out).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
  })
  it('falls back to the opening when a fold changes length, instead of misplacing the window', () => {
    expect(excerpt(`${'x'.repeat(200)}İSTANBUL`, 'i̇stanbul').startsWith('x')).toBe(true)
  })
  it('centres the window in a field whose CASE differs from the query', () => {
    const out = excerpt(`${'x'.repeat(200)} NEEDLE ${'y'.repeat(200)}`, 'needle')
    expect(out).toContain('NEEDLE')
    expect(out.startsWith('…')).toBe(true)
  })
  it('centres the window on the FIRST occurrence when a field repeats the needle', () => {
    expect(excerpt(`needle ${'x'.repeat(80)} needle ${'y'.repeat(200)}`, 'needle').startsWith('needle')).toBe(true)
  })
  it('still shows the opening when the query was found in reverse', () => {
    const out = excerpt(`${'z'.repeat(300)} tail`, 'not in this field at all')
    expect(out.startsWith('z') && out.endsWith('…')).toBe(true)
  })
})

describe('status vocabulary', () => {
  it('gives every status an advice line', () => {
    for (const [name, s] of Object.entries(STATUSES)) {
      expect(s.blurb, `${name} has no blurb`).toBeTruthy()
      expect(s.advice, `${name} has no advice`).toBeTruthy()
    }
  })
})

describe('location containment: `test` must resolve in the file `location` names', () => {
  const readText = (p: string) => {
    const abs = resolve(ROOT, p)
    return existsSync(abs) && !statSync(abs).isDirectory() ? readFileSync(abs, 'utf8') : null
  }
  const isDir = (p: string) => {
    const abs = resolve(ROOT, p)
    return existsSync(abs) && statSync(abs).isDirectory()
  }
  const named = {
    test: 'tests/unit/scripts/devNodeExternals.test.ts > Electron development dependency externalization > externalizes installed CommonJS packages, bundles ESM and local source, and rebuilds changes',
    suite: 'vitest',
    location: 'tests/unit/scripts/devNodeExternals.test.ts:85',
    status: 'known-risk',
    evidence: 'x',
    symptom: 'x',
  } as FlakeEntry

  it('resolves every entry, or exempts it for a stated reason', () => {
    const unresolved = parseRegistry(RAW)
      .map((f) => ({ f, r: resolveEntry(f, readText, isDir) }))
      .filter(({ r }) => r.verdict !== 'RESOLVED' && r.verdict !== 'EXEMPT')
      .map(({ f, r }) => `${f.test} [${r.verdict}] ${r.detail}`)
    expect(unresolved, `entries whose test does not resolve:\n${unresolved.join('\n')}`).toEqual([])
  })
  it('recognises exactly the shapes it claims to, and exempts no others', () => {
    const seen = new Set(parseRegistry(RAW).map((f) => resolveEntry(f, readText, isDir).shape))
    expect([...seen].sort()).toEqual(['ci-step', 'dir-location', 'vitest-file', 'vitest-name'].filter((s) => seen.has(s as never)))
  })
  it('rejects a location pointing at a file that does not declare the test', () => {
    const r = resolveEntry({ ...named, location: 'tests/unit/scripts/ciKeptTree.test.ts:85' }, readText, isDir)
    expect(r.verdict).toBe('UNRESOLVED')
    expect(r.detail).toMatch(/different test/)
  })
  it('accepts the same entry at its real file, regardless of the advisory line', () => {
    for (const line of [85, 1, 99999]) {
      const r = resolveEntry({ ...named, location: `${splitLocation(named.location).path}:${line}` }, readText, isDir)
      expect(r.verdict, `line ${line}`).toBe('RESOLVED')
    }
  })
  it('does NOT require `test` and `location` to name the same path', () => {
    const ci = parseRegistry(RAW).filter((f) => f.suite === 'ci')
    expect(ci.length).toBeGreaterThan(0)
    for (const f of ci) {
      expect(splitLocation(f.location).path).not.toBe(f.test)
      expect(resolveEntry(f, readText, isDir).verdict).toBe('EXEMPT')
    }
  })
  it('exempts a directory location instead of crashing on it', () => {
    const r = resolveEntry({ ...named, location: 'apps/desktop/src/session/renderer/tests/browser' }, readText, isDir)
    expect(r.shape).toBe('dir-location')
    expect(r.verdict).toBe('EXEMPT')
  })
  it('reports the true line so a stale hint can be refreshed, without failing', () => {
    const r = resolveEntry({ ...named, location: 'tests/unit/scripts/devNodeExternals.test.ts:200' }, readText, isDir)
    expect(r.trueLine).toBe(85)
  })
})
