// #7199 个人助理住在这台电脑上时,它的家(工作目录、说明、禁用的工具、开通时主人留的那条记忆)由主进程在本机准备
// (electron/assistant-home.ts)。渲染层 ↔ 主进程的契约,只此一份。

export const ASSISTANT_HOME_CHANNELS = {
  preparationStart: 'assistant-home:preparation-start',
  preparationStatus: 'assistant-home:preparation-status',
  preparationCancel: 'assistant-home:preparation-cancel',
  preparationCommit: 'assistant-home:preparation-commit',
  preparationRelease: 'assistant-home:preparation-release',
  preparationChanged: 'assistant-home:preparation-changed',
  /**
   * 准备 / 刷新它在这台电脑上的家(invoke,PrepareLocalHomeInput → PrepareLocalHomeResult):建工作目录、写宿主维护的那段说明;带 ownerProfile 时把「关于主人」写进它的记忆夹。幂等:开通前调一次,之后每次打开 App 再调一次让说明跟上版本。
   */
  prepare: 'assistant-home:prepare',
  /**
   * 清掉它在这台电脑上的家(invoke,无参 → WipeLocalHomeResult;#7350 关闭咕咕):工作目录整个删掉(说明、性格、记忆、交给它的文件、设置),
   * Claude Code 认的那一夹记忆只在它是链到这个家的链接时拆掉。路径由主进程算,❌ 渲染层传路径。
   */
  wipe: 'assistant-home:wipe',
} as const

export type LocalAssistantPreparationState =
  | { phase: 'preparing' | 'ready' | 'committing' | 'committed' | 'cancelled' }
  | { phase: 'failed'; error: string; installationStarted?: true }

export type PrepareLocalHomeInput = {
  /** 只问家在哪个目录,什么都不建不写(搬家预览 / 读旧家用)。 */
  dryRun?: boolean
  /** 引导里主人写的「称呼和基本信息」(markdown 正文);不带 = 不动记忆。 */
  ownerProfile?: string | null
  /**
   * 新开通的一位(#7350):先清掉上一位留下的家再准备 —— 在别的设备上删掉的、关到一半的,家都还在这台电脑上,
   * ❌ 新的一位带着上一位的记忆和性格。只有开通新的一位带它;每次打开 App 的刷新、搬家都 ❌ 带。
   */
  fresh?: boolean
}

export type WipeLocalHomeResult = {
  /** 清掉的那个工作目录。 */
  workdir: string
  /** 清之前它在不在(不在 = 本来就没有家,照常算清完)。 */
  existed: boolean
}

export type PrepareLocalHomeResult = {
  /** 它的工作目录(agent.create 的 project_path;记忆夹按它起名)。 */
  workdir: string
  /** 这台电脑的主目录(~/.claude 在它下面)。 */
  home: string
}
