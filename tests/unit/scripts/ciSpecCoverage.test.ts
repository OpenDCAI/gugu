import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import YAML from 'yaml'

import {
  auditChangedSpecExecution,
  auditCoverage,
  NO_NEW_E2E,
  collectAutomaticRunnerCommands,
  collectRunnerFiles,
  declaresTestCase,
  parsePlaywrightList,
  workflowRunsForPullRequest,
} from '../../../scripts/ci-spec-coverage.mts'

const roots: string[] = []

function fixtureRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'gugu-ci-spec-'))
  roots.push(root)
  mkdirSync(path.join(root, 'e2e'), { recursive: true })
  mkdirSync(path.join(root, 'tests/integration'), { recursive: true })
  return root
}

/**
 * 一棵**在仓库树之外**、能真跑 Playwright 收集的根:配置逐字节复制(testDir 相对它自己的目录解析),
 * 依赖与脚本软链回仓库。❌ 别把临时 spec 写进本仓的 e2e/:并发跑着的其它用例在遍历 e2e/**,
 * 这边一拆目录,那边就 ENOENT(#4357:e2eNoIconClassSelectors 撞过)。
 */
function playwrightRootOutsideCheckout(): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'gugu-ci-discovery-')))
  roots.push(root)
  for (const file of ['playwright.config.mts', 'package.json']) copyFileSync(file, path.join(root, file))
  for (const entry of ['node_modules', 'scripts', 'tsconfig.json', 'pnpm-workspace.yaml']) {
    symlinkSync(path.resolve(entry), path.join(root, entry))
  }
  return root
}

function exemption(specs: string[]) {
  return {
    version: 3,
    automaticExecutors: [],
    exemptionReasons: {
      'fixture-exemption': 'Fixture tests require a deliberately unavailable external runtime boundary.',
    },
    exemptions: Object.fromEntries(specs.map((spec) => [spec, 'fixture-exemption'])),
  }
}

