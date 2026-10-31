import { isAbsolute, relative } from 'node:path'
import type {
  Reporter,
  SerializedError,
  TestCase,
  TestModule,
  TestRunEndReason,
  TestSpecification,
} from 'vitest/node'

type InFlightModule = {
  module: TestModule
  /** 只在 onTestModuleStart 之后才有;排队中的文件不算「在跑」。 */
  startedAt?: number
  activeCases: Map<string, { name: string; startedAt: number }>
}

const PREFIX = '[vitest-in-flight]'

// @@@in-flight-heartbeat (#4357) — 用例没有墙钟上限(vitest.config.ts 的 @@@no-case-budget),
// 真挂住时由 CI job 的 timeout-minutes 收场;job 被杀那一刻不会有 onTestRunEnd。所以在飞期间每隔
// 一段时间把「跑了多久还没完的文件/用例」报一行,日志最后几行就是卡住的位置。
// 只报告,不判定;同步阻塞的用例(execFileSync)也看得见文件,因为这行出自主进程 ——
// 但 worker 被同步卡住时连「用例开始」都发不出来,那时只能指到文件,行里会明说。
const DEFAULT_HEARTBEAT_MS = 60_000

function displayPath(moduleId: string): string {
  if (!isAbsolute(moduleId)) return moduleId
  const repoRelative = relative(process.cwd(), moduleId)
  return repoRelative.startsWith('..') ? moduleId : repoRelative
}

export class WorkerAttributionReporter implements Reporter {
  private readonly inFlight = new Map<string, InFlightModule>()

  private heartbeat: NodeJS.Timeout | undefined

  constructor(
    private readonly write: (text: string) => void = (text) => process.stderr.write(text),
    private readonly heartbeatMs: number = DEFAULT_HEARTBEAT_MS,
  ) {}

  onTestRunStart(_specifications: ReadonlyArray<TestSpecification>): void {
    this.inFlight.clear()
    clearInterval(this.heartbeat)
    this.heartbeat = setInterval(() => this.reportLongRunning(), this.heartbeatMs)
    this.heartbeat.unref()
  }

  onTestModuleQueued(module: TestModule): void {
    this.inFlight.set(module.id, { module, activeCases: new Map() })
  }

  onTestModuleStart(module: TestModule): void {
    const entry = this.inFlight.get(module.id)
    if (entry) {
      entry.module = module
      entry.startedAt = Date.now()
    } else {
      this.inFlight.set(module.id, { module, startedAt: Date.now(), activeCases: new Map() })
    }
  }

  onTestCaseReady(testCase: TestCase): void {
    const entry = this.inFlight.get(testCase.module.id)
    entry?.activeCases.set(testCase.id, { name: testCase.fullName, startedAt: Date.now() })
  }

  onTestCaseResult(testCase: TestCase): void {
    const entry = this.inFlight.get(testCase.module.id)
    entry?.activeCases.delete(testCase.id)
    const cases = [...testCase.module.children.allTests()]
    if (cases.length > 0 && cases.every((candidate) => candidate.result().state !== 'pending')) {
      this.inFlight.delete(testCase.module.id)
    }
  }

  onTestModuleEnd(module: TestModule): void {
    this.inFlight.delete(module.id)
  }

  private reportLongRunning(): void {
    const now = Date.now()
    const seconds = (since: number) => Math.round((now - since) / 1000)
    const lines: string[] = []
    for (const entry of this.inFlight.values()) {
      if (entry.startedAt === undefined || now - entry.startedAt < this.heartbeatMs) continue
      const cases = [...entry.activeCases.values()].filter((item) => now - item.startedAt >= this.heartbeatMs)
      lines.push(`${PREFIX} still running after ${seconds(entry.startedAt)}s: ${displayPath(entry.module.moduleId)}`)
      if (entry.activeCases.size === 0) {
        lines.push(`${PREFIX}   no case reported yet (the worker may be blocked synchronously)`)
      }
      lines.push(...cases.map((item) => `${PREFIX}   case running for ${seconds(item.startedAt)}s: ${item.name}`))
    }
    if (lines.length > 0) this.write(`${lines.join('\n')}\n`)
  }

  onTestRunEnd(
    _modules: ReadonlyArray<TestModule>,
    _unhandledErrors: ReadonlyArray<SerializedError>,
    reason: TestRunEndReason,
  ): void {
    clearInterval(this.heartbeat)
    this.heartbeat = undefined
    if (this.inFlight.size === 0) return

    const entries = [...this.inFlight.values()].sort((left, right) =>
      displayPath(left.module.moduleId).localeCompare(displayPath(right.module.moduleId)))
    const lines = [
      `${PREFIX} Test run ended with ${entries.length} file(s) that started but did not report completion `
        + `(reporter reason: ${reason}, unhandled errors: ${_unhandledErrors.length}).`,
      `${PREFIX} Candidate set (all in-flight files; not a single-file root-cause claim):`,
    ]
    for (const entry of entries) {
      lines.push(`${PREFIX} - ${displayPath(entry.module.moduleId)}`)
      const cases = [...entry.activeCases.values()].map((item) => item.name).sort()
      if (cases.length > 0) {
        lines.push(`${PREFIX}   unfinished test cases:`)
        lines.push(...cases.map((name) => `${PREFIX}   - ${name}`))
      }
    }
    this.write(`${lines.join('\n')}\n`)
  }
}
