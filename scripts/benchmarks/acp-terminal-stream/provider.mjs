import { createInterface } from 'node:readline'
import { once } from 'node:events'
async function write(message) {
  if (!process.stdout.write(JSON.stringify(message) + '\n')) await once(process.stdout, 'drain')
}
const reader = createInterface({ input: process.stdin })
reader.on('line', async (line) => {
  const request = JSON.parse(line)
  let result = {}
  if (request.method === 'initialize')
    result = {
      protocolVersion: 2,
      info: { name: 'memory-fixture', version: '1' },
      capabilities: {}
    }
  if (request.method === 'session/new') result = { sessionId: 'provider' }
  if (request.id !== undefined) await write({ jsonrpc: '2.0', id: request.id, result })
  if (request.method === 'session/new')
    setTimeout(async () => {
      const emit = (update) =>
        write({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId: 'provider', update }
        })
      await emit({
        sessionUpdate: 'terminal_update',
        terminalId: 'bench',
        command: '25 MiB fixture'
      })
      const data = Buffer.alloc(64 * 1024, 65).toString('base64')
      for (let n = 0; n < 400; n++) {
        await emit({ sessionUpdate: 'terminal_output_chunk', terminalId: 'bench', data })
        await new Promise((r) => setTimeout(r, 8))
      }
      await emit({
        sessionUpdate: 'terminal_update',
        terminalId: 'bench',
        exitStatus: { exitCode: 0 }
      })
    }, 1500)
})
