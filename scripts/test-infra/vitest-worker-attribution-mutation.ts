import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'

const root = process.cwd()
const configPath = resolve(root, 'tests/mutation/vitest-worker-attribution/vitest.config.ts')
const attributionPrefix = '[vitest-in-flight]'

type Cell = {
  name: string
  file: string
  executableLine: string
  assertOutput: (output: string) => void
}

function printExecutableLine(cell: Cell): void {
  const source = readFileSync(cell.file, 'utf8').split('\n')
  const lineIndex = source.findIndex((line) => line.includes(cell.executableLine))
  if (lineIndex < 0) {
    throw new Error(`${cell.name}: executable mutation line is missing: ${cell.executableLine}`)
  }
  process.stdout.write(
    `[mutation:${cell.name}] source ${relative(root, cell.file)}:${lineIndex + 1}: ${source[lineIndex].trim()}\n`,
  )
}

function runCell(cell: Cell, env: NodeJS.ProcessEnv = process.env): Error | undefined {
  printExecutableLine(cell)
  // 不设墙钟预算:等的是子 vitest 退出这个事实;真挂住由调用方(CI job)的上限收场。
  const run = spawnSync(
    'pnpm',
    ['exec', 'vitest', 'run', '--config', configPath, cell.file, '--maxWorkers=1'],
    { cwd: root, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  )
  const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`
  process.stdout.write(`[mutation:${cell.name}] exit=${run.status ?? 'null'} signal=${run.signal ?? 'none'}\n${output}`)

  try {
    if (run.error) throw run.error
    if (run.status === 0) throw new Error(`${cell.name}: deliberately failing Vitest child unexpectedly passed`)
    cell.assertOutput(output)
    process.stdout.write(`[mutation:${cell.name}] PASS\n`)
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

const workerExitFile = resolve(root, 'tests/mutation/vitest-worker-attribution/worker-exit.mutation.ts')
const assertionFailureFile = resolve(root, 'tests/mutation/vitest-worker-attribution/assertion-failure.mutation.ts')
const blockedCaseFile = resolve(root, 'tests/mutation/vitest-worker-attribution/blocked-case.mutation.ts')
const failures = [
  runCell({
    name: 'worker-exit',
    file: workerExitFile,
    executableLine: "process.kill(process.pid, 'SIGKILL')",
    assertOutput(output) {
      if (!/Worker (?:forks emitted error|exited unexpectedly)/.test(output)) {
        throw new Error('worker-exit: Vitest did not independently report a worker process death')
      }
      const relativeFile = relative(root, workerExitFile)
      const attributedFiles = output
        .split(/\r?\n/)
        .filter((line) => line.startsWith(`${attributionPrefix} - `))
        .map((line) => line.slice(`${attributionPrefix} - `.length))
      if (attributedFiles.length !== 1 || attributedFiles[0] !== relativeFile) {
        throw new Error(
          `worker-exit: expected the exact in-flight set [${relativeFile}], received ${JSON.stringify(attributedFiles)}`,
        )
      }
    },
  }),
  runCell({
    name: 'assertion-failure-control',
    file: assertionFailureFile,
    executableLine: "expect('actual assertion value').toBe('expected assertion value')",
    assertOutput(output) {
      const relativeFile = relative(root, assertionFailureFile)
      for (const expected of [relativeFile, 'keeps Vitest assertion attribution intact', 'expected assertion value']) {
        if (!output.includes(expected)) {
          throw new Error(`assertion-failure-control: native Vitest output is missing ${JSON.stringify(expected)}`)
        }
      }
      if (output.includes(attributionPrefix)) {
        throw new Error('assertion-failure-control: ordinary assertion failure was rewritten as in-flight')
      }
    },
  }),
  runCell(
    {
      name: 'blocked-case-heartbeat',
      file: blockedCaseFile,
      executableLine: "spawnSync('/bin/sleep', ['2'])",
      assertOutput(output) {
        const relativeFile = relative(root, blockedCaseFile)
        const heartbeat = output
          .split(/\r?\n/)
          .find((line) => line.startsWith(`${attributionPrefix} still running after `) && line.endsWith(relativeFile))
        if (!heartbeat) {
          throw new Error('blocked-case-heartbeat: no in-flight heartbeat named the synchronously blocked file')
        }
        // worker 被同步卡住时发不出「用例开始」,心跳只能指到文件 —— 它必须把这一点说出来,❌ 不许沉默。
        if (!output.includes(`${attributionPrefix}   no case reported yet (the worker may be blocked synchronously)`)) {
          throw new Error('blocked-case-heartbeat: the heartbeat did not say that the blocked case is not yet reported')
        }
      },
    },
    { ...process.env, GUGU_IN_FLIGHT_HEARTBEAT_MS: '250' },
  ),
].filter((failure): failure is Error => failure !== undefined)

if (failures.length > 0) {
  throw new AggregateError(failures, 'Vitest worker attribution mutation failed')
}

process.stdout.write('[vitest-worker-attribution-mutation] PASS\n')
