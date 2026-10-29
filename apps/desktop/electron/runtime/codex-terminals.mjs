/** Command facts travel as a terminal entity, including history's final snapshot. */
export function codexTerminalUpdate(item, terminalId = item.id, completed = false) {
  if (item.type !== 'commandExecution') return null
  return {
    sessionUpdate: 'terminal_update', terminalId: String(terminalId),
    ...(typeof item.command === 'string' ? { command: item.command } : {}),
    ...(typeof item.cwd === 'string' ? { cwd: item.cwd } : {}),
    ...(typeof item.aggregatedOutput === 'string' ? { output: { data: Buffer.from(item.aggregatedOutput, 'utf8').toString('base64') } } : {}),
    ...(completed || typeof item.exitCode === 'number' ? { exitStatus: { exitCode: item.exitCode ?? null } } : {}),
  }
}
