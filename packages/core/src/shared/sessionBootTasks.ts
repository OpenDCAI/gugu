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
    let message = 'Boot operation failed (error could not be read)'
    try { message = String(error instanceof Error ? error.message : error).slice(0, 500) } catch { /* Diagnostics cannot escape the task boundary. */ }
    const failure = { operation: operation.slice(0, 80), taskId: taskId.slice(0, 128), message }
    const key = `${operation}:${taskId}`
    this.failures.delete(key)
    this.failures.set(key, failure)
    while (this.failures.size > 100) this.failures.delete(this.failures.keys().next().value!)
    try { this.report(failure) } catch { /* A broken logger must not terminate boot either. */ }
  }

  snapshot(): SessionBootFailure[] { return [...this.failures.values()] }

  clearTask(taskId: string): void {
    for (const [key, failure] of this.failures) if (failure.taskId === taskId) this.failures.delete(key)
  }

  runSync<T>(operation: string, taskId: string, work: () => T): T | undefined {
    try { const result = work(); this.failures.delete(`${operation}:${taskId}`); return result } catch (error) { this.record(operation, taskId, error); return undefined }
  }

  async run<T>(operation: string, taskId: string, work: () => T | Promise<T>): Promise<T | undefined> {
    try { const result = await work(); this.failures.delete(`${operation}:${taskId}`); return result } catch (error) { this.record(operation, taskId, error); return undefined }
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
