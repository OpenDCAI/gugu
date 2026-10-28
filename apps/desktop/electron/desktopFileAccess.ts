import type { RuntimeAuth } from '@gugu/core'
import type { DeviceRpcHandlers } from '@gugu/core/cloud/deviceRpcResponder'
import { readFile } from 'node:fs/promises'
import { readCachedDeviceId } from '@gugu/core/cloud/deviceRuntime'
import { attachmentRequest, configuredEndpoint } from '@gugu/core/cloud/attachmentsApi'
import { createFileMetadataLoader } from '@gugu/core/cloud/fileMetadata'
import { cloudFileProviders } from '@gugu/core/cloud/fileProviders'
import { createFileChunkCache, createFileSink, saveFileHandle } from '@gugu/core/local/files/fileSnapshots'
import { createFileResolver, type FileContext, type FileRef, type FileRevision } from '@gugu/core/shared/fileResolver'
import { PROJECT_FILE_READ, createProjectFileReader, localProjectFileProvider } from './projectFileHost'
import { ownSshFileProvider, type HeldFileSshLinks } from './projectFileSsh'
import { createProjectTransferHost } from './projectFileTransferHost'
import { findProjectFileByName, type ProjectFileVersionLookup } from './sessionpage/sessionpage-project-groups'
import type { setAccountFileResolver } from './session/main/core/extensions/account-token'
import { createProjectFilePublisher } from './projectFilePublication'

/** One composition root for native IPC, Apps, MCP and inbox. Identity lookup here never registers or refreshes. */
export function createDesktopFileAccess(deps: {
  auth(): Promise<RuntimeAuth | null>; root(projectId: string): Promise<string | null>
  links(): HeldFileSshLinks | null; tempRoot: string; downloads: string; fetch: typeof fetch; env?: NodeJS.ProcessEnv
  rpc(name: string, args: Record<string, unknown>): Promise<unknown>
}) {
  const identity = async () => {
    const auth = await deps.auth(); if (!auth) throw new Error('File reader is not signed in')
    return { accountId: auth.userId, deviceId: await readCachedDeviceId(deps.env, auth.userId) }
  }
  const endpoint = async (context?: FileContext) => {
    const auth = await deps.auth()
    if (!auth || context && auth.userId !== context.actor.accountId) throw new Error('File reader account changed')
    return { ...configuredEndpoint(auth.accessToken), fetch: deps.fetch }
  }
  const later: ProjectFileVersionLookup = async ref => {
    const row = await attachmentRequest(await endpoint(), 'file-resolve', { ref, as: (await identity()).accountId }) as FileRevision & { status?: string }
    return row?.status === 'ready' ? row : null
  }
  const read = createProjectFileReader({ identity, root: deps.root, env: deps.env, later })
  const metadata = createFileMetadataLoader(async (context, refs) => attachmentRequest(await endpoint(context), 'file-resolve', { refs, as: context.actor.actorId }))
  const providers = { ...cloudFileProviders({ endpoint, metadata, cache: createFileChunkCache(deps.tempRoot), sink: size => createFileSink(deps.tempRoot, size) }),
    local: localProjectFileProvider({ identity, read, tempRoot: deps.tempRoot, env: deps.env, later }),
    ssh: async (...args: Parameters<ReturnType<typeof ownSshFileProvider>>) => {
      const links = deps.links(); return links ? ownSshFileProvider(links, deps.tempRoot)(...args) : null
    },
  }
  const resolve = createFileResolver(providers)
  const drain = createProjectTransferHost({ identity, endpoint, read: async request => read(request, (await identity()).accountId), tempRoot: deps.tempRoot, env: deps.env, later })
  const resolveAccount: Parameters<typeof setAccountFileResolver>[0] = async (ref, actor, options) => {
    const { accountId, deviceId } = await identity()
    if ('name' in ref) {
      const local = await findProjectFileByName(ref.chat, ref.name, accountId, deviceId, deps.env)
      if (!local) { if (options?.localOnly) return null; throw new Error('File must first be resolved to its item id') }
      ref = { item_id: local.item_id! }
    }
    const fileRef: FileRef = 'id' in ref ? { item_id: ref.id, ...(options?.version ? { version: options.version } : {}) } : ref
    const reader = { accountId, actorId: actor ?? accountId }
    return options?.localOnly ? resolve(fileRef, reader, { localOnly: true }) : resolve(fileRef, reader)
  }
  const sshHandlers: DeviceRpcHandlers = { [PROJECT_FILE_READ]: async (payload, ctx) => ({ result: await read(payload as Parameters<typeof read>[0], ctx.request.user_id) }) }
  const publish = createProjectFilePublisher({ identity, root: deps.root, rpc: deps.rpc, env: deps.env })
  return { providers, resolve, resolveAccount, read, drain, publish,
    handlers: (transport: 'ssh' | 'realtime'): DeviceRpcHandlers => transport === 'ssh' ? sshHandlers : {},
    async download(ref: FileRef, name: string, actorId: string) {
      const { accountId } = await identity(), file = await resolve(ref, { accountId, actorId })
      if (file.status !== 'ready') throw new Error('File is no longer available')
      const saved = await saveFileHandle(file, deps.downloads, name)
      return { localPath: saved.file_path, bytes: saved.content_type.startsWith('image/') ? new Uint8Array(await readFile(saved.file_path)) : new Uint8Array() }
    },
  }
}
