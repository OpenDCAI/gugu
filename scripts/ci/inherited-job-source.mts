/** GitHub gives an unexecuted job a new check ID on a partial workflow rerun.
 * Its original attempt, execution times and steps identify the execution whose annotations it inherits.
 */
export interface WorkflowJob {
  run_id: number
  run_attempt: number
  check_run_url: string
  name: string
  status: string
  conclusion: string | null
  started_at: string | null
  completed_at: string | null
  steps?: Array<{
    number: number
    name: string
    status: string
    conclusion: string | null
    started_at: string | null
    completed_at: string | null
  }>
}

function execution(job: WorkflowJob): string | undefined {
  if (job.status !== 'completed' || job.conclusion !== 'success'
    || !Number.isSafeInteger(job.run_attempt) || job.run_attempt < 1
    || !job.started_at || !job.completed_at
    || !Number.isFinite(Date.parse(job.started_at)) || !Number.isFinite(Date.parse(job.completed_at))
    || Date.parse(job.completed_at) < Date.parse(job.started_at)
    || !Array.isArray(job.steps) || job.steps.length === 0) return undefined
  const steps = []
  for (const step of job.steps) {
    if (!Number.isSafeInteger(step.number) || !step.name || step.status !== 'completed'
      || typeof step.conclusion !== 'string' || !step.started_at || !step.completed_at
      || !Number.isFinite(Date.parse(step.started_at)) || !Number.isFinite(Date.parse(step.completed_at))
      || Date.parse(step.completed_at) < Date.parse(step.started_at)) return undefined
    steps.push([step.number, step.name, step.status, step.conclusion, step.started_at, step.completed_at])
  }
  return JSON.stringify([job.run_id, job.name, job.started_at, job.completed_at, steps])
}

/** Only an identical, successful execution in an earlier attempt of this workflow can supply annotations.
 * A genuinely rerun job, incomplete metadata or ambiguous original is not evidence of inheritance.
 */
export function inheritedJobSource(checkRunId: number, workflowRunId: number, jobs: WorkflowJob[]): number | undefined {
  const current = jobs.filter(job => job.run_id === workflowRunId && job.check_run_url?.endsWith(`/check-runs/${checkRunId}`))
  if (current.length !== 1) return undefined
  const target = current[0]
  const fingerprint = execution(target)
  if (!fingerprint || target.run_attempt <= 1) return undefined
  const previous = jobs.filter(job => job.run_id === workflowRunId && job.run_attempt < target.run_attempt
    && execution(job) === fingerprint)
  const firstAttempt = Math.min(...previous.map(job => job.run_attempt))
  const originals = previous.filter(job => job.run_attempt === firstAttempt)
  if (originals.length !== 1) return undefined
  const prefix = target.check_run_url.slice(0, target.check_run_url.lastIndexOf('/') + 1)
  const url = originals[0].check_run_url
  if (!url?.startsWith(prefix)) return undefined
  const originalId = Number(url.slice(prefix.length))
  return Number.isSafeInteger(originalId) && originalId > 0 && originalId < checkRunId ? originalId : undefined
}
