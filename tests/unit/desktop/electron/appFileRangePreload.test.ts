// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { createAppFiles, type FilesPlatform } from '../../../../apps/desktop/src/session/shared/extensions/app-files-core'
import type { GuguHost } from '../../../../apps/desktop/src/session/app-runtime/host'

const wire = vi.hoisted(() => ({ host: undefined as unknown, answer: async (_args: unknown): Promise<unknown> => undefined }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_name: string, host: unknown) => { wire.host = host } },
  ipcRenderer: {
    // The real preload handles the response; structured clone models its IPC boundary here.
    invoke: async (_channel: string, request: { args: unknown }) => structuredClone({ ok: true, value: await wire.answer(request.args) }),
    on: vi.fn(), send: vi.fn(), sendSync: () => 'light',
  },
}))
vi.mock('../../../../apps/desktop/electron/process-metrics-responder', () => ({ installProcessMetricsResponder: vi.fn() }))

it('keeps a verified range binary through the desktop preload host members', async () => {
  const item = '44444444-4444-4444-8444-444444444444'
  const owner = '11111111-1111-4111-8111-111111111111'
  const backing = new Uint8Array([199, 0, 255, 128, 199])
  const platform = {
    account: async () => ({ userId: owner }), hasCapability: () => false,
    sync: { pageFor: () => ({}) },
    resolveFile: async () => ({ status: 'ready', reader: { accountId: owner, actorId: owner },
      revision: { item_id: item, version: 1, size_bytes: 3 }, read: async () => backing.subarray(1, 4), dispose: async () => {},
    }),
  } as unknown as FilesPlatform
  const files = createAppFiles(platform)
  wire.answer = args => files.read({ pageId: 77, extensionId: 'reader', itemId: item }, args as Parameters<typeof files.read>[1])
  await import('../../../../apps/desktop/electron/extension-bridge-preload')
  const delivered = structuredClone(await (wire.host as GuguHost).appFiles.read({ ref: { id: item, version: 1 }, offset: 0, length: 3 }))
  expect(delivered.data).toBeInstanceOf(structuredClone(new Uint8Array()).constructor)
  expect([...delivered.data]).toEqual([0, 255, 128])
  expect(delivered.data.byteOffset).toBe(0)
  expect(delivered.data.buffer.byteLength).toBe(3)
  await files.close({ pageId: 77, extensionId: 'reader', itemId: item }, { ref: { id: item, version: 1 } })
})