function writeJson(file: string, value: unknown) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('CI e2e/integration spec coverage', () => {
  it('classifies every current repository test declaration', () => {
    const result = auditCoverage({ root: process.cwd() })
    expect(result.errors).toEqual([])
    const e2eSpecs = result.discovered.filter((file) => file.startsWith('e2e/'))
    const exemptions = JSON.parse(readFileSync('.github/ci-spec-coverage.json', 'utf8')).exemptions
    // #6270:e2e/ 只剩 PR CI 的 ci-local 真跑的那几条,全部由自动执行器收走、一条豁免都没有。
    expect(e2eSpecs.length).toBeGreaterThan(0)
    expect(e2eSpecs.every((file) => file.startsWith('e2e/ci/local/'))).toBe(true)
    expect(Object.keys(exemptions).filter((file) => file.startsWith('e2e/'))).toEqual([])
    expect(result.groupCounts
      .filter((group) => group.disposition === 'automatic executor')
      .reduce((total, group) => total + group.count, 0)).toBe(e2eSpecs.length)
  })

  it('discovers the PR web projects by directory and keeps them fail-closed through the required aggregate', () => {
    const workflow = YAML.parse(readFileSync('.github/workflows/ci.yml', 'utf8'))
    const job = workflow.jobs['web-smoke']
    const runSteps = job.steps.filter(
      (step: { name?: string }) => step.name === 'Run automatically discovered CI web specs',
    )
    const artifactStep = job.steps.find(
      (step: { name?: string }) => step.name === 'Upload Playwright report and test artifacts',
    )
    const gateRun = workflow.jobs.gate.steps.map((step: { run?: string }) => step.run ?? '').join('\n')

    expect(workflow.on.pull_request).toEqual(null)
    expect(job.if).toBeUndefined()
    expect(job['continue-on-error']).toBeUndefined()
    expect(job.strategy['fail-fast']).toBe(false)
    // 共享那两片已摘出必过闸(owner 2026-08-12):4 天 9 次报红,真产品回归 0 次。
    expect(job.strategy.matrix.include).toEqual([
      { id: 'local', runtime: 'local', db_target: '', playwright_project: 'ci-local', shard_arg: '' },
    ])
    expect(runSteps).toHaveLength(1)
    expect(runSteps.every((step: { if?: unknown }) => step.if === undefined)).toBe(true)
    expect(runSteps.every((step: { 'continue-on-error'?: unknown }) => step['continue-on-error'] === undefined)).toBe(true)
    expect(runSteps.every((step: { run: string }) => step.run.includes('--workers=1'))).toBe(true)
    expect(runSteps.map((step: { run: string }) => step.run)).toEqual([
      'pnpm exec playwright test --project=${{ matrix.playwright_project }} ${{ matrix.shard_arg }} --workers=1',
    ])
    expect(artifactStep.if).toBe('${{ always() }}')
    expect(artifactStep.with['if-no-files-found']).toBe('error')
    expect(workflow.jobs.gate.name).toBe('Typecheck, lint, and test')
    expect(workflow.jobs.gate.needs).toContain('web-smoke')
    expect(gateRun).toContain('needs.web-smoke.result')
    expect(gateRun).toContain('[ "${{ needs.web-smoke.result }}" != "success" ]')

    const commands = collectAutomaticRunnerCommands({
      workflows: [{ path: '.github/workflows/ci.yml', workflow }],
      changedPaths: ['e2e/ci/local/search-field-consistency.spec.ts'],
      packageScripts: {},
    }).filter((command) => command.job === 'web-smoke')
    expect(commands).toHaveLength(1)
    const perShard = commands.map((command) => collectRunnerFiles(process.cwd(), command))
    expect(perShard.every((files) => files.length > 0)).toBe(true)
    // e2e/ci 下的每个 spec 都必须被这个 job 真收走(#6270 起 e2e 不接受豁免)。
    const allCiSpecs = execFileSync('git', ['ls-files', '-z', '--', 'e2e/ci'], { encoding: 'utf8' })
      .split('\0')
      .filter((file) => file.endsWith('.spec.ts'))
      .sort()
    const collected = [...new Set(perShard.flat())].sort()
    expect(collected).toEqual(allCiSpecs)
    expect(collected.every((file) => file.startsWith('e2e/ci/local/'))).toBe(true)

    const manifest = JSON.parse(readFileSync('.github/ci-spec-coverage.json', 'utf8'))
    expect(manifest.automaticExecutors).toHaveLength(1)
    expect(manifest.automaticExecutors[0].specs).toBeUndefined()
  })

  // 这条守的是自动发现机制本身:往「还在自动执行的目录」放一个新 spec,它必须被收进去,
  // 而且不用改 workflow、不用改册子。共享片摘出闸后 ci/local 是唯一还自动执行的目录,
  // 所以判据搬到它身上 —— ❌ 别把这条一起删掉:删了就没人守着「新 spec 会被自动收」这件事,
  // 而 #3223 建这套机制正是为了终结「加了 spec 忘了登记 → 静默不跑」。
  it('collects the next local CI spec without editing the workflow or registry', () => {
    const root = playwrightRootOutsideCheckout()
    const fixture = path.join(root, 'e2e/ci/local/.automatic-discovery')
    mkdirSync(fixture, { recursive: true })
    const spec = path.join(fixture, 'next.spec.ts')
    writeFileSync(spec, "import { test } from '@playwright/test'\ntest('next automatic case', () => {})\n")
    const relativeSpec = path.relative(root, spec).replaceAll(path.sep, '/')
    const workflow = YAML.parse(readFileSync('.github/workflows/ci.yml', 'utf8'))
    const commands = collectAutomaticRunnerCommands({
      workflows: [{ path: '.github/workflows/ci.yml', workflow }],
      changedPaths: [relativeSpec],
      packageScripts: {},
    }).filter((command) => command.job === 'web-smoke' && command.env.GUGU_E2E_CI_PROJECT === 'local')

    expect(commands).toHaveLength(1)
    expect(new Set(commands.flatMap((command) => collectRunnerFiles(root, command))).has(relativeSpec)).toBe(true)
    expect(readFileSync('.github/workflows/ci.yml', 'utf8')).not.toContain(relativeSpec)
    expect(readFileSync('.github/ci-spec-coverage.json', 'utf8')).not.toContain(relativeSpec)
  })

  // #6270:session-db 用 ci-concurrent 把几段测试并到一个 step。每条 lane 都得被认领成 runner 命令,
  // 否则「并发」就成了一条让测试从覆盖账上消失的暗道。
  it('claims every ci-concurrent lane as a runner command and rejects malformed lanes', () => {
    const workflowWith = (run: string) => ({
      on: { pull_request: null },
      jobs: { lanes: { steps: [{ run }] } },
    })
    const commands = collectAutomaticRunnerCommands({
      workflows: [{
        path: 'ci.yml',
        workflow: workflowWith(
          "node scripts/ci-concurrent.mts 'db=pnpm session:test:db' 'browser=pnpm exec vitest run --project session-browser'",
        ),
      }],
      changedPaths: [],
      packageScripts: { 'session:test:db': 'vitest run --project session-main-db' },
    })
    expect(commands.map((command) => [command.runner, ...command.args])).toEqual([
      ['vitest', '--project', 'session-main-db'],
      ['vitest', '--project', 'session-browser'],
    ])
    expect(() => collectAutomaticRunnerCommands({
      workflows: [{ path: 'ci.yml', workflow: workflowWith("node scripts/ci-concurrent.mts 'pnpm exec vitest run'") }],
      changedPaths: [],
      packageScripts: {},
    })).toThrow(/label=command/)
  })

  it('requires the producer-specific non-success rejection on one gate line', () => {
    const positive = auditCoverage({ root: process.cwd() })
    expect(positive.errors).toEqual([])

    const root = fixtureRoot()
    mkdirSync(path.join(root, '.github/workflows'), { recursive: true })
    writeFileSync(path.join(root, '.github/workflows/ci.yml'), readFileSync('.github/workflows/ci.yml', 'utf8').replace(
      '             [ "${{ needs.web-smoke.result }}" != "success" ] || \\\n',
      '',
    ))
    const repositoryManifest = JSON.parse(readFileSync('.github/ci-spec-coverage.json', 'utf8'))
    const manifest = {
      version: 3,
      automaticExecutors: repositoryManifest.automaticExecutors,
      exemptionReasons: {},
      exemptions: {},
    }
    writeFileSync(path.join(root, 'package.json'), readFileSync('package.json', 'utf8'))
    const mutated = auditCoverage({
      root,
      manifest,
      trackedPaths: [],
      collectExecutorFiles: () => [],
    })

    expect(mutated.errors).toEqual([
      'automatic executor pr-web-smoke-slice required gate does not explicitly reject a non-success web-smoke result',
    ])
  })

  it('runs unconditionally on the required policy path', () => {
    const workflow = YAML.parse(readFileSync('.github/workflows/ci.yml', 'utf8'))
    const step = workflow.jobs.policy.steps.find(
      (candidate: { run?: string }) => candidate.run?.includes('node scripts/ci-spec-coverage.mts'),
    )

    expect(step.run).toContain('--base FETCH_HEAD --head HEAD')
    expect(step.run).toContain('--event-action "${{ github.event.action }}"')
    expect(step.run).toContain('node scripts/ci-spec-coverage.mts "${args[@]}"')
    expect(step.if).toBeUndefined()
    expect(step['continue-on-error']).toBeUndefined()
    expect(workflow.jobs.gate.name).toBe('Typecheck, lint, and test')
    expect(workflow.jobs.gate.needs).toContain('policy')
  })

  it('finds an unregistered test after its filename stops matching the usual spec glob', () => {
    const root = fixtureRoot()
    const covered = 'tests/integration/covered.test.ts'
    const hidden = 'tests/integration/renamed-scenario.ts'
    writeFileSync(path.join(root, covered), "import { test } from '@playwright/test'\ntest('covered', () => {})\n")
    writeFileSync(path.join(root, hidden), "import { test as scenario } from '@playwright/test'\nscenario('hidden', () => {})\n")

    const result = auditCoverage({
      root,
      manifest: exemption([covered]),
      trackedPaths: [covered, hidden],
    })

    expect(result.discovered).toEqual([covered, hidden])
    expect(result.errors).toContain(
      `unclassified test declaration: ${hidden}; add exactly one line to `
      + `.github/ci-spec-coverage.json exemptions using an existing exemptionReasons id `
      + `(not a job name), without reordering the manifest`,
    )
    expect(result.errors.some((error) => error.startsWith(`unclassified test declaration: ${covered}`))).toBe(false)
  })

  it('discovers a project wrapper that registers cases through a static side-effect import', () => {
    const root = fixtureRoot()
    mkdirSync(path.join(root, 'tests/integration/agent'), { recursive: true })
    mkdirSync(path.join(root, 'tests/integration/electron'), { recursive: true })
    const driver = 'tests/integration/agent/onboarding.test.ts'
    const wrapper = 'tests/integration/electron/onboarding-wrapper.ts'
    writeFileSync(path.join(root, driver), "import { test } from '@playwright/test'\ntest('driver', () => {})\n")
    writeFileSync(path.join(root, wrapper), "import '../agent/onboarding.test'\n")

    const result = auditCoverage({
      root,
      manifest: exemption([driver, wrapper]),
      trackedPaths: [driver, wrapper],
    })

    expect(result.discovered).toEqual([driver, wrapper])
    expect(result.errors).toEqual([])
  })

  it('rejects stale exemption paths', () => {
    const root = fixtureRoot()
    const live = 'tests/integration/live.test.ts'
    writeFileSync(path.join(root, live), "import { test } from '@playwright/test'\ntest('live', () => {})\n")

    const result = auditCoverage({
      root,
      manifest: exemption([live, 'tests/integration/deleted.test.ts']),
      trackedPaths: [live],
    })

    expect(result.errors).toContain(
      'stale exemption fixture-exemption: tests/integration/deleted.test.ts is not a discovered test declaration',
    )
  })

  it('rejects an exemption path without a declared concrete reason', () => {
    const root = fixtureRoot()
    const justified = 'tests/integration/justified.test.ts'
    const unjustified = 'tests/integration/unjustified.test.ts'
    writeFileSync(path.join(root, justified), "import { test } from '@playwright/test'\ntest('justified', () => {})\n")
    writeFileSync(path.join(root, unjustified), "import { test } from '@playwright/test'\ntest('unjustified', () => {})\n")
    const manifest = exemption([justified])
    manifest.exemptions[unjustified] = 'missing-reason'

    const result = auditCoverage({ root, manifest, trackedPaths: [justified, unjustified] })

    expect(result.errors).toContain(
      `exemption ${unjustified} requires a declared reason id; received "missing-reason"`,
    )
  })

  it('keeps independently justified exemption additions valid after a merge-tree union', () => {
    const root = fixtureRoot()
    const manifestPath = path.join(root, '.github/ci-spec-coverage.json')
    mkdirSync(path.dirname(manifestPath), { recursive: true })
    execFileSync('git', ['init', '--quiet'], { cwd: root })
    execFileSync('git', ['config', 'user.name', 'ci-spec-coverage'], { cwd: root })
    execFileSync('git', ['config', 'user.email', 'ci-spec-coverage@example.invalid'], { cwd: root })

    const baseSpecs = [
      'tests/integration/a0.test.ts',
      'tests/integration/a1.test.ts',
      'tests/integration/a2.test.ts',
      'tests/integration/m0.test.ts',
      'tests/integration/m1.test.ts',
      'tests/integration/m2.test.ts',
      'tests/integration/z0.test.ts',
      'tests/integration/z1.test.ts',
      'tests/integration/z2.test.ts',
    ]
    for (const spec of baseSpecs) {
      writeFileSync(path.join(root, spec), "import { test } from '@playwright/test'\ntest('base', () => {})\n")
    }
    writeJson(manifestPath, {
      version: 3,
      automaticExecutors: [],
      exemptionReasons: {
        'browser-runtime': 'Requires a browser runtime that this synthetic automatic gate does not provide.',
        'database-runtime': 'Requires a database runtime that this synthetic automatic gate does not provide.',
      },
      exemptions: Object.fromEntries(baseSpecs.map((spec, index) => [
        spec,
        index < 5 ? 'browser-runtime' : 'database-runtime',
      ])),
    })
    execFileSync('git', ['add', '.'], { cwd: root })
    execFileSync('git', ['commit', '--quiet', '-m', 'base'], { cwd: root })
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()

    function commitAddition(branch: string, spec: string, reasonId: string) {
      execFileSync('git', ['checkout', '--quiet', '-B', branch, base], { cwd: root })
      writeFileSync(path.join(root, spec), "import { test } from '@playwright/test'\ntest('addition', () => {})\n")
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      manifest.exemptions[spec] = reasonId
      manifest.exemptions = Object.fromEntries(Object.entries(manifest.exemptions).sort(([left], [right]) => (
        left.localeCompare(right)
      )))
      writeJson(manifestPath, manifest)
      execFileSync('git', ['add', '.'], { cwd: root })
      execFileSync('git', ['commit', '--quiet', '-m', branch], { cwd: root })
      const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
      expect(auditCoverage({ root }).errors).toEqual([])
      return commit
    }

    const branchA = commitAddition('union-a', 'tests/integration/a-new.test.ts', 'browser-runtime')
    const branchB = commitAddition('union-b', 'tests/integration/y-new.test.ts', 'database-runtime')
    const unionTree = execFileSync('git', ['merge-tree', '--write-tree', branchA, branchB], {
      cwd: root,
      encoding: 'utf8',
    }).trim()
    // 提交信息走 `-m` 而不是 stdin —— 理由见 .eslintrc.cjs 顶部 @@@spawnsync-input (#3766)。
    // stdin 一并接 /dev/null:`commit-tree -m` 压根不读它,留着默认的管道等于白开一根,
    // 而那根管道正是那条缺陷的载体。
    const unionCommit = execFileSync(
      'git',
      ['commit-tree', unionTree, '-p', branchA, '-p', branchB, '-m', 'synthetic union'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim()
    execFileSync('git', ['checkout', '--quiet', '--detach', unionCommit], { cwd: root })

    const unionManifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    expect(unionManifest.exemptions['tests/integration/a-new.test.ts']).toBe('browser-runtime')
    expect(unionManifest.exemptions['tests/integration/y-new.test.ts']).toBe('database-runtime')
    expect(auditCoverage({ root }).errors).toEqual([])
  })

  it('refuses to exempt an e2e spec: e2e only holds specs the PR CI runs (#6270)', () => {
    const root = fixtureRoot()
    const spec = 'e2e/new-feature.spec.ts'
    writeFileSync(path.join(root, spec), "import { test } from '@playwright/test'\ntest('new', () => {})\n")

    const exempted = auditCoverage({ root, manifest: exemption([spec]), trackedPaths: [spec] })
    expect(exempted.errors).toContain(`exemption ${spec}: ${NO_NEW_E2E}`)

    const bare = auditCoverage({ root, manifest: exemption([]), trackedPaths: [spec] })
    expect(bare.errors).toContain(`e2e spec not run by any automatic PR executor: ${spec}; ${NO_NEW_E2E}`)
  })

  it('distinguishes test declarations from helper-only test API calls', () => {
    expect(declaresTestCase(
      "import { test } from '@playwright/test'\ntest.step('helper', async () => {})\n",
      'e2e/helper.ts',
    )).toBe(false)
    expect(declaresTestCase(
      "import * as vitest from 'vitest'\nvitest.it('case', () => {})\n",
      'tests/integration/renamed.ts',
    )).toBe(true)
  })

  it('derives changed-spec execution from PR trigger and real Playwright collection', () => {
    const root = playwrightRootOutsideCheckout()
    const fixture = path.join(root, 'e2e/ci/local/.ci-spec-coverage')
    const webSpec = path.relative(root, path.join(fixture, 'covered.spec.ts')).replaceAll(path.sep, '/')
    const agentDir = path.join(root, 'e2e/.ci-spec-coverage/agent')
    mkdirSync(fixture, { recursive: true })
    const agentSpec = path.relative(root, path.join(agentDir, 'ignored.spec.ts')).replaceAll(path.sep, '/')
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(path.join(root, webSpec), "import { test } from '@playwright/test'\ntest('covered', () => {})\n")
    writeFileSync(path.join(root, agentSpec), "import { test } from '@playwright/test'\ntest('ignored', () => {})\n")

    const run = `pnpm exec playwright test --project=ci-local ${webSpec} ${agentSpec}`
    const command = {
      runner: 'playwright' as const,
      args: ['--project=ci-local', webSpec, agentSpec],
      workflow: '.github/workflows/fixture.yml',
      job: 'web',
      env: {},
    }
    const collected = collectRunnerFiles(root, command)
    expect(collected).toContain(webSpec)
    expect(collected).not.toContain(agentSpec)

    const automatic = [{
      path: '.github/workflows/automatic.yml',
      workflow: { on: { pull_request: null }, jobs: { web: { steps: [{ run }] } } },
    }]
    const manual = [{
      path: '.github/workflows/manual.yml',
      workflow: { on: { workflow_dispatch: null }, jobs: { web: { steps: [{ run }] } } },
    }]
    const collectFiles = () => collected

    expect(auditChangedSpecExecution({
      root,
      changedPaths: [webSpec],
      workflows: automatic,
      packageScripts: {},
      collectFiles,
    }).gaps).toEqual([])
    expect(auditChangedSpecExecution({
      root,
      changedPaths: [webSpec],
      workflows: manual,
      packageScripts: {},
      collectFiles,
    }).gaps).toEqual([webSpec])
    expect(auditChangedSpecExecution({
      root,
      changedPaths: [agentSpec],
      workflows: automatic,
      packageScripts: {},
      collectFiles,
    }).gaps).toEqual([agentSpec])
  })

  it('honors pull_request paths and paths-ignore filters for the whole PR diff', () => {
    expect(workflowRunsForPullRequest(
      { on: { pull_request: { paths: ['tests/integration/**'] } } },
      ['tests/integration/service/example.test.ts'],
    )).toBe(true)
    expect(workflowRunsForPullRequest(
      { on: { pull_request: { paths: ['supabase/**'] } } },
      ['e2e/example.spec.ts'],
    )).toBe(false)
    expect(workflowRunsForPullRequest(
      { on: { pull_request: { 'paths-ignore': ['e2e/**'] } } },
      ['e2e/example.spec.ts'],
    )).toBe(false)
    expect(workflowRunsForPullRequest(
      { on: { pull_request: { 'paths-ignore': ['e2e/**'] } } },
      ['e2e/example.spec.ts', 'apps/desktop/src/App.tsx'],
    )).toBe(true)
    expect(workflowRunsForPullRequest(
      { on: { pull_request: { types: ['closed'] } } },
      ['e2e/example.spec.ts'],
      'dev',
      'synchronize',
    )).toBe(false)
  })

  it('keeps judging path filters exactly on a diff far larger than the retired 300-file guard', () => {
    // 这里的输入来自本地 `git diff`，永远是全量，所以**没有**规模上限、也不该有任何近似。
    // 从前 >300 直接抛错，把 #3198（1585 个文件）这类大 PR 整个挡在门外。
    // 判据要同时钉住两侧：够大且不匹配 → 仍然确定「不跑」；匹配落在第 300 个之后 → 仍然能看见。
    const bulk = Array.from({ length: 1_600 }, (_, i) => `docs/change-${i}.md`)

    expect(workflowRunsForPullRequest(
      { on: { pull_request: { paths: ['tests/integration/**'] } } },
      bulk,
    )).toBe(false)
    expect(workflowRunsForPullRequest(
      { on: { pull_request: { 'paths-ignore': ['docs/**'] } } },
      bulk,
    )).toBe(false)

    // 匹配文件排在第 1350 位 —— 正是 #3198 里 supabase/migrations 的位置形状。
    const late = [...bulk]
    late.splice(1_349, 0, 'tests/integration/service/agentEngineCatalogParity.test.ts')
    expect(workflowRunsForPullRequest(
      { on: { pull_request: { paths: ['tests/integration/**'] } } },
      late,
    )).toBe(true)
    expect(workflowRunsForPullRequest(
      { on: { pull_request: { 'paths-ignore': ['docs/**'] } } },
      late,
    )).toBe(true)
  })

  it('does not treat an empty Playwright suite container as a collected file', () => {
    const report = JSON.stringify({
      config: { rootDir: path.join(process.cwd(), 'e2e') },
      suites: [{
        file: 'empty.spec.ts',
        specs: [],
        suites: [{
          file: 'covered.spec.ts',
          specs: [{ file: 'covered.spec.ts', tests: [{ projectName: 'chromium' }] }],
        }],
      }],
    })

    expect(parsePlaywrightList(process.cwd(), report)).toEqual(['e2e/covered.spec.ts'])
  })

  it('preserves a bounded stdout tail when Playwright JSON collection is contaminated', () => {
    const report = JSON.stringify({
      config: { rootDir: path.join(process.cwd(), 'e2e') },
      suites: [{ specs: [{ file: 'known.spec.ts', tests: [{ projectName: 'chromium' }] }] }],
    })
    const sentinel = 'GUGU_STDOUT_CONTAMINATION_3070'
    const contaminated = `${report}\n${'discarded-noise-'.repeat(200)}${sentinel}`

    let message = ''
    try {
      parsePlaywrightList(process.cwd(), contaminated)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toContain('stdout tail')
    expect(message).toContain(sentinel)
    expect(message.length).toBeLessThan(1_000)
  })

  it('fails loudly when a runner job condition makes execution unknowable', () => {
    expect(() => auditChangedSpecExecution({
      root: process.cwd(),
      changedPaths: ['e2e/example.spec.ts'],
      workflows: [{
        path: '.github/workflows/conditional.yml',
        workflow: {
          on: { pull_request: null },
          jobs: { web: { if: '${{ github.event.pull_request.draft == false }}', steps: [{ run: 'pnpm exec playwright test --project=chromium' }] } },
        },
      }],
      packageScripts: {},
      collectFiles: () => [],
    })).toThrow('condition prevents reliable execution derivation')
  })

  it('does not treat a commented runner command as execution', () => {
    expect(auditChangedSpecExecution({
      root: process.cwd(),
      changedPaths: ['e2e/example.spec.ts'],
      workflows: [{
        path: '.github/workflows/comment-only.yml',
        workflow: {
          on: { pull_request: null },
          jobs: { web: { steps: [{ run: '# pnpm exec playwright test --project=chromium' }] } },
        },
      }],
      packageScripts: {},
      collectFiles: () => ['e2e/example.spec.ts'],
    }).gaps).toEqual(['e2e/example.spec.ts'])
  })

  it.each([
    'echo "pnpm exec playwright test --project=chromium"',
    'if false; then pnpm exec playwright test --project=chromium; fi',
  ])('does not treat runner text as a provably executed command: %s', (run) => {
    expect(() => auditChangedSpecExecution({
      root: process.cwd(),
      changedPaths: ['e2e/example.spec.ts'],
      workflows: [{
        path: '.github/workflows/text-only.yml',
        workflow: { on: { pull_request: null }, jobs: { web: { steps: [{ run }] } } },
      }],
      packageScripts: {},
      collectFiles: () => ['e2e/example.spec.ts'],
    })).toThrow('provably executed command')
  })

  it.each([
    { step: { env: { PROJECT: '${{ secrets.PROJECT }}' } }, message: 'cannot be resolved statically' },
    { step: { 'working-directory': 'apps/desktop' }, message: 'working-directory' },
  ])('fails loudly when runner configuration cannot be reproduced: $message', ({ step, message }) => {
    expect(() => auditChangedSpecExecution({
      root: process.cwd(),
      changedPaths: ['e2e/example.spec.ts'],
      workflows: [{
        path: '.github/workflows/dynamic.yml',
        workflow: {
          on: { pull_request: null },
          jobs: { web: { steps: [{ run: 'pnpm exec playwright test --project=chromium', ...step }] } },
        },
      }],
      packageScripts: {},
      collectFiles: () => [],
    })).toThrow(message)
  })

  // #3070 回归:pnpm 把 engine 警告写在 **stdout**,而且正文里带着一个 JSON 对象。
  //   WARN  Unsupported engine: wanted: {"node":">=24.0.0"} (current: {...})
  // 取第一个 '{' 会落在 {"node":">=24.0.0"} 上 —— 它自己是合法 JSON,解析完再撞上后面的
  // ` (current: ...`,于是报 "Unexpected non-whitespace character after JSON at position 20"。
  // 这条用实测到的原文当输入,不是我编的。
  it('ignores a stdout prefix that itself contains a JSON object (#3070)', () => {
    const noise = ' WARN  Unsupported engine: wanted: {"node":">=24.0.0"} '
      + '(current: {"node":"v22.23.0","pnpm":"10.28.2"})\n'
    // 夹具派生自真实 `playwright test --list --reporter=json` 产物(含 tests 数组 —— 解析器要求它非空),
    // 不是手写的形状。只把路径换成中性值。
    const report = {
          "config": {
                "rootDir": "/repo/e2e"
          },
          "suites": [
                {
                      "title": "settings-open.spec.ts",
                      "file": "sample.spec.ts",
                      "column": 0,
                      "line": 0,
                      "specs": [
                            {
                                  "title": "user opens the settings panel and sees settings sections",
                                  "ok": true,
                                  "tags": [],
                                  "tests": [
                                        {
                                              "timeout": 90000,
                                              "annotations": [],
                                              "expectedStatus": "passed",
                                              "projectId": "chromium",
                                              "projectName": "chromium",
                                              "results": [],
                                              "status": "skipped"
                                        }
                                  ],
                                  "id": "63f50525901f6276fc26-9996de69a7aac2038bb0",
                                  "file": "sample.spec.ts",
                                  "line": 16,
                                  "column": 5
                            }
                      ]
                }
          ],
          "errors": [],
          "stats": {
                "startTime": "2026-08-06T14:28:00.188Z",
                "duration": 43.794000000000096,
                "expected": 0,
                "skipped": 1,
                "unexpected": 0,
                "flaky": 0
          }
    }
    const files = parsePlaywrightList('/repo', noise + JSON.stringify(report))
    expect(files, '前缀里的 JSON 对象不得被当成报告').toEqual(['e2e/sample.spec.ts'])
  })
})
