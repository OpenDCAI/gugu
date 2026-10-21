import { execFileSync, spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { cachedFixtureExecutable } from '../../support/cachedFixtureExecutable'
import YAML from 'yaml'

import {
  associateCheckRunEvents,
  attachPullRequestMergeState,
  classifyCheckSnapshot,
  completePullRequestFiles,
  deriveCheckProfiles,
  evaluateCheckSnapshots,
  eventHasSubscribingWorkflow,
  shouldReadPullRequestMergeState,
  GITHUB_PR_FILES_API_CAP,
  loadWorkflowInventory,
  pullRequestEvents,
  workflowRunsForEvent
} from '../../../scripts/check-verdict.mjs'

type CheckRun = {
  id: number
  event: string
  name: string
  status: string
  conclusion: string | null
}

function inventoryEntry(path: string, workflow: object) {
  return { path, source: YAML.stringify(workflow) }
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: 'push:dev',
    type: 'push',
    ref: 'refs/heads/dev',
    changedPaths: ['apps/desktop/src/App.tsx'],
    inventoryRef: 'candidate-sha',
    workflows: [],
    ...overrides
  }
}

function completed(id: number, eventType: string, name: string, conclusion = 'success'): CheckRun {
  return { id, event: eventType, name, status: 'completed', conclusion }
}

const ciCheckNames = [
  'Source checks (policy / typecheck / lint)',
  'Unit tests (1/2)',
  'Unit tests (2/2)',
  'Renderer build',
  'Desktop dependency closure',
  'Typecheck, lint, and test'
]

function incidentInventory() {
  return [
    inventoryEntry('.github/workflows/ci.yml', {
      name: 'CI',
      on: { push: { branches: ['dev'] } },
      jobs: {
        policy: { name: ciCheckNames[0], 'runs-on': 'fixture' },
        unit: {
          name: 'Unit tests (${{ matrix.shard }})',
          strategy: { matrix: { shard: ['1/2', '2/2'] } },
          'runs-on': 'fixture'
        },
        renderer: { name: ciCheckNames[3], 'runs-on': 'fixture' },
        closure: { name: ciCheckNames[4], 'runs-on': 'fixture' },
        gate: { name: ciCheckNames[5], 'runs-on': 'fixture' }
      }
    }),
    inventoryEntry('.github/workflows/beta.yml', {
      on: { push: { branches: ['dev'], 'paths-ignore': ['docs/**'] } },
      jobs: {
        backend: { name: 'backend-contract-gate', 'runs-on': 'fixture' }
      }
    }),
    inventoryEntry('.github/workflows/branch.yml', {
      on: { pull_request_target: { branches: ['main'], types: ['synchronize'] } },
      jobs: {
        policy: { name: 'Branch policy', 'runs-on': 'fixture' },
        publish: { name: 'Trusted Branch policy publisher', 'runs-on': 'fixture' }
      }
    })
  ]
}

function incidentProfiles() {
  const workflows = incidentInventory()
  return deriveCheckProfiles([
    event({ workflows }),
    event({
      id: 'pull_request_target:#fixture',
      type: 'pull_request_target',
      action: 'synchronize',
      baseRef: 'main',
      inventoryRef: 'base-sha',
      workflows
    })
  ])
}

