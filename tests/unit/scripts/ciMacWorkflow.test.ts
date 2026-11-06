import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import YAML from 'yaml'
import { deriveCheckProfiles } from '../../../scripts/ci/check-verdict.mts'

const ci = YAML.parse(readFileSync('.github/workflows/ci.yml', 'utf8'))
const devMacSource = readFileSync('.github/workflows/ci-dev-mac.yml', 'utf8')
const devMac = YAML.parse(devMacSource)
const devLinuxSource = readFileSync('.github/workflows/ci-dev-linux.yml', 'utf8')
const devLinux = YAML.parse(devLinuxSource)
const classifyScript = ci.jobs.changes.steps.find((step: { id?: string }) => step.id === 'classify').run

function classify(files: string[], env: Record<string, string> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-mac-classify-'))
  try {
    const output = path.join(root, 'outputs')
    // Supply the diff at the shell boundary; never consult the real checkout or a network remote.
    const diff = 'git() { [ "$*" = "diff --name-only HEAD^1 HEAD" ] || return 98; printf "%s\\n" "$CLASSIFIER_FILES"; }\n'
    execFileSync('/bin/bash', ['--noprofile', '--norc', '-e', '-c', diff + classifyScript], {
      cwd: root,
      env: {
        PATH: `${root}:/usr/bin:/bin`,
        HOME: process.env.HOME,
        BASH_ENV: '/dev/null',
        GITHUB_OUTPUT: output,
        CLASSIFIER_FILES: files.join('\n'),
        EVENT_NAME: 'pull_request',
        GITHUB_REPOSITORY: 'GUYI-AI/gugu',
        PR_HEAD_REPOSITORY: 'GUYI-AI/gugu',
        PR_HEAD_REF: 'fix/example',
        ...env,
      },
    })
    return Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map(line => line.split('=')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('PR macOS path classification', () => {
  it.each([
    '.github/workflows/ci.yml', '.github/actions/setup-community/action.yml',
    '.node-version', '.npmrc', 'package.json', 'packages/core/package.json',
    'apps/desktop/package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'patches/native.patch',
  ])('%s requires every platform build', file => {
    expect(classify([file])).toEqual({ build: 'true', 'desktop-mac': 'true', 'desktop-linux': 'true', android: 'true', tests: 'true' })
  })

  it.each(['apps/desktop/native/addon.cc', 'apps/desktop/session-tooling/node-deps/package-lock.json'])(
    '%s requires Mac without adding Android', file => {
      expect(classify([file])).toEqual({ build: 'true', 'desktop-mac': 'true', 'desktop-linux': 'true', android: 'false', tests: 'true' })
    },
  )

  it.each([
    'apps/desktop/src/App.tsx', 'scripts/build-provenance.mjs', 'scripts/ci/check-verdict.mts',
    'vite.config.mts', 'electron-builder.cjs', 'build-resources/icon.icns',
    '.github/workflows/ci-dev-mac.yml', '.github/workflows/ci-dev-linux.yml',
  ])('%s still builds Linux/web without requiring PR Mac', file => {
    expect(classify([file])).toEqual({ build: 'true', 'desktop-mac': 'false', 'desktop-linux': 'true', android: 'false', tests: 'true' })
  })

  it.each(['apps/mobile/src/main.ts', 'capacitor.config.ts', 'scripts/build/android-gradle-build.sh', 'scripts/build/phone-web-dir.mts'])(
    '%s preserves Android without requiring Mac', file => {
      expect(classify([file])).toEqual({ build: 'true', 'desktop-mac': 'false', 'desktop-linux': 'false', android: 'true', tests: 'true' })
    },
  )

  it('preserves documentation skips and combines mixed file lists', () => {
    expect(classify(['README.md', 'docs/guide.txt', '.github/actions/README.md']))
      .toEqual({ build: 'false', 'desktop-mac': 'false', 'desktop-linux': 'false', android: 'false', tests: 'false' })
    expect(classify(['apps/desktop/src/App.tsx', 'apps/desktop/native/addon.cc', 'apps/mobile/src/main.ts']))
      .toEqual({ build: 'true', 'desktop-mac': 'true', 'desktop-linux': 'true', android: 'true', tests: 'true' })
  })

  it('preserves the exact integration bypass and manual full build', () => {
    const full = { build: 'true', 'desktop-mac': 'true', 'desktop-linux': 'true', android: 'true', tests: 'true' }
    expect(classify(['README.md'], { PR_HEAD_REF: 'integration/beta-20261103' })).toEqual(full)
    expect(classify([], { EVENT_NAME: 'workflow_dispatch' })).toEqual(full)
    expect(classify(['README.md'], {
      PR_HEAD_REF: 'integration/beta-20261103', PR_HEAD_REPOSITORY: 'contributor/gugu',
    })).toEqual({ build: 'false', 'desktop-mac': 'false', 'desktop-linux': 'false', android: 'false', tests: 'false' })
    expect(classify(['README.md'], { PR_HEAD_REF: 'Integration/beta-20261103' }))
      .toEqual({ build: 'false', 'desktop-mac': 'false', 'desktop-linux': 'false', android: 'false', tests: 'false' })
  })
})

describe('dev verification workflow contracts', () => {
  const job = devMac.jobs['desktop-build-mac']
  const report = job.steps.at(-1)

  it('keeps Mac automatic and Linux manual-only with separate cancellation groups', () => {
    expect(devMac.on).toEqual({ push: { branches: ['dev'] }, workflow_dispatch: null })
    expect(devLinux.on).toEqual({ workflow_dispatch: null })
    expect(devLinuxSource).toContain('Tomorrow, restore push with branches: [dev]')
    expect(ci.on).not.toHaveProperty('push')
    expect(devMac.concurrency).toEqual({ group: 'community-ci-dev-mac', 'cancel-in-progress': true })
    expect(devLinux.concurrency).toEqual({ group: 'community-ci-dev-linux', 'cancel-in-progress': true })
    expect(Object.keys(devMac.jobs)).toEqual(['desktop-build-mac'])
    expect(Object.keys(devLinux.jobs)).toEqual(['linux-checks', 'typecheck'])
    expect((Object.values(devLinux.jobs) as Array<{ concurrency?: unknown }>).every((job) => job.concurrency === undefined))
      .toBe(true)
  })

  it('keeps all hosted Mac steps, environments and timeout identical before reporting', () => {
    const [calleePath, sha] = ci.jobs['desktop-build-mac'].uses.replace('GUYI-AI/gugu/', '').split('@')
    const original = YAML.parse(execFileSync('git', ['show', `${sha}:${calleePath}`], { encoding: 'utf8' })).jobs.build
    expect(job['runs-on']).toBe('macos-15')
    expect(job['timeout-minutes']).toBe(original['timeout-minutes'])
    expect(devMac.env).toEqual(ci.env)
    expect(job.env).toEqual(original.env)
    expect(job.steps.slice(0, -1)).toEqual(original.steps.slice(1).map((step: { uses?: string; with?: unknown }) => {
      if (step.uses === 'actions/checkout@v4') return { uses: step.uses }
      return step
    }))
    expect(report.if).toBe('failure()')
    expect(report.uses).toBe('actions/github-script@v7')
    expect(devMac.permissions).toEqual({ contents: 'read', actions: 'read' })
    expect(job.permissions).toEqual({ contents: 'read', actions: 'read', issues: 'write' })
  })

  it('copies the same six Linux unit shards and runs typecheck once in its own job', () => {
    const original = ci.jobs.unit
    const linux = devLinux.jobs['linux-checks']
    expect(linux['runs-on']).toBe(original['runs-on'])
    expect(linux.strategy).toEqual(original.strategy)
    expect(linux.env).toEqual(original.env)
    expect(linux.steps.slice(0, -1)).toEqual(original.steps.map(({ if: _condition, ...step }: { if?: unknown }) => step))
    expect(linux.permissions).toEqual({ contents: 'read', actions: 'read', issues: 'write' })
    expect(linux.steps.at(-1).if).toBe('failure()')
    const typecheck = devLinux.jobs.typecheck
    expect(typecheck['runs-on']).toBe('ubuntu-24.04')
    expect(typecheck.strategy).toBeUndefined()
    expect(typecheck.steps.filter((step: { run?: string }) => step.run).map((step: { run: string }) => step.run))
      .toEqual(['pnpm typecheck'])
    expect(ci.jobs.policy.steps.some((step: { run?: string }) => step.run === 'pnpm typecheck')).toBe(true)
    expect(typecheck.permissions).toEqual({ contents: 'read', actions: 'read', issues: 'write' })
    expect(devLinux.env).toEqual(devMac.env)
    expect(devLinux.permissions).toEqual(devMac.permissions)
  })

  it('canonical derives only Mac on dev push and all eight checks on manual runs', () => {
    const workflows = [
      { path: '.github/workflows/ci-dev-mac.yml', source: devMacSource },
      { path: '.github/workflows/ci-dev-linux.yml', source: devLinuxSource },
    ]
    const event = { id: 'push:dev', type: 'push', ref: 'refs/heads/dev', changedPaths: ['README.md'], inventoryRef: 'candidate', workflows }
    const profiles = deriveCheckProfiles([event])
    expect(profiles).toHaveLength(1)
    expect(profiles[0].checks).toEqual(['Dev desktop app build (macos-15)'])
    const manual = deriveCheckProfiles([{ ...event, id: 'manual', type: 'workflow_dispatch' }])
    expect(manual.flatMap(profile => profile.checks).sort()).toEqual([
      ...Array.from({ length: 6 }, (_, i) => `Dev Linux checks (${i + 1}/6)`),
      'Dev typecheck',
      'Dev desktop app build (macos-15)',
    ].sort())
    expect(deriveCheckProfiles([{ ...event, id: 'push:main', ref: 'refs/heads/main' }])[0].checks).toEqual([])
    expect(deriveCheckProfiles([{ ...event, id: 'pr', type: 'pull_request', ref: 'refs/pull/1/merge', baseRef: 'dev' }])[0].checks).toEqual([])
  })

  function fixture(existing: object[] = [], reportingStep = report) {
    const issues = {
      getLabel: vi.fn().mockResolvedValue({}), createLabel: vi.fn().mockResolvedValue({}),
      listForRepo: vi.fn(), create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}),
    }
    const github = { rest: { issues }, paginate: vi.fn().mockResolvedValue(existing) }
    const context = {
      repo: { owner: 'GUYI-AI', repo: 'gugu' }, sha: 'a'.repeat(40), runId: 42,
      actor: 'fallback-user', payload: { sender: { login: 'merge-user' } },
    }
    const run = () => runInNewContext(`(async () => { ${reportingStep.with.script} })()`, {
      github, context, process: { env: { GITHUB_SERVER_URL: 'https://github.com', CI_UNIT_SHARD: '2' } },
    }) as Promise<void>
    return { issues, github, context, run }
  }

  it('creates a labeled English issue with full source, run and merge/push actor', async () => {
    const f = fixture()
    f.issues.getLabel.mockRejectedValueOnce(Object.assign(new Error('not found'), { status: 404 }))
    await f.run()
    expect(f.issues.createLabel).toHaveBeenCalledOnce()
    expect(f.issues.create).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Dev Mac build failed at aaaaaaa', labels: ['ci-mac-red'],
      body: expect.stringContaining('Run: https://github.com/GUYI-AI/gugu/actions/runs/42'),
    }))
    const body = f.issues.create.mock.calls[0][0].body
    expect(body).toContain(`<!-- ci-dev-mac:${'a'.repeat(40)} -->`)
    expect(body).toContain('Merged/pushed by: @merge-user')
    expect(f.issues.update).not.toHaveBeenCalled()
  })

  it('updates/reopens the same SHA issue on retry and ignores a PR with matching text', async () => {
    const marker = `<!-- ci-dev-mac:${'a'.repeat(40)} -->`
    const f = fixture([{ number: 1, body: marker, pull_request: {} }, { number: 2, body: marker, state: 'closed' }])
    await f.run()
    expect(f.issues.update).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 2, state: 'open' }))
    expect(f.issues.create).not.toHaveBeenCalled()
  })

  it('handles a competing label creator but does not swallow unrelated API errors', async () => {
    const f = fixture()
    f.issues.getLabel.mockRejectedValueOnce(Object.assign(new Error('not found'), { status: 404 }))
    f.issues.createLabel.mockRejectedValueOnce(Object.assign(new Error('exists'), { status: 422 }))
    await f.run()
    expect(f.issues.getLabel).toHaveBeenCalledTimes(2)
    const denied = fixture()
    denied.issues.getLabel.mockRejectedValueOnce(Object.assign(new Error('denied'), { status: 403 }))
    await expect(denied.run()).rejects.toThrow('denied')
    expect(denied.issues.create).not.toHaveBeenCalled()
  })

  it('reports Linux failures separately and keys retries by SHA and shard', async () => {
    const step = devLinux.jobs['linux-checks'].steps.at(-1)
    const f = fixture([], step)
    await f.run()
    expect(f.issues.create).toHaveBeenCalledWith(expect.objectContaining({
      labels: ['ci-dev-red'], title: 'Dev Linux checks failed at aaaaaaa (shard 2/6)',
      body: expect.stringContaining(`ci-dev-linux:${'a'.repeat(40)}:shard-2`),
    }))
    const retry = fixture([{ number: 3, body: `<!-- ci-dev-linux:${'a'.repeat(40)}:shard-2 -->` }], step)
    await retry.run()
    expect(retry.issues.update).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 3 }))
    expect(retry.issues.create).not.toHaveBeenCalled()
    const typecheck = fixture([], devLinux.jobs.typecheck.steps.at(-1))
    await typecheck.run()
    expect(typecheck.issues.create).toHaveBeenCalledWith(expect.objectContaining({
      labels: ['ci-dev-red'], title: 'Dev typecheck failed at aaaaaaa',
      body: expect.stringContaining(`ci-dev-typecheck:${'a'.repeat(40)}`),
    }))
  })
})
