import { expect, it } from 'vitest'
import { SESSION_TOOL_DEFS } from '../../../apps/desktop/electron/mcp/gugu-session-tool'
import { assertWorkReportArgument } from '../../../apps/desktop/src/session/shared/assistant-work'

it('refuses a misplaced result before sending and accepts the same report as a structured argument', () => {
  const report = { work_id: 'c883f636-91eb-40a4-b06a-d2f1a73b2dfc', status: 'completed' }
  const text = `【work_result】work_id=${report.work_id} status=completed\nOriginal file verified.`
  const schema = SESSION_TOOL_DEFS.find(tool => tool.name === 'session_message')!.schema
  const message = { to: ['session:coordinator'], text }
  expect(() => assertWorkReportArgument(message)).toThrow('not in text')
  expect(schema.safeParse(message).success).toBe(false)
  expect(schema.safeParse({ ...message, work_result: report }).success).toBe(true)
})

it('leaves ordinary progress and questions alone rather than inferring their terminal status', () => {
  expect(() => assertWorkReportArgument({ text: 'File upload is complete; verification is still pending.' })).not.toThrow()
  expect(() => assertWorkReportArgument({ text: 'Please use session_message work_result={work_id,status} to report later.' })).not.toThrow()
})
