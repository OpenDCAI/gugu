import type { RuntimeAuth } from '@gugu/core'
import type { DeviceRpcHandlers } from '@gugu/core/cloud/deviceRpcResponder'
import { mkdir, readFile } from 'node:fs/promises'
import { readCachedDeviceId } from '@gugu/core/cloud/deviceRuntime'
import { attachmentRequest, configuredEndpoint } from '@gugu/core/cloud/attachmentsApi'
import { createFileMetadataLoader } from '@gugu/core/cloud/fileMetadata'
import { cloudFileProviders } from '@gugu/core/cloud/fileProviders'
import { createFileChunkCache, createFileSink, createFileSaver, saveFileHandle } from '@gugu/core/local/files/fileSnapshots'
import { attachmentStage } from '@gugu/core/local/files/attachmentDiagnostics'
import { DEVICE_STORE, createFileResolver, type FileContext, type FileRef, type FileRevision } from '@gugu/core/shared/fileResolver'
import { parseFileStorage } from '@gugu/core/shared/fileStorage'
import { readUserSettingsConfig, type SettingsTableClient } from '@gugu/core/cloud/userSettings'
import { PROJECT_FILE_READ, createProjectFileReader, localProjectFileProvider } from './projectFileHost'
import { ownSshFileProvider, type HeldFileSshLinks } from './projectFileSsh'
import { createProjectTransferHost } from './projectFileTransferHost'
import { findProjectFileByName, type ProjectFileVersionLookup } from './sessionpage/sessionpage-project-groups'
import type { setAccountFileResolver } from './session/main/core/extensions/account-token'
import { createProjectFilePublisher } from './projectFilePublication'
import type { makeIdentityClient } from './supabase'

/** One composition root for native IPC, Apps, MCP and inbox. Identity lookup here never registers or refreshes. */
export function createDesktopFileAccess(deps: {
  auth(): Promise<RuntimeAuth | null>; root(projectId: string): Promise<string | null>
  links(): HeldFileSshLinks | null; tempRoot: string; downloads: string; fetch: typeof fetch; env?: NodeJS.ProcessEnv
  rpc(name: string, args: Record<string, unknown>): Promise<unknown>
  /** Where this device keeps what it sends into project chats it binds no project to (DEVICE_STORE). */
  deviceStore: string
  /** The identity schema, as the signed-in account: its own settings and device projects. */
  identityDb(accessToken: string): ReturnType<typeof makeIdentityClient>
}) {
  // The device store is served and written like a project root.
  const root = async (projectId: string) => {
    if (projectId !== DEVICE_STORE) return deps.root(projectId)
    await mkdir(deps.deviceStore, { recursive: true, mode: 0o700 })
    return deps.deviceStore
  }
  const identityDb = async () => {
    const auth = await deps.auth(); if (!auth) throw new Error('File publisher is not signed in')
    return { auth, db: deps.identityDb(auth.accessToken) }
  }
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
  const read = createProjectFileReader({ identity, root, env: deps.env, later })
  const metadata = createFileMetadataLoader(async (context, refs) => attachmentRequest(await endpoint(context), 'file-resolve', { refs, as: context.actor.actorId }))
  const providers = { ...cloudFileProviders({ endpoint, metadata, cache: createFileChunkCache(deps.tempRoot), sink: size => createFileSink(deps.tempRoot, size) }),
    local: localProjectFileProvider({ identity, read, tempRoot: deps.tempRoot, env: deps.env, later }),
    ssh: async (...args: Parameters<ReturnType<typeof ownSshFileProvider>>) => {
      const links = deps.links(); return links ? ownSshFileProvider(links, deps.tempRoot)(...args) : null
    },
  }
  const resolve = createFileResolver({ ...providers, saveTo: createFileSaver(providers) })
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
  const publish = createProjectFilePublisher({ identity, root, rpc: deps.rpc, env: deps.env,
    async storage() { const { auth, db } = await identityDb(); return parseFileStorage(await readUserSettingsConfig(db as unknown as SettingsTableClient, auth.userId, 'user')) },
    async projectChat(chatId) {
      const { db } = await identityDb()
      const { count, error } = await db.from('device_projects').select('device_id', { count: 'exact', head: true }).eq('chat_id', chatId)
      if (error) throw new Error(error.message)
      return (count ?? 0) > 0
    },
  })
  return { providers, resolve, resolveAccount, read, drain, publish,
    handlers: (transport: 'ssh' | 'realtime'): DeviceRpcHandlers => transport === 'ssh' ? sshHandlers : {},
    async download(ref: FileRef, name: string, actorId: string) {
      const step = <T>(stage: string, action: () => Promise<T>) => attachmentStage({ actorId, ref }, stage, action)
      const { accountId } = await step('identity', identity)
      const file = await step('resolve', async () => {
        const resolved = await resolve(ref, { accountId, actorId })
        if (resolved.status !== 'ready') throw new Error('File is no longer available')
        return resolved
      })
      const saved = await step('save', () => saveFileHandle(file, deps.downloads, name))
      const bytes = saved.content_type.startsWith('image/')
        ? await step('read-image', async () => new Uint8Array(await readFile(saved.file_path))) : new Uint8Array()
      return { localPath: saved.file_path, bytes }
    },
  }
}