describe('exact-head check verdict', () => {
  it('rejects abbreviated head SHAs with a rev-parse repair hint', () => {
    const result = spawnSync(
      process.execPath,
      [resolve('scripts/check-verdict.mjs'), '--sha', '7d435d2501', '--push', 'dev'],
      { cwd: process.cwd(), encoding: 'utf8' }
    )

    expect({ status: result.status, output: `${result.stdout}${result.stderr}` }).toEqual({
      status: 1,
      output: expect.stringContaining(
        'CONFIG_ERROR: --sha must be a 40-character hexadecimal SHA; use git rev-parse <ref>'
      )
    })
  })

  it('rejects abbreviated --before SHAs with the same rev-parse repair hint', () => {
    const result = spawnSync(
      process.execPath,
      [
        resolve('scripts/check-verdict.mjs'),
        '--sha',
        '7d435d25015b2c15ea3c7f729799cddd399405a7',
        '--push',
        'dev',
        '--before',
        '7d435d2501'
      ],
      { cwd: process.cwd(), encoding: 'utf8' }
    )

    expect({ status: result.status, output: `${result.stdout}${result.stderr}` }).toEqual({
      status: 1,
      output: expect.stringContaining(
        'CONFIG_ERROR: --before must be a 40-character hexadecimal SHA; use git rev-parse <ref>'
      )
    })
  })

  it('reproduces eff69378e without turning a partial all-success set GREEN', () => {
    const profiles = incidentProfiles()
    const early = ciCheckNames.map((name, index) => completed(index + 1, 'push', name))
    const initial = evaluateCheckSnapshots(profiles, [early, early])

    expect(initial).toMatchObject({
      verdict: 'INCOMPLETE',
      missing: [
        'pull_request_target/Branch policy',
        'pull_request_target/Trusted Branch policy publisher',
        'push/backend-contract-gate'
      ],
      pending: [],
      failed: []
    })

    const lateFailures = [
      completed(20, 'push', 'backend-contract-gate', 'failure'),
      completed(21, 'pull_request_target', 'Branch policy', 'failure'),
      completed(22, 'pull_request_target', 'Trusted Branch policy publisher', 'failure')
    ]
    expect(evaluateCheckSnapshots(profiles, [early, [...early, ...lateFailures]])).toMatchObject({
      verdict: 'RED',
      missing: [],
      failed: [
        'pull_request_target/Branch policy (failure)',
        'pull_request_target/Trusted Branch policy publisher (failure)',
        'push/backend-contract-gate (failure)'
      ]
    })
  })

  it('uses RED, WAIT, and INCOMPLETE as distinct non-green outcomes', () => {
    const profiles = deriveCheckProfiles([
      event({
        workflows: [
          inventoryEntry('.github/workflows/fixture.yml', {
            on: { push: null },
            jobs: {
              first: { name: 'First', 'runs-on': 'fixture' },
              second: { name: 'Second', 'runs-on': 'fixture' }
            }
          })
        ]
      })
    ])

    expect(evaluateCheckSnapshots(profiles, [[completed(1, 'push', 'First')]]).verdict).toBe(
      'INCOMPLETE'
    )
    expect(
      evaluateCheckSnapshots(profiles, [
        [{ id: 1, event: 'push', name: 'First', status: 'in_progress', conclusion: null }]
      ])
    ).toMatchObject({ verdict: 'WAIT', pending: ['push/First'], missing: ['push/Second'] })
    expect(
      evaluateCheckSnapshots(profiles, [[completed(1, 'push', 'First', 'cancelled')]])
    ).toMatchObject({ verdict: 'RED', failed: ['push/First (cancelled)'] })
    expect(
      evaluateCheckSnapshots(profiles, [[completed(1, 'push', 'First', 'timed_out')]]).verdict
    ).toBe('RED')
  })

  it('requires the complete successful set to survive a stable settle reread', () => {
    const profiles = deriveCheckProfiles([
      event({
        workflows: [
          inventoryEntry('.github/workflows/fixture.yml', {
            on: { push: null },
            jobs: { test: { name: 'Test', 'runs-on': 'fixture' } }
          })
        ]
      })
    ])
    const success = [completed(10, 'push', 'Test')]

    expect(evaluateCheckSnapshots(profiles, [success])).toMatchObject({
      verdict: 'WAIT',
      settling: true
    })
    expect(evaluateCheckSnapshots(profiles, [success, success])).toMatchObject({
      verdict: 'GREEN',
      settling: false
    })
    expect(
      evaluateCheckSnapshots(profiles, [success, [completed(11, 'push', 'Test')]])
    ).toMatchObject({
      verdict: 'WAIT',
      settling: true
    })
  })

  it('keeps push and pull-request-target profiles separate on a shared SHA', () => {
    const workflows = incidentInventory()
    const pushOnly = deriveCheckProfiles([event({ workflows })])
    const names = pushOnly.flatMap((profile) => profile.checks)

    expect(names).toContain('backend-contract-gate')
    expect(names).not.toContain('Branch policy')
    expect(names).not.toContain('Trusted Branch policy publisher')
  })

  it('associates each Actions check run with its workflow event by check-suite id', () => {
    const checkRuns = [
      {
        id: 10,
        app: { slug: 'github-actions' },
        check_suite: { id: 100 },
        name: 'Unit tests',
        status: 'completed',
        conclusion: 'success'
      },
      {
        id: 11,
        app: { slug: 'external-ci' },
        check_suite: { id: 101 },
        name: 'External check',
        status: 'completed',
        conclusion: 'success'
      }
    ]
    const workflowRuns = [{ id: 20, check_suite_id: 100, event: 'pull_request' }]

    expect(associateCheckRunEvents(checkRuns, workflowRuns)).toEqual([
      {
        id: 10,
        event: 'pull_request',
        name: 'Unit tests',
        status: 'completed',
        conclusion: 'success'
      }
    ])
    const skipped = associateCheckRunEvents([checkRuns[0]], [])
    expect(skipped).toEqual([])
    expect(skipped).toHaveProperty('skippedCheckRuns', [
      { id: 10, checkSuiteId: 100, reason: 'no-check-suite-event' }
    ])
    expect(() =>
      associateCheckRunEvents([checkRuns[0]], [
        ...workflowRuns,
        { id: 21, check_suite_id: 100, event: 'push' }
      ])
    ).toThrow('maps to both pull_request and push')
  })

  it('diagnoses an empty suite-to-event mapping separately from an orphaned check run', () => {
    const profiles = deriveCheckProfiles([
      event({
        workflows: [
          inventoryEntry('.github/workflows/ci.yml', {
            on: { push: { branches: ['dev'] } },
            jobs: { gate: { name: 'Gate', 'runs-on': 'fixture' } }
          })
        ]
      })
    ])
    const runs = associateCheckRunEvents(
      [
        {
          id: 200,
          app: { slug: 'github-actions' },
          check_suite: { id: 300 },
          name: 'Gate',
          status: 'completed',
          conclusion: 'success'
        }
      ],
      []
    )

    expect(evaluateCheckSnapshots(profiles, [runs, runs])).toMatchObject({
      verdict: 'INCOMPLETE',
      diagnostic: expect.stringContaining(
        'found 1 GitHub Actions check run(s), but no workflow run matched the exact SHA'
      )
    })
    expect(evaluateCheckSnapshots(profiles, [runs, runs]).diagnostic).not.toContain(
      'without a matching workflow event'
    )
  })

  it('skips an orphaned Actions check run without blocking the target event verdict', () => {
    const profiles = deriveCheckProfiles([
      event({
        workflows: [
          inventoryEntry('.github/workflows/ci.yml', {
            on: { push: { branches: ['dev'] } },
            jobs: { gate: { name: 'Gate', 'runs-on': 'fixture' } }
          })
        ]
      })
    ])
    const runs = associateCheckRunEvents(
      [
        {
          id: 100,
          app: { slug: 'github-actions' },
          check_suite: { id: 200 },
          name: 'Gate',
          status: 'completed',
          conclusion: 'success'
        },
        {
          id: 101,
          app: { slug: 'github-actions' },
          check_suite: { id: 999 },
          name: 'beta-mac',
          status: 'completed',
          conclusion: 'success'
        }
      ],
      [{ id: 201, check_suite_id: 200, event: 'push' }]
    )

    expect(evaluateCheckSnapshots(profiles, [runs, runs])).toMatchObject({
      verdict: 'GREEN',
      skippedCheckRuns: [{ id: 101, checkSuiteId: 999, reason: 'no-check-suite-event' }],
      diagnostic: expect.stringContaining('101 (suite 999)')
    })
  })

  it('reports an explicitly selected event even when no workflow applies', () => {
    const workflows = incidentInventory()
    const profiles = deriveCheckProfiles([
      event({ workflows }),
      event({
        id: 'pull_request_target:#fixture',
        type: 'pull_request_target',
        action: 'synchronize',
        baseRef: 'dev',
        inventoryRef: 'base-sha',
        workflows
      })
    ])

    expect(profiles).toContainEqual(expect.objectContaining({
      eventType: 'pull_request_target',
      workflow: null,
      checks: [],
      noMatchReason: 'event'
    }))
  })

  it('keeps an event-mismatch profile incomplete instead of reporting green', () => {
    const profiles = deriveCheckProfiles([
      event({
        id: 'pull_request:#fixture',
        type: 'pull_request',
        action: 'synchronize',
        baseRef: 'main',
        workflows: [
          inventoryEntry('.github/workflows/dev-only.yml', {
            on: { push: { branches: ['dev'] } },
            jobs: { ci: { name: 'CI', 'runs-on': 'fixture' } }
          })
        ]
      })
    ])

    expect(evaluateCheckSnapshots(profiles, [[]])).toMatchObject({
      verdict: 'INCOMPLETE',
      profiles: [expect.objectContaining({ noMatchReason: 'event' })]
    })
  })

  it('attaches merge state only to an event-mismatch zero-check result', () => {
    const eventMismatch = deriveCheckProfiles([
      event({
        id: 'pull_request:#fixture',
        type: 'pull_request',
        action: 'synchronize',
        baseRef: 'dev',
        workflows: []
      })
    ])
    const result = evaluateCheckSnapshots(eventMismatch, [[]])

    expect(shouldReadPullRequestMergeState(result)).toBe(true)
    expect(attachPullRequestMergeState(result, {
      mergeable: 'CONFLICTING',
      mergeStateStatus: 'DIRTY'
    })).toMatchObject({
      verdict: 'INCOMPLETE',
      mergeState: { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' },
      diagnostic: expect.stringContaining('mergeStateStatus=DIRTY')
    })

    const pathFiltered = deriveCheckProfiles([
      event({
        changedPaths: ['docs/runbook.md'],
        workflows: [
          inventoryEntry('.github/workflows/ci.yml', {
            on: { push: { branches: ['dev'], 'paths-ignore': ['docs/**'] } },
            jobs: { ci: { name: 'CI', 'runs-on': 'fixture' } }
          })
        ]
      })
    ])
    const pathResult = evaluateCheckSnapshots(pathFiltered, [[], []])
    expect(shouldReadPullRequestMergeState(pathResult)).toBe(false)
    expect(attachPullRequestMergeState(pathResult, {
      mergeable: 'CONFLICTING',
      mergeStateStatus: 'DIRTY'
    })).not.toHaveProperty('mergeState')
  })

  it('reads PR merge state at the CLI boundary for an event-mismatch zero-check', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gugu-check-verdict-merge-state-'))
    const fixtureRoot = join(directory, 'repo')
    const workflowDirectory = join(fixtureRoot, '.github', 'workflows')
    const invocationLog = join(directory, 'invocations.ndjson')
    mkdirSync(workflowDirectory, { recursive: true })
    writeFileSync(
      join(workflowDirectory, 'ci.yml'),
      `name: fixture\non:\n  pull_request:\n    branches: [dev]\njobs:\n  gate:\n    name: Gate\n    runs-on: fixture\n`
    )
    execFileSync('git', ['init', '-q'], { cwd: fixtureRoot })
    execFileSync('git', ['config', 'user.email', 'fixture@gugu.test'], { cwd: fixtureRoot })
    execFileSync('git', ['config', 'user.name', 'Gugu fixture'], { cwd: fixtureRoot })
    execFileSync('git', ['add', '.'], { cwd: fixtureRoot })
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: fixtureRoot })
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: fixtureRoot,
      encoding: 'utf8'
    }).trim()
    // @@@4918 假 gh 经 GUGU_GH 被 check-verdict.mjs 执行。正文全静态
    // (调用日志与 sha 都走 env),所以能按内容寻址、跨 worker/跨 run 复用同一个 inode。
    const fakeGh = cachedFixtureExecutable(
      'gh.mjs',
      `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(process.env.GUGU_GH_INVOCATION_LOG, JSON.stringify(args) + '\\n')
const endpoint = args.find((arg) => arg.startsWith('repos/'))
if (args[0] === 'pr') {
  process.stdout.write(JSON.stringify({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }))
} else if (endpoint?.endsWith('/pulls/3558')) {
  process.stdout.write(JSON.stringify({
    head: { sha: process.env.GUGU_FIXTURE_SHA },
    base: { ref: 'no-such-branch', sha: process.env.GUGU_FIXTURE_SHA }
  }))
} else if (endpoint?.includes('/pulls/3558/files')) {
  process.stdout.write('[]\\n')
} else if (endpoint?.includes('/actions/runs?')) {
  process.stdout.write(JSON.stringify([{ workflow_runs: [] }]))
} else if (endpoint?.includes('/commits/')) {
  process.stdout.write(JSON.stringify([{ check_runs: [] }]))
} else {
  console.error('unexpected fake gh request: ' + JSON.stringify(args))
  process.exitCode = 24
}
`
    )

    try {
      const result = spawnSync(
        process.execPath,
        [
          resolve('scripts/check-verdict.mjs'),
          '--repo',
          'fixture/repo',
          '--sha',
          sha,
          '--pr',
          '3558',
          '--action',
          'synchronize',
          '--json'
        ],
        {
          cwd: fixtureRoot,
          encoding: 'utf8',
          env: {
            ...process.env,
            GUGU_GH: fakeGh,
            GUGU_FIXTURE_SHA: sha,
            GUGU_GH_INVOCATION_LOG: invocationLog
          }
        }
      )

      expect(result.status).toBe(2)
      expect(result.stderr).toBe('')
      expect(result.stdout).toContain('"mergeable": "CONFLICTING"')
      expect(result.stdout).toContain('"mergeStateStatus": "DIRTY"')
      expect(result.stdout).toContain('pull-request event has no registered checks')
      expect(readFileSync(invocationLog, 'utf8')).toContain('"pr","view","3558"')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  /**
   * #4114 的 fail-closed 对**真实触发的**事件是对的，对工具自己合成的兄弟事件是错的。
   *
   * GitHub 只运行订阅了该事件的 workflow：一个仓库不用 `pull_request_target`，那个事件就
   * **根本不会触发**，期待它等于期待不可能存在的 run。#4114 把这份沉默读成「profile 缺失」，
   * 于是本仓每个 PR 都停在 INCOMPLETE —— 唯一被认可的合并判据对整个仓库说「永远不行」。
   *
   * 这条判据自带反例：同一份 check-run 数据，无条件加上兄弟事件必须变回 INCOMPLETE。
   * 没有那半边，前半边的 GREEN 可能只是恰好为真。
   */
  it('不订阅 pull_request_target 的仓库，PR 全绿就是 GREEN', () => {
    const workflows = [
      inventoryEntry('.github/workflows/ci.yml', {
        on: { pull_request: { branches: ['dev'] } },
        jobs: { gate: { name: 'Typecheck, lint, and test', 'runs-on': 'fixture' } }
      })
    ]
    const prEvent = event({
      id: 'pull_request:#1',
      type: 'pull_request',
      action: 'synchronize',
      baseRef: 'dev',
      ref: undefined,
      workflows
    })
    const siblingEvent = {
      ...prEvent,
      id: 'pull_request_target:#1',
      type: 'pull_request_target',
      inventoryRef: 'base-sha'
    }

    // main() 现在只在真有订阅者时才合成这个兄弟事件
    expect(eventHasSubscribingWorkflow(siblingEvent)).toBe(false)
    // incidentInventory 那条 pull_request_target 限定 branches:['main'] —— baseRef 要跟着走，
    // 否则这半边会因为分支不匹配而假红，看起来像「有订阅者也认不出来」。
    expect(
      eventHasSubscribingWorkflow({
        ...siblingEvent,
        baseRef: 'main',
        workflows: incidentInventory()
      })
    ).toBe(true)

    const green = [completed(1, 'pull_request', 'Typecheck, lint, and test')]
    expect(evaluateCheckSnapshots(deriveCheckProfiles([prEvent]), [green, green]))
      .toMatchObject({ verdict: 'GREEN' })

    // 反例:按 #4114 的老做法无条件带上兄弟事件，同一份数据必须判 INCOMPLETE
    expect(evaluateCheckSnapshots(deriveCheckProfiles([prEvent, siblingEvent]), [green, green]))
      .toMatchObject({ verdict: 'INCOMPLETE' })
  })

  /**
   * 上一条测的是助手函数，这一条测**它有没有被接上**——把 main() 里那道闸删掉，助手还在，
   * 上一条照样绿。判据要盯的是接线，不是零件。loader 注入进来，所以这条不依赖本仓此刻
   * 有没有 pull_request_target workflow。
   */
  it('base 不订阅 pull_request_target 就不合成它，订阅了就照常合成', () => {
    const withoutTarget = [
      inventoryEntry('.github/workflows/ci.yml', {
        on: { pull_request: { branches: ['dev'] } },
        jobs: { gate: { name: 'Typecheck, lint, and test', 'runs-on': 'fixture' } }
      })
    ]
    const input = {
      root: '/repo',
      sha: 'head-sha',
      number: 7,
      pull: { base: { ref: 'dev', sha: 'base-sha' } },
      files: ['apps/desktop/src/App.tsx'],
      action: 'synchronize'
    }

    expect(pullRequestEvents(input, () => withoutTarget).map((entry) => entry.type))
      .toEqual(['pull_request'])

    // incidentInventory 的 pull_request_target 限定 branches:['main']
    expect(
      pullRequestEvents(
        { ...input, pull: { base: { ref: 'main', sha: 'base-sha' } } },
        () => incidentInventory()
      ).map((entry) => entry.type)
    ).toEqual(['pull_request', 'pull_request_target'])
  })

  it('derives path-conditional profiles instead of using a repository-wide count', () => {
    const workflows = [
      inventoryEntry('.github/workflows/ci.yml', {
        on: { push: { branches: ['dev'], 'paths-ignore': ['**/*.md', 'docs/**'] } },
        jobs: { ci: { name: 'CI', 'runs-on': 'fixture' } }
      }),
      inventoryEntry('.github/workflows/docs.yml', {
        on: { push: { branches: ['dev'], paths: ['docs/**', '**/*.md'] } },
        jobs: { docs: { name: 'Dev governance docs', 'runs-on': 'fixture' } }
      }),
      inventoryEntry('.github/workflows/schema.yml', {
        on: { push: { branches: ['dev'], paths: ['supabase/migrations/**'] } },
        jobs: {
          schema: { name: 'Fresh upstream and anchored suffix parity', 'runs-on': 'fixture' }
        }
      })
    ]

    const docs = deriveCheckProfiles([event({ changedPaths: ['docs/runbook.md'], workflows })])
    expect(docs.flatMap((profile) => profile.checks)).toEqual(['Dev governance docs'])

    const migration = deriveCheckProfiles([
      event({
        changedPaths: ['supabase/migrations/20260805000000_fixture.sql'],
        workflows
      })
    ])
    expect(migration.flatMap((profile) => profile.checks).sort()).toEqual([
      'CI',
      'Fresh upstream and anchored suffix parity'
    ])
  })

  it('settles an event whose exact path profile expects no checks', () => {
    const profiles = deriveCheckProfiles([
      event({
        changedPaths: ['docs/runbook.md'],
        workflows: [
          inventoryEntry('.github/workflows/ci.yml', {
            on: { push: { branches: ['dev'], 'paths-ignore': ['**/*.md', 'docs/**'] } },
            jobs: { ci: { name: 'CI', 'runs-on': 'fixture' } }
          })
        ]
      })
    ])

    expect(evaluateCheckSnapshots(profiles, [[]])).toMatchObject({
      verdict: 'WAIT',
      settling: true
    })
    expect(evaluateCheckSnapshots(profiles, [[], []])).toMatchObject({
      verdict: 'GREEN',
      profiles: [expect.objectContaining({ workflow: null, checks: [], noMatchReason: 'paths' })]
    })
  })

  it('selects current workflow bytes and ignores retired-generation checks', () => {
    const current = [
      inventoryEntry('.github/workflows/current.yml', {
        on: { push: null },
        jobs: { current: { name: 'Current gate', 'runs-on': 'fixture' } }
      })
    ]
    const retired = [
      inventoryEntry('.github/workflows/old.yml', {
        on: { push: null },
        jobs: { old: { name: 'Retired gate', 'runs-on': 'fixture' } }
      })
    ]
    const runs = [
      completed(1, 'push', 'Current gate'),
      completed(2, 'push', 'Retired gate', 'failure')
    ]

    const currentProfiles = deriveCheckProfiles([event({ workflows: current })])
    expect(evaluateCheckSnapshots(currentProfiles, [runs, runs])).toMatchObject({
      verdict: 'GREEN',
      ignoredNotApplicable: ['push/Retired gate']
    })

    const retiredProfiles = deriveCheckProfiles([
      event({
        inventoryRef: 'old-sha',
        workflows: retired
      })
    ])
    expect(
      classifyCheckSnapshot(retiredProfiles, [completed(1, 'push', 'Current gate')])
    ).toMatchObject({ state: 'INCOMPLETE', missing: ['push/Retired gate'] })
  })

  it('loads the real candidate inventory and expands its static unit matrix', () => {
    const ciSource = readFileSync('.github/workflows/ci.yml', 'utf8')
    const execute = vi.fn((_command: string, args: string[]) => {
      if (args[0] === 'ls-tree') return Buffer.from('.github/workflows/ci.yml\0')
      if (args[0] === 'show') return ciSource
      throw new Error(`unexpected git operation ${args[0]}`)
    })
    const workflows = loadWorkflowInventory('/candidate', 'candidate-sha', execute)
    const profiles = deriveCheckProfiles([
      event({
        id: 'pull_request:#fixture',
        type: 'pull_request',
        action: 'synchronize',
        baseRef: 'dev',
        changedPaths: ['docs/fixture.md'],
        inventoryRef: 'HEAD',
        workflows
      })
    ])
    const names = profiles.flatMap((profile) => profile.checks)

    // #5354: 分片 2 -> 4(池是 16 个并行槽,两片各 ~195s 时 unit 排在关键路径第二)。这份清单是
    // check-verdict 判绿的依据,分片数改了不同步,PR 会一直等两个永远不会出现的检查。
    // #6270: 4 -> 2(worker 按余量分)。清单是判绿依据,分片数不同步会让 PR 一直等不存在的检查。
    expect(names).toContain('Unit tests (1/2)')
    expect(names).toContain('Unit tests (2/2)')
    expect(names).not.toContain('Unit tests (3/4)')
    expect(names).toContain('Web E2E (local)')
    // #5354: electron 目标从 renderer-build 拆出来后自带的新必过检查名。
    expect(names).toContain('Renderer build (web target)')
    // #6270: linux 原生重编并进 desktop-build —— 清单里再出现它,PR 会一直等一个永远不会出现的检查。
    expect(names).not.toContain('Linux native addon rebuild (Electron headers)')
    expect(names).toContain('Desktop app build (macos-14)')
    expect(names).toContain('Desktop app build (ubuntu-24.04)')
    expect(names).toContain('Typecheck, lint, and test')
    // 共享那两片 2026-08-12 摘出了必过闸(见 ci.yml 的 matrix 注释与 ci-spec-coverage.json 的
    // shared-test-backend-dropped-from-gate)。这里从「必须存在」翻成「必须不存在」而不是简单删掉:
    // 清单是 check-verdict 判绿的依据,如果它又冒出来而没人察觉,PR 会开始等一个不该等的检查。
    expect(names).not.toContain('Web E2E (shared-1)')
    expect(names).not.toContain('Web E2E (shared-2)')
    expect(names).not.toContain('Fresh upstream and anchored suffix parity')
    expect(execute.mock.calls).toEqual([
      [
        'git',
        [
          'ls-tree',
          '-r',
          '-z',
          '--name-only',
          'candidate-sha',
          '--',
          '.github/workflows'
        ],
        { cwd: '/candidate' }
      ],
      [
        'git',
        ['show', 'candidate-sha:.github/workflows/ci.yml'],
        { cwd: '/candidate', encoding: 'utf8' }
      ]
    ])
  })

  it('fails loudly on ambiguous or dynamically named workflow inventory', () => {
    expect(() =>
      deriveCheckProfiles([
        event({
          workflows: [
            inventoryEntry('.github/workflows/dynamic.yml', {
              on: { push: null },
              jobs: { test: { name: 'Test ${{ github.ref_name }}', 'runs-on': 'fixture' } }
            })
          ]
        })
      ])
    ).toThrow('dynamic check name')

    expect(() =>
      deriveCheckProfiles([
        event({
          workflows: [
            inventoryEntry('.github/workflows/a.yml', {
              on: { push: null },
              jobs: { a: { name: 'Same', 'runs-on': 'fixture' } }
            }),
            inventoryEntry('.github/workflows/b.yml', {
              on: { push: null },
              jobs: { b: { name: 'Same', 'runs-on': 'fixture' } }
            })
          ]
        })
      ])
    ).toThrow('ambiguous check')
  })

  it('fails loudly on an unknown check status', () => {
    const profiles = deriveCheckProfiles([
      event({
        workflows: [
          inventoryEntry('.github/workflows/fixture.yml', {
            on: { push: null },
            jobs: { test: { name: 'Test', 'runs-on': 'fixture' } }
          })
        ]
      })
    ])

    expect(() =>
      classifyCheckSnapshot(profiles, [
        { id: 1, event: 'push', name: 'Test', status: 'mystery', conclusion: null }
      ])
    ).toThrow('unknown status')
  })

  it('judges a diff far larger than the retired 300-file guard exactly', () => {
    // 从前 >300 直接抛错，于是任何大 PR 都拿不到裁决。3000 以下清单就是全量，照常精确判定。
    const bulk = Array.from({ length: 1_600 }, (_, i) => `docs/${i}.md`)
    expect(
      workflowRunsForEvent({ on: { push: { paths: ['apps/**'] } } }, event({ changedPaths: bulk }))
    ).toBe(false)
    expect(
      workflowRunsForEvent({ on: { push: { 'paths-ignore': ['docs/**'] } } }, event({ changedPaths: bulk }))
    ).toBe(false)

    // 匹配排在第 1350 位也必须看得见——#3198 里 supabase/migrations 就是这个位置形状。
    const late = [...bulk]
    late.splice(1_349, 0, 'apps/desktop/src/App.tsx')
    expect(
      workflowRunsForEvent({ on: { push: { paths: ['apps/**'] } } }, event({ changedPaths: late }))
    ).toBe(true)
    expect(
      workflowRunsForEvent({ on: { push: { 'paths-ignore': ['docs/**'] } } }, event({ changedPaths: late }))
    ).toBe(true)
  })

  it('refuses a verdict when a pull request hits the files API 3000-file cap', () => {
    // 到顶 = 分页也拿不全，此时任何判定都是猜 → 按铁律 fail loud。
    const capped = Array.from({ length: GITHUB_PR_FILES_API_CAP }, (_, i) => `docs/${i}.md`)
    expect(() =>
      workflowRunsForEvent(
        { on: { pull_request: { paths: ['apps/**'] } } },
        event({ type: 'pull_request', action: 'synchronize', baseRef: 'dev', changedPaths: capped })
      )
    ).toThrow('3000')

    const exact = [...capped, 'apps/desktop/src/App.tsx']
    expect(workflowRunsForEvent(
      { on: { pull_request: { paths: ['apps/**'] } } },
      event({ type: 'pull_request', action: 'synchronize', baseRef: 'dev', changedPaths: exact, changedPathsSource: 'git' })
    )).toBe(true)

    // 同样规模的 push 清单来自本地 git diff，是全量，不该被这道门槛误伤。
    expect(
      workflowRunsForEvent({ on: { push: { paths: ['apps/**'] } } }, event({ changedPaths: capped }))
    ).toBe(false)
  })

  it('checks a full Git diff against the API count and names, including deletions and renames', () => {
    const root = mkdtempSync(join(tmpdir(), 'gugu-verdict-full-files-'))
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
    try {
      git('init', '-q')
      git('config', 'user.email', 'fixture@gugu.test')
      git('config', 'user.name', 'Gugu fixture')
      writeFileSync(join(root, 'deleted.md'), 'old')
      writeFileSync(join(root, 'before.md'), 'rename me')
      git('add', '.')
      git('commit', '-qm', 'base')
      const base = git('rev-parse', 'HEAD')
      git('mv', 'before.md', 'after.md')
      rmSync(join(root, 'deleted.md'))
      writeFileSync(join(root, 'added.md'), 'new')
      git('add', '-A')
      git('commit', '-qm', 'head')
      const pull = { base: { sha: base }, head: { sha: git('rev-parse', 'HEAD') }, changed_files: 3 }
      expect(completePullRequestFiles(root, pull, ['after.md'])).toEqual(['added.md', 'after.md', 'before.md', 'deleted.md'])
      expect(() => completePullRequestFiles(root, { ...pull, changed_files: 5 }, ['after.md'])).toThrow('do not cover')
      expect(() => completePullRequestFiles(root, pull, ['missing.md'])).toThrow('do not cover')
      expect(() => completePullRequestFiles(root, { ...pull, head: { sha: 'HEAD' } }, [])).toThrow('40-character')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
