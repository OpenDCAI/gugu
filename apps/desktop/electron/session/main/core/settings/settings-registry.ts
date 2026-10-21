import { DEFAULT_SESSION_VIEW } from '@shared/core/sessions/new-session-defaults';
import { homedir } from 'node:os'
import { join } from 'node:path'
import { asAgentProviderId } from '@gugu/session-plugins/agents/types'
import { DEFAULT_BROWSER_PROFILE_ID, DEFAULT_BROWSER_PROFILES } from '@shared/browser'
import type { AppSettings, AppSettingsKey } from '@shared/core/app-settings'
import { DEFAULT_SESSION_AUTO_APPROVE } from '@shared/core/sessions/default-session-autonomy'
import { SESSION_TITLE_DEFAULT_MODEL } from '@shared/core/sessions/session-title-namer'
import { TERMINAL_FONT_SIZE_DEFAULT } from '@shared/core/terminals/terminal-settings'
import type { OpenInAppId } from '@shared/openInApps'

/**
 * ⚠️ 这**不是**「默认智能体」那个设置项的出厂值了(出厂值 = 不预选,见 schema.ts)。
 * 它只剩一个用处:自动化动作建任务时没有用户可问、又必须挑一个,见 automations/actions/sessionCreate.ts。
 */
export const DEFAULT_AGENT_ID = asAgentProviderId('claude')

type SettingsDefaultsMap = {
  [K in AppSettingsKey]: AppSettings[K] | (() => AppSettings[K])
}

export const SETTINGS_DEFAULTS = {
  project: {
    tmuxByDefault: false
  },
  localProject: () => ({
    defaultProjectsDirectory: join(homedir(), 'Documents'),
    writeAgentConfigToGitIgnore: true
  }),
  sessions: {
    autoGenerateName: true,
    autoApproveByDefault: DEFAULT_SESSION_AUTO_APPROVE,
    autoTrustWorktrees: true,
    preserveNameCapitalization: false,
    includeIssueContextByDefault: true,
    titleModel: SESSION_TITLE_DEFAULT_MODEL,
    titleInstructions: ''
  },
  notifications: {
    enabled: true,
    sound: true,
    customSoundPath: '',
    osNotifications: true,
    soundFocusMode: 'always' as const
  },
  terminal: {
    fontSize: TERMINAL_FONT_SIZE_DEFAULT,
    autoCopyOnSelection: false,
    macOptionIsMeta: false,
    defaultShell: 'system' as const
  },
  theme: null,
  // 出厂不预选 agent —— 理由见 schema.ts 的 `defaultAgentSchema`。
  defaultAgent: null,
  // 新建会话框的记忆:出厂什么都没记(schema.ts 的 `newSessionMemorySchema`)。
  newSessionMemory: { lastPicked: null, lastStarted: null, sessionView: DEFAULT_SESSION_VIEW },
  keyboard: {},
  openIn: {
    // @@@factory-default-open-in — 出厂默认打开方式 = 系统文件管理器(owner 2026-09-05 拍,#5038)。
    // finder 是同一项、标签与图标随平台走(访达 / 资源管理器 / 文件),三端都 alwaysAvailable,
    // 不必探测安装 —— 这才是它适合做默认的理由。
    default: 'finder' as const,
    hidden: [] as OpenInAppId[]
  },
  interface: {
    autoRightSidebarBehavior: false,
    showLeftSidebarStateGroups: false,
    showLeftSidebarAgentNameOnHover: true,
    hideContextBar: false,
    chatView: 'double' as const,
    confirmBeforeArchive: true,
    confirmBeforeCancelAndSend: true
  },
  browserPreview: {
    enabled: true
  },
  browser: {
    defaultProfileId: DEFAULT_BROWSER_PROFILE_ID,
    relaxCorsForLocalhost: false,
    profiles: DEFAULT_BROWSER_PROFILES
  },
  resourceMonitor: {
    enabled: false
  },
  changesViewMode: {
    unstaged: 'flat' as const,
    staged: 'flat' as const,
    pr: 'flat' as const
  }
} satisfies SettingsDefaultsMap

export function getDefaultForKey<K extends AppSettingsKey>(key: K): AppSettings[K] {
  const d = SETTINGS_DEFAULTS[key]
  return (typeof d === 'function' ? (d as () => AppSettings[K])() : d) as AppSettings[K]
}
