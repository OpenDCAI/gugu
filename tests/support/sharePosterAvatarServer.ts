import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import type { TestProject } from 'vitest/node'

declare module 'vitest' {
  export interface ProvidedContext { posterAvatarBase: string }
}

// A genuine second HTTP origin: no remote service, DNS alias or shared fixed port.
export default async function setup(project: TestProject) {
  const image = await readFile(new URL('../../apps/desktop/src/components/agentAvatar/assets/faces/agent-face-00.webp', import.meta.url))
  const server = createServer((request, response) => {
    if (request.url !== '/avatar.webp' && request.url !== '/blocked.webp') {
      response.writeHead(404).end()
      return
    }
    if (request.url === '/avatar.webp') response.setHeader('Access-Control-Allow-Origin', '*')
    response.setHeader('Content-Type', 'image/webp')
    response.setHeader('Connection', 'close')
    response.end(image)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  project.provide('posterAvatarBase', `http://127.0.0.1:${(server.address() as AddressInfo).port}`)
  return () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}
