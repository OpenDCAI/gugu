// #7199 个人助理住在这台电脑上时,它的家由主进程在本机准备(assistant-home-prepare.ts);这里只是把它挂到 IPC 上。
import { ipcMain } from 'electron'
import { ASSISTANT_HOME_CHANNELS, type PrepareLocalHomeInput } from '../src/lib/assistantHomeIpc'
import { prepareLocalAssistantHome, wipeLocalAssistantHome } from './assistant-home-prepare'

export function installAssistantHome(): void {
  ipcMain.handle(ASSISTANT_HOME_CHANNELS.prepare, (_event, input: PrepareLocalHomeInput | undefined) => prepareLocalAssistantHome(input ?? {}))
  ipcMain.handle(ASSISTANT_HOME_CHANNELS.wipe, () => wipeLocalAssistantHome())
}
