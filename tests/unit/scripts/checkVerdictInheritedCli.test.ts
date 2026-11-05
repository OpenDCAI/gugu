import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cachedFixtureExecutable } from '../../support/cachedFixtureExecutable'

const fakeGh = cachedFixtureExecutable('inherited-check-gh.mjs', `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs'
if (process.argv.includes('--version')) process.exit(0)
const endpoint = process.argv.find(arg => arg.startsWith('repos/'))
appendFileSync(process.env.GUGU_GH_INVOCATION_LOG, endpoint + '\\n')
const responses = JSON.parse(readFileSync(process.env.GUGU_GH_RESPONSES, 'utf8'))
if (!(endpoint in responses)) throw new Error('Unexpected endpoint: ' + endpoint)
process.stdout.write(JSON.stringify(responses[endpoint]))
`)

describe('check-verdict partial rerun through the GitHub CLI boundary (#288)', () => {
  it.each(['inherited', 'third-attempt', 'rerun', 'missing-source-marker', 'malformed-source',
    'malformed', 'duplicate', 'unrelated-annotation', 'incomplete-history'] as const)(
    'uses original annotations only for proven inheritance: %s', (scenario) => {
    const directory = mkdtempSync(join(tmpdir(), 'gugu-verdict-inherited-'))
    const root = join(directory, 'repo')
    const log = join(directory, 'requests.log')
    const responsesFile = join(directory, 'responses.json')
    mkdirSync(join(root, '.github/workflows'), { recursive: true })
    writeFileSync(join(root, '.github/workflows/ci.yml'), `name: CI
on: { pull_request: { branches: [dev] } }
jobs:
  changes:
    name: Detect changed areas
    runs-on: fixture
  android:
    name: Android build
    needs: changes
    if: needs.changes.outputs.android == 'true'
    runs-on: fixture
  gate:
    name: Gate
    runs-on: fixture
`)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
    try {
      git('init', '-q')
      git('config', 'user.email', 'fixture@gugu.test')
      git('config', 'user.name', 'Gugu fixture')
      git('add', '.')
      git('commit', '-qm', 'fixture')
      const sha = git('rev-parse', 'HEAD')
      const prefix = 'repos/fixture/repo'
      const check = (id: number, name: string, conclusion = 'success') => ({
        id, name, status: 'completed', conclusion, check_suite: { id: 22 }, app: { slug: 'github-actions' },
      })
      const original = {
        run_id: 11, run_attempt: 1, name: 'Detect changed areas', status: 'completed', conclusion: 'success',
        check_run_url: `https://api.github.com/${prefix}/check-runs/100`,
        started_at: '2026-10-24T21:00:00Z', completed_at: '2026-10-24T21:00:05Z',
        steps: [{ number: 1, name: 'Detect paths', status: 'completed', conclusion: 'success',
          started_at: '2026-10-24T21:00:01Z', completed_at: '2026-10-24T21:00:03Z' }],
      }
      const inherited = { ...original, run_attempt: 2,
        check_run_url: `https://api.github.com/${prefix}/check-runs/200`,
        ...(scenario === 'rerun' ? { completed_at: '2026-10-24T22:00:05Z' } : {}),
      }
      const third = { ...inherited, run_attempt: 3,
        check_run_url: `https://api.github.com/${prefix}/check-runs/300` }
      const currentId = scenario === 'third-attempt' ? 300 : 200
      const currentAnnotations = scenario === 'malformed'
        ? [{ title: 'ci-job-outputs', message: 'android false' }]
        : scenario === 'duplicate'
          ? Array.from({ length: 2 }, () => ({ title: 'ci-job-outputs', message: 'android=false' }))
          : scenario === 'unrelated-annotation' ? [{ title: 'warning', message: 'not an output' }] : []
      writeFileSync(responsesFile, JSON.stringify({
        [`${prefix}/pulls/288`]: { head: { sha }, base: { ref: 'dev', sha }, changed_files: 0 },
        [`${prefix}/pulls/288/files?per_page=100`]: [],
        [`${prefix}/actions/runs?head_sha=${sha}&per_page=100`]: [{ workflow_runs: [{ id: 11, check_suite_id: 22, event: 'pull_request', run_attempt: scenario === 'third-attempt' ? 3 : 2 }] }],
        [`${prefix}/commits/${sha}/check-runs?filter=all&per_page=100`]: [{ check_runs: [
          check(100, 'Detect changed areas'), check(200, 'Detect changed areas'),
          ...(scenario === 'third-attempt' ? [check(300, 'Detect changed areas')] : []),
          check(201, 'Android build', 'skipped'), check(202, 'Gate'),
        ] }],
        [`${prefix}/check-runs/100/annotations?per_page=100`]: [scenario === 'missing-source-marker' ? []
          : [{ title: 'ci-job-outputs', message: scenario === 'malformed-source' ? 'android false' : 'android=false' }]],
        [`${prefix}/check-runs/200/annotations?per_page=100`]: [currentId === 200 ? currentAnnotations : []],
        [`${prefix}/check-runs/300/annotations?per_page=100`]: [currentAnnotations],
        [`${prefix}/actions/runs/11/attempts/1/jobs?per_page=100`]: [{ jobs: scenario === 'incomplete-history' ? [] : [original] }],
        [`${prefix}/actions/runs/11/attempts/2/jobs?per_page=100`]: [{ jobs: [inherited] }],
        [`${prefix}/actions/runs/11/attempts/3/jobs?per_page=100`]: [{ jobs: [third] }],
      }))
      const result = spawnSync(process.execPath, [resolve('scripts/ci/check-verdict.mts'),
        '--repo', 'fixture/repo', '--sha', sha, '--pr', '288', '--action', 'synchronize',
        '--settle-seconds', '0.01', '--json'], {
        cwd: root, encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, GUGU_GH: fakeGh, GUGU_GH_RESPONSES: responsesFile, GUGU_GH_INVOCATION_LOG: log },
      })
      expect(result.error).toBeUndefined()
      expect(result.stderr).toBe('')
      const inherits = scenario === 'inherited' || scenario === 'third-attempt'
      expect(result.status).toBe(inherits ? 0 : 1)
      const verdict = JSON.parse(result.stdout)
      expect(verdict.verdict).toBe(inherits ? 'GREEN' : 'RED')
      if (inherits) {
        expect(verdict).toMatchObject({ failed: [], missing: [], pending: [], skippedNotDue: ['pull_request/Android build'] })
        // Two independent snapshots re-read the attempt history before the reader settles GREEN.
        expect(readFileSync(log, 'utf8').split('\n').filter(line => line.endsWith('/attempts/1/jobs?per_page=100'))).toHaveLength(2)
      } else {
        expect(verdict.failed).toEqual(['pull_request/Android build (skipped; Detect changed areas published no ci-job-outputs android)'])
      }
      if (['malformed', 'duplicate', 'unrelated-annotation'].includes(scenario)) {
        expect(readFileSync(log, 'utf8')).not.toContain('/attempts/')
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
    },
  )
})
