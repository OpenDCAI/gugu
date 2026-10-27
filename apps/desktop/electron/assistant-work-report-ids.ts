import { createHash } from 'node:crypto'
import { currentGuguToolInvocation } from './mcp/tool-call-context.mjs'

/** Retries share a call identity; identical arguments from a new invocation are a new report. */
export function createDesktopWorkReportIds(sessionId: string, invocation = currentGuguToolInvocation()): () => string {
  if (!invocation) throw new Error('Work report requires an MCP invocation identity')
  const intent = JSON.stringify(['desktop-work-report', sessionId, invocation])
  let sequence = 0
  return () => {
    const hex = createHash('sha256').update(JSON.stringify([intent,sequence++])).digest('hex')
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`
  }
}
