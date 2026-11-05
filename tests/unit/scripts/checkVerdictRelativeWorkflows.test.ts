import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  deriveCheckProfiles, evaluateCheckSnapshots, loadWorkflowInventory,
} from '../../../scripts/ci/check-verdict.mts'

function inRepository(files: Record<string, string>, test: (root: string, git: (...args: string[]) => string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'gugu-verdict-relative-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  try {
    git('init', '-q')
    git('config', 'user.name', 'Workflow fixture')
    git('config', 'user.email', 'workflow@example.test')
    for (const [path, source] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), source)
    }
    git('add', '.')
    git('commit', '-qm', 'workflow fixture')
    test(root, git)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const ci = `on: pull_request
jobs:
  build:
    name: Build
    uses: ./.github/workflows/child.yml
`
const child = `on: workflow_call
jobs:
  unit:
    name: Unit checks
    runs-on: fixture
  lint:
    name: Lint
    runs-on: fixture
`
const prProfiles = (root: string, sha: string) => deriveCheckProfiles([{
  id: 'pull_request:#1', type: 'pull_request', action: 'synchronize', baseRef: 'dev',
  inventoryRef: sha, changedPaths: ['src/change.ts'], workflows: loadWorkflowInventory(root, sha),
}])

describe('relative reusable workflow inventory', () => {
  it('reads the caller commit, expands child checks, and ignores uncommitted child edits', () => {
    inRepository({ '.github/workflows/ci.yml': ci, '.github/workflows/child.yml': child }, (root, git) => {
      const sha = git('rev-parse', 'HEAD')
      writeFileSync(join(root, '.github/workflows/child.yml'), child.replace('Unit checks', 'Uncommitted check'))
      const profiles = prProfiles(root, sha)
      expect(profiles.flatMap(profile => profile.checks)).toEqual(['Build / Lint', 'Build / Unit checks'])
      const runs = ['Build / Lint', 'Build / Unit checks'].map((name, id) => ({
        id, event: 'pull_request', name, status: 'completed', conclusion: 'success',
      }))
      expect(evaluateCheckSnapshots(profiles, [runs, runs]).verdict).toBe('GREEN')
      expect(evaluateCheckSnapshots(profiles, [runs.slice(1), runs.slice(1)]).verdict).toBe('INCOMPLETE')
      for (const conclusion of ['failure', 'skipped']) {
        const failed = [{ ...runs[0], conclusion }, runs[1]]
        expect(evaluateCheckSnapshots(profiles, [failed, failed]).verdict).toBe('RED')
      }
    })
  })

  it('does not reject a PR because an unrelated manual workflow calls a relative child', () => {
    inRepository({
      '.github/workflows/ci.yml': 'on: pull_request\njobs:\n  check:\n    runs-on: fixture\n',
      '.github/workflows/manual.yml': `on: workflow_dispatch
jobs:
  retention:
    if: inputs.publish == 'true'
    uses: ./.github/workflows/child.yml
`,
      '.github/workflows/child.yml': child,
    }, (root, git) => {
      expect(prProfiles(root, git('rev-parse', 'HEAD')).flatMap(profile => profile.checks)).toEqual(['check'])
    })
  })

  it('resolves a nested relative call at the pinned callee commit rather than the PR head', () => {
    inRepository({
      '.github/workflows/ci.yml': 'on: pull_request\njobs:\n  check:\n    runs-on: fixture\n',
      '.github/workflows/outer.yml': 'on: workflow_call\njobs:\n  inner:\n    uses: ./.github/workflows/child.yml\n',
      '.github/workflows/child.yml': child,
    }, (root, git) => {
      const pin = git('rev-parse', 'HEAD')
      writeFileSync(join(root, '.github/workflows/ci.yml'), `on: pull_request
jobs:
  build:
    uses: GUYI-AI/gugu/.github/workflows/outer.yml@${pin}
`)
      writeFileSync(join(root, '.github/workflows/child.yml'), child.replace('Unit checks', 'Different head check'))
      git('add', '.')
      git('commit', '-qm', 'change caller and current child')
      expect(prProfiles(root, git('rev-parse', 'HEAD')).flatMap(profile => profile.checks))
        .toEqual(['build / inner / Lint', 'build / inner / Unit checks'])
    })
  })

  it('includes the exact relative child bytes in the generation digest', () => {
    inRepository({ '.github/workflows/ci.yml': ci, '.github/workflows/child.yml': child }, (root, git) => {
      const before = prProfiles(root, git('rev-parse', 'HEAD'))[0].generation
      writeFileSync(join(root, '.github/workflows/child.yml'), child + '\n# New committed child bytes\n')
      git('add', '.')
      git('commit', '-qm', 'change child bytes')
      expect(prProfiles(root, git('rev-parse', 'HEAD'))[0].generation).not.toBe(before)
    })
  })

  it('still refuses a missing local callee rather than treating it as a skipped check', () => {
    inRepository({ '.github/workflows/ci.yml': ci }, (root, git) => {
      expect(() => prProfiles(root, git('rev-parse', 'HEAD'))).toThrow()
    })
  })

  it('still refuses cycles across relative reusable calls', () => {
    inRepository({
      '.github/workflows/ci.yml': ci,
      '.github/workflows/child.yml': 'on: workflow_call\njobs:\n  cycle:\n    uses: ./.github/workflows/ci.yml\n',
    }, (root, git) => {
      expect(() => prProfiles(root, git('rev-parse', 'HEAD'))).toThrow('cyclic')
    })
  })
})
