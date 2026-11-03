import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'
import YAML from 'yaml'

const source = readFileSync('.github/workflows/ci-mac-build.yml', 'utf8')
const workflow = YAML.parse(source)
const route = workflow.jobs.route
const originalRef = 'GUYI-AI/gugu/.github/workflows/ci.yml@refs/pull/1700/merge'
const baseEvent = {
  action: 'synchronize',
  repository: { full_name: 'GUYI-AI/gugu', id: 1428236928 },
  pull_request: {
    number: 1700,
    head: { ref: 'integration/beta-20261103', repo: { full_name: 'GUYI-AI/gugu', id: 1428236928 } },
    base: { ref: 'dev', repo: { full_name: 'GUYI-AI/gugu', id: 1428236928 } }
  }
}

function decision(event: unknown, name = 'pull_request', ref = originalRef) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-mac-route-'))
  try {
    const eventPath = join(dir, 'event.json')
    const outputPath = join(dir, 'output')
    writeFileSync(eventPath, JSON.stringify(event))
    writeFileSync(outputPath, '')
    // Execute the actual frozen workflow body, not a second implementation of the predicate.
    const result = spawnSync('bash', ['-e', '-c', route.steps[0].run], {
      encoding: 'utf8', timeout: 10000,
      env: { ...process.env, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath,
        ORIGINAL_EVENT_NAME: name, ORIGINAL_WORKFLOW_REF: ref,
        INPUT_BUILD_REQUIRED: 'true', INPUT_RUNNER: 'gugu-public-mac1' }
    })
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' })
    const lines = readFileSync(outputPath, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^runner=\[/)
    return JSON.parse(lines[0].slice('runner='.length))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('fixed macOS callee original-event route', () => {
  it.each([
    ['.github/workflows/ci-mac-build.yml', 'true'],
    ['docs/ci-guide.md', 'false']
  ])('classifies the actual caller shell for %s', (changedPath, due) => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-mac-changes-'))
    try {
      const git = join(dir, 'git')
      const paths = join(dir, 'paths')
      const output = join(dir, 'output')
      writeFileSync(git, '#!/bin/sh\ncat "$CI_ROUTE_CHANGED_PATHS"\n')
      chmodSync(git, 0o700)
      writeFileSync(paths, changedPath + '\n')
      writeFileSync(output, '')
      const caller = YAML.parse(readFileSync('.github/workflows/ci.yml', 'utf8'))
      const body = caller.jobs.changes.steps.find((step: { id?: string }) => step.id === 'classify').run
      const result = spawnSync('bash', ['-e', '-c', body], {
        encoding: 'utf8', timeout: 10000,
        env: { ...process.env, PATH: dir + ':' + process.env.PATH, CI_ROUTE_CHANGED_PATHS: paths,
          GITHUB_OUTPUT: output, EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: 'GUYI-AI/gugu',
          PR_HEAD_REPOSITORY: 'GUYI-AI/gugu', PR_HEAD_REF: 'fix/fixture' }
      })
      expect(result.status).toBe(0)
      expect(readFileSync(output, 'utf8')).toBe(`build=${due}\ndesktop-mac=${due}\nandroid=${due}\n`)
      expect(result.stdout).toContain(`::notice title=ci-job-outputs::build=${due} desktop-mac=${due} android=${due}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.each(['opened', 'synchronize', 'reopened'])('allows the exact same-repository integration PR: %s', (action) => {
    expect(decision({ ...baseEvent, action })).toEqual(['self-hosted', 'macOS', 'ARM64', 'gugu-public-mac1'])
  })

  const rejected = [
    ['branch case', (e: typeof baseEvent) => { e.pull_request.head.ref = 'Integration/beta-20261103' }],
    ['branch suffix', (e: typeof baseEvent) => { e.pull_request.head.ref += '-other' }],
    ['fork', (e: typeof baseEvent) => { e.pull_request.head.repo.full_name = 'fork/gugu' }],
    ['head ID', (e: typeof baseEvent) => { e.pull_request.head.repo.id = 7 }],
    ['repository case', (e: typeof baseEvent) => { e.repository.full_name = 'guyi-ai/gugu' }],
    ['repository ID', (e: typeof baseEvent) => { e.repository.id = 7 }],
    ['base case', (e: typeof baseEvent) => { e.pull_request.base.ref = 'Dev' }],
    ['base repository', (e: typeof baseEvent) => { e.pull_request.base.repo.full_name = 'fork/gugu' }],
    ['PR number', (e: typeof baseEvent) => { e.pull_request.number = 1701 }],
    ['unknown action', (e: typeof baseEvent) => { e.action = 'edited' }]
  ] as const
  it.each(rejected)('routes %s to hosted despite caller-like inputs', (_label, mutate) => {
    const event = structuredClone(baseEvent)
    mutate(event)
    expect(decision(event)).toEqual(['macos-15'])
  })
  it.each([
    originalRef.replace('/ci.yml@', '/CI.yml@'),
    originalRef.replace('/.github/', '/.GitHub/'),
    originalRef.replace('GUYI-AI/', 'guyi-ai/'),
    originalRef.replace('/merge', '/Merge'),
    originalRef + '/extra',
    'GUYI-AI/gugu/.github/workflows/other.yml@refs/pull/1700/merge'
  ])('strictly rejects caller path/ref variant %s', (ref) => {
    expect(decision(baseEvent, 'pull_request', ref)).toEqual(['macos-15'])
  })
  it.each(['workflow_dispatch', 'pull_request_target', 'push', 'PULL_REQUEST'])('routes event %s to hosted', (event) => {
    expect(decision(baseEvent, event)).toEqual(['macos-15'])
  })
  it('keeps the trust decision in a hosted job and the original path decision only on Build', () => {
    expect(route['runs-on']).toBe('ubuntu-24.04')
    expect(route.steps[0].run).not.toContain('inputs.')
    expect(route.steps[0].uses).toBeUndefined()
    expect(workflow.jobs.build.needs).toBe('route')
    expect(workflow.jobs.build.if).toBe("inputs.build-required == 'true'")
    expect(workflow.jobs.build['runs-on']).toBe('${{ fromJSON(needs.route.outputs.runner) }}')
  })
})
