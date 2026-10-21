import type { AgentSettingsPaneProps } from './types'
import { useTranslation } from 'react-i18next'
import { asClass, memoryFileClass } from './agentSettingsStyles'

// File icon SVG (same icon used for all .md files)
const FileIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24">
    <g fill="none">
      <path
        fill="currentColor"
        d="m15.393 4.054l-.502.557zm3.959 3.563l-.502.557zm2.302 2.537l-.685.305zM3.172 20.828l.53-.53zm17.656 0l-.53-.53zM14 21.25h-4v1.5h4zM2.75 14v-4h-1.5v4zm18.5-.437V14h1.5v-.437zM14.891 4.61l3.959 3.563l1.003-1.115l-3.958-3.563zm7.859 8.952c0-1.689.015-2.758-.41-3.714l-1.371.61c.266.598.281 1.283.281 3.104zm-3.9-5.389c1.353 1.218 1.853 1.688 2.119 2.285l1.37-.61c-.426-.957-1.23-1.66-2.486-2.79zM10.03 2.75c1.582 0 2.179.012 2.71.216l.538-1.4c-.852-.328-1.78-.316-3.248-.316zm5.865.746c-1.086-.977-1.765-1.604-2.617-1.93l-.537 1.4c.532.204.98.592 2.15 1.645zM10 21.25c-1.907 0-3.261-.002-4.29-.14c-1.005-.135-1.585-.389-2.008-.812l-1.06 1.06c.748.75 1.697 1.081 2.869 1.239c1.15.155 2.625.153 4.489.153zM1.25 14c0 1.864-.002 3.338.153 4.489c.158 1.172.49 2.121 1.238 2.87l1.06-1.06c-.422-.424-.676-1.004-.811-2.01c-.138-1.027-.14-2.382-.14-4.289zM14 22.75c1.864 0 3.338.002 4.489-.153c1.172-.158 2.121-.49 2.87-1.238l-1.06-1.06c-.424.422-1.004.676-2.01.811c-1.027.138-2.382.14-4.289.14zM21.25 14c0 1.907-.002 3.262-.14 4.29c-.135 1.005-.389 1.585-.812 2.008l1.06 1.06c.75-.748 1.081-1.697 1.239-2.869c.155-1.15.153-2.625.153-4.489zm-18.5-4c0-1.907.002-3.261.14-4.29c.135-1.005.389-1.585.812-2.008l-1.06-1.06c-.75.748-1.081 1.697-1.239 2.869C1.248 6.661 1.25 8.136 1.25 10zm7.28-8.75c-1.875 0-3.356-.002-4.511.153c-1.177.158-2.129.49-2.878 1.238l1.06 1.06c.424-.422 1.005-.676 2.017-.811c1.033-.138 2.395-.14 4.312-.14z"
      />
      <path stroke="currentColor" strokeWidth="1.5" d="M13 2.5V5c0 2.357 0 3.536.732 4.268S15.643 10 18 10h4" />
    </g>
  </svg>
)

// Folder icon SVG (used for .claude, memory, conversations, skills folders)
const FolderIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24">
    <g fill="none" stroke="currentColor" strokeWidth="1.5">
      <path strokeLinecap="round" d="M18 10h-5" />
      <path d="M2 6.95c0-.883 0-1.324.07-1.692A4 4 0 0 1 5.257 2.07C5.626 2 6.068 2 6.95 2c.386 0 .58 0 .766.017a4 4 0 0 1 2.18.904c.144.119.28.255.554.529L11 4c.816.816 1.224 1.224 1.712 1.495a4 4 0 0 0 .848.352C14.098 6 14.675 6 15.828 6h.374c2.632 0 3.949 0 4.804.77q.119.105.224.224c.77.855.77 2.172.77 4.804V14c0 3.771 0 5.657-1.172 6.828S17.771 22 14 22h-4c-3.771 0-5.657 0-6.828-1.172S2 17.771 2 14z" />
    </g>
  </svg>
)

// Tree entries per design
// Files (AGENTS.md, CLAUDE.md, IDENTITY.md, MEMORY.md, SOUL.md) use FileIcon
// Folders (.claude, memory, conversations, skills) use FolderIcon
const TREE_ENTRIES: Array<{ name: string; type: 'file' | 'folder' }> = [
  { name: 'AGENTS.md',      type: 'file' },
  { name: 'CLAUDE.md',      type: 'file' },
  { name: 'IDENTITY.md',    type: 'file' },
  { name: 'MEMORY.md',      type: 'file' },
  { name: 'SOUL.md',        type: 'file' },
  { name: '.claude',        type: 'folder' },
  { name: 'memory',         type: 'folder' },
  { name: 'conversations',  type: 'folder' },
  { name: 'skills',         type: 'folder' },
]

export function AgentMemoryPane({ agent: _agent }: AgentSettingsPaneProps) {
  const { t } = useTranslation('agents')
  // #1228: 记忆文件读写后端未建（无 listDirectory/readFile/writeFile RPC）。原实现点击文件项
  // 只切 selectedFile 但右栏永远是占位文案 = 「点了没用」(反 fake)。→ 文件树展示标准 agent 工作目录
  // 结构（informational，非可交互），点击移除；右栏诚实「即将开放」。后端落地后接真读写。
  return (
    /* design line 1024: <div class="agset-pane" data-pane="memory"> */
    <div>
      {/* design line 1025: <div class="aset-label" style="margin-bottom:9px">工作目录</div> */}
      <div className={asClass.memoryLabel} style={{ marginBottom: '9px' }}>
        {t('settings.memory.directory')}
      </div>

      {/* design line 1026: <div class="wd"> */}
      <div className={asClass.memoryWd}>
        {/* design line 1027: <div class="wd-tree"> — 标准结构展示，非可交互（读写即将开放） */}
        <div className={asClass.memoryTree}>
          {TREE_ENTRIES.map((entry) => (
            /* design line 1028–1036: <div class="wd-f"> per entry — 静态展示，无 onClick */
            <div
              key={entry.name}
              className={memoryFileClass(false)}
              style={{ cursor: 'default' }}
            >
              {entry.type === 'file' ? <FileIcon /> : <FolderIcon />}
              {entry.name}
            </div>
          ))}
        </div>

        {/* design line 1038: <div class="wd-view"> — #1228 诚实占位（文件读写即将开放） */}
        <div className={asClass.memoryView}>
          {t('settings.memory.comingSoon')}
        </div>
      </div>
    </div>
  )
}
