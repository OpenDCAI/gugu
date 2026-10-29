/** One owner for task-local boot failures. Shared infrastructure enumeration remains outside this boundary. */
export interface SessionBootFailure {
  operation: string
  taskId: string
  message: string
}

export class SessionBootTasks {
  private readonly failures = new Map<string, SessionBootFailure>()

  constructor(private readonly report: (failure: SessionBootFailure) => void) {}

  record(operation: string, taskId: string, error: unknown): void {
    const failure = { operation, taskId, message: error instanceof Error ? error.message : String(error) }
    this.failures.set(`${operation}:${taskId}`, failure)
    this.report(failure)
  }

  snapshot(): SessionBootFailure[] { return [...this.failures.values()] }

  runSync<T>(operation: string, taskId: string, work: () => T): T | undefined {
    try { return work() } catch (error) { this.record(operation, taskId, error); return undefined }
  }

  async run<T>(operation: string, taskId: string, work: () => T | Promise<T>): Promise<T | undefined> {
    try { return await work() } catch (error) { this.record(operation, taskId, error); return undefined }
  }
}

/** A malformed diagnostic must never turn an online device into a failed heartbeat. */
export function parseSessionBootFailures(value: unknown): SessionBootFailure[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return []
    const row = item as Record<string, unknown>
    return typeof row.operation === 'string' && typeof row.taskId === 'string' && typeof row.message === 'string'
      ? [{ operation: row.operation.slice(0, 80), taskId: row.taskId.slice(0, 128), message: row.message.slice(0, 500) }] : []
  }).slice(0, 100)
}
