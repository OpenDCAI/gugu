// #7199 个人助理住在这台电脑上时,它的家由主进程在本机准备(assistant-home-prepare.ts);这里只是把它挂到 IPC 上。
import { ipcMain } from 'electron'
import { join } from 'node:path'
import { resolveGuguHome } from '@gugu/core/local/state/paths'
import { createMoveJournalFileStore } from './assistant-move-journal'
import { stdSerializers } from 'pino'
import { ASSISTANT_HOME_CHANNELS, type AssistantEngine, type PrepareLocalHomeInput } from '../src/lib/assistantHomeIpc'
import { prepareLocalAssistantHome, wipeLocalAssistantHome } from './assistant-home-prepare'
import { createAssistantSetupPreparation } from './assistant-setup-preparation'
import { createLogger } from './lib/logger'

export function installAssistantHome(): void {
  // Resolve lazily: GUGU_HOME is established after static imports.
  const journal = () => createMoveJournalFileStore(join(resolveGuguHome(process.env), 'assistant-moves'))
  ipcMain.handle(ASSISTANT_HOME_CHANNELS.moveJournalRead, (_event, owner: string) => journal().read(owner))
  ipcMain.handle(ASSISTANT_HOME_CHANNELS.moveJournalWrite, (_event, owner: string, value: string) => journal().write(owner, value))
  ipcMain.handle(ASSISTANT_HOME_CHANNELS.moveJournalClear, (_event, owner: string) => journal().clear(owner))
  const owners = new Map<string, Electron.WebContents>()
  const watched = new WeakSet<Electron.WebContents>()
  const log = createLogger('assistant-setup-preparation')
  // ❌ 顶层 import assistant-runtime-prepare:它带进会话页主进程图(dependency-managers 等),那些模块顶层就按
  // GUGU_HOME 算路径,而 main.ts 静态加载本文件时 GUGU_HOME 还没定(@@@4865)⇒ 隔离实例与非 production tier 上
  // 装完的 agent「找不到程序」。
  const runtime = () => import('./assistant-runtime-prepare')
  const preparation = createAssistantSetupPreparation({
    prepare: async (id, signal, engine) => (await runtime()).prepareAssistantRuntime(id, signal, engine),
    cleanup: async (id) => (await runtime()).discardAssistantPreparation(id),
    install: prepareLocalAssistantHome,
    failed: (attemptId, stage, err) => log.warn({ attemptId, stage, error: err instanceof Error ? stdSerializers.errWithCause(err) : err }, 'Local assistant setup failed'),
    changed: (id, state) => { const owner = owners.get(id); if (owner && !owner.isDestroyed()) owner.send(ASSISTANT_HOME_CHANNELS.preparationChanged, { id, ...state }) } })
  const owned = (event: Electron.IpcMainInvokeEvent, id: string) => {
    if (owners.get(id) !== event.sender) throw new Error('This assistant preparation belongs to another window')
  }
  ipcMain.handle(ASSISTANT_HOME_CHANNELS.preparationStart, (event, engine: AssistantEngine = 'claude') => {
    if (engine !== 'claude' && engine !== 'codex') throw new Error('Unsupported assistant engine')
    const id = crypto.randomUUID()
    owners.set(id, event.sender)
    if (!watched.has(event.sender)) {
      watched.add(event.sender)
      event.sender.once('destroyed', () => {
        for (const [attemptId, owner] of owners) if (owner === event.sender) {
          void preparation.release(attemptId).then(() => owners.delete(attemptId), error => {
            log.error({ attemptId, error }, 'assistant preparation cleanup after window close failed')
          })
        }
      })
    }
    return { id, ...preparation.start(id, engine) }
  })
  ipcMain.handle(ASSISTANT_HOME_CHANNELS.preparationStatus, (event, id: string) => { owned(event, id); return preparation.status(id) })
  ipcMain.handle(ASSISTANT_HOME_CHANNELS.preparationCancel, async (event, id: string) => { owned(event, id); return preparation.cancel(id) })
  ipcMain.handle(ASSISTANT_HOME_CHANNELS.preparationCommit, (event, id: string, input: PrepareLocalHomeInput) => {
    owned(event, id)
    return preparation.commit(id, input)
  })
  ipcMain.handle(ASSISTANT_HOME_CHANNELS.preparationRelease, async (event, id: string) => {
    owned(event, id)
    await preparation.release(id)
    owners.delete(id)
  })
  ipcMain.handle(ASSISTANT_HOME_CHANNELS.prepare, (_event, input: PrepareLocalHomeInput | undefined) => prepareLocalAssistantHome(input ?? {}))
  ipcMain.handle(ASSISTANT_HOME_CHANNELS.wipe, () => wipeLocalAssistantHome())
}
