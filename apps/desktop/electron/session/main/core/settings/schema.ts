import { DEFAULT_SESSION_VIEW } from '@shared/core/sessions/new-session-defaults';
import type { AgentProviderId } from '@gugu/session-plugins/agents';
import z from 'zod';
import { BROWSER_ISOLATED_PROFILE_ID } from '@shared/browser';
import {
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  TERMINAL_SHELL_IDS,
} from '@shared/core/terminals/terminal-settings';
import { openInAppIdSchema } from '@shared/openInApps';
import { SESSION_TITLE_INSTRUCTIONS_MAX } from '@shared/core/sessions/session-title-namer';
import { COMMANDS } from '@shared/commands';
import { isValidProviderId } from '../agents/plugin-registry';
import { isGuguPermissionMode, type GuguPermissionMode } from '@gugu/session-core/acp/client';

export const projectSettingsSchema = z.object({
  tmuxByDefault: z.boolean(),
});

export const localProjectSettingsSchema = z.object({
  defaultProjectsDirectory: z.string(),
  writeAgentConfigToGitIgnore: z.boolean(),
});

export const notificationSettingsSchema = z.object({
  enabled: z.boolean(),
  sound: z.boolean(),
  customSoundPath: z.string(),
  osNotifications: z.boolean(),
  soundFocusMode: z.enum(['always', 'unfocused']),
});

export const sessionSettingsSchema = z.object({
  autoGenerateName: z.boolean(),
  autoApproveByDefault: z.boolean(),
  autoTrustWorktrees: z.boolean(),
  preserveNameCapitalization: z.boolean(),
  includeIssueContextByDefault: z.boolean(),
  /**
   * #7337 咕咕给会话起名用的平台模型(按积分计费,记在这条会话的 agent 名下);null = 不用模型起名,
   * 标题留在 harness 起的名或首轮兜底上。出厂值见 `SESSION_TITLE_DEFAULT_MODEL`。
   */
  titleModel: z.string().min(1).nullable(),
  /** 起名时追加给模型的风格要求(「用英文」「前面带项目名」);改不了输出格式与「首轮当数据」那两条硬规则。 */
  titleInstructions: z.string().max(SESSION_TITLE_INSTRUCTIONS_MAX),
});

export const terminalSettingsSchema = z.object({
  /**
   * 设置 → 通用里的「终端」开关:终端的入口与界面给不给人看,新会话走编程(开)还是通用(关)。
   * `null` = 还没定 —— 启动时按老用户迁移规则算一次写回(terminal-visibility.ts),之后只由人来改。
   * ❌ 不管 agent 自己能不能跑 pty 会话。
   */
  enabled: z.boolean().nullable(),
  fontFamily: z.string().optional(),
  fontSize: z.number().min(TERMINAL_FONT_SIZE_MIN).max(TERMINAL_FONT_SIZE_MAX).optional(),
  autoCopyOnSelection: z.boolean(),
  macOptionIsMeta: z.boolean(),
  defaultShell: z.enum(TERMINAL_SHELL_IDS),
});

export const themeSchema = z
  .enum(['emlight', 'emdark'])
  .nullable()
  .catch(null)
  .optional()
  .default(null);

/**
 * 出厂**不预选任何 agent**。
 *
 * ⚠️ 2026-09-17 之前这里是 `.default(DEFAULT_AGENT_ID)`(= `claude`),与本机装没装无关 ——
 * 于是全新装的用户一打开「新建任务」就顶着一个自己没装过的 Claude Code,设置页的「默认智能体」
 * 那一格也照样显示它。默认值指向一个不存在的东西,产品就得在下游为这个谎话做补救(从前是一行
 * 红字)。owner 2026-09-17 真机实遇后拍板:「如果用户刚下载下来,什么 agent 都没装过,那自然就是
 * 一个 agent 都没选」。选中哪一个由 `provider-selection.ts` 按「本机真的有什么」现算。
 */
export const defaultAgentSchema = z
  .custom<AgentProviderId>(isValidProviderId)
  .nullable()
  .optional()
  .default(null);

/**
 * What the new-session box remembers on this device — one copy, read by the box and by main (an App's spawnAgent),
 * both feeding `rememberedProviderOf` → `resolveSessionProviderSelection` (L11 复核 58: in the window's
 * localStorage main could not see it, and its spawnAgent remembered another engine than the box did).
 * - `lastPicked`: the engine the person picked by hand — kept at the pick, before any session starts;
 * - `lastStarted`: what was last started — its model / platform model / effort / permission mode, and whether its
 *   engine was the person's or the factory guess (a guess must not outrank settings' default agent);
 * - `sessionView`: the shape a new session opens in (code / general).
 */
export const newSessionMemorySchema = z
  .object({
    lastPicked: z.custom<AgentProviderId>(isValidProviderId).nullable().default(null),
    lastStarted: z
      .object({
        provider: z.custom<AgentProviderId>(isValidProviderId),
        model: z.string().optional(),
        effort: z.string().optional(),
        platformModel: z.string().optional(),
        permissionMode: z.custom<GuguPermissionMode>(isGuguPermissionMode).optional(),
        providerChosenByUser: z.boolean(),
      })
      .nullable()
      .default(null),
    sessionView: z.enum(['code', 'general']).default(DEFAULT_SESSION_VIEW),
  })
  .default({ lastPicked: null, lastStarted: null, sessionView: DEFAULT_SESSION_VIEW });

export const keyboardSettingsSchema = z
  .optional(
    z.object(
      Object.fromEntries(
        Object.keys(COMMANDS).map((k) => [k, z.string().nullable().optional()])
      ) as Record<keyof typeof COMMANDS, z.ZodOptional<z.ZodNullable<z.ZodString>>>
    )
  )
  .default({});

/**
 * Per-provider execution settings stored as host-agnostic overrides.
 * Installation source/path/cli overrides are now stored host-specifically
 * in the HostDependencyStore (KV for local, SSH connection metadata for remote).
 */
export const providerCustomConfigEntrySchema = z.object({
  extraArgs: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
});

export const providerConfigDefaults: Record<string, unknown> = {};

export const interfaceSettingsSchema = z.object({
  autoRightSidebarBehavior: z.boolean(),
  /**
   * 这里曾经还有三格:`showLeftSidebarLineChanges` / `showLeftSidebarPrStatus` /
   * `showLeftSidebarTimestamps`。它们是旧版左侧栏那套元数据的开关,咕咕把会话行重画之后
   * 三样元数据要么没了、要么成了常驻 —— 开关**一处消费者都没有**,拨了没反应(#5829,owner:
   * 「如果没人读,那你把这三个给关了吧」)。2026-09-18 连同设置页那三行一起删掉。
   * 第四格 `taskHoverAction`(悬停删除还是归档)同样没有消费者,2026-10-05 随 PR-2 删掉。
   *
   * 存量用户库里可能还留着这几个键:读的时候只是 mergeDeep 里一格没人问的多余字段,
   * 下一次写这组设置时被 zod 剥掉(`z.object` 默认丢弃未知键),所以不需要迁移。
   * ❌ 别因为「怕存量脏数据」把空开关留在界面上 —— 拨了没反应比没有这个开关更糟。
   */
  /**
   * 侧栏用不用二级分类 —— 即 agent 状态分组(需要你 / 工作中 / 已完成)那一层。
   * 开 = 会话按状态分组、各带组头与数量;关(默认)= 没有这一层,会话按最后交互时间平铺成一条列表。
   * 关掉不会让「需要你」失去存在感:它退回行级信号(行尾琥珀点、项目收起时项目行的琥珀点)。
   *
   * 默认关(owner 2026-09-06)。首版发的是默认开(owner 2026-09-05),owner 实际用下来改了主意。
   * 默认值只作用于**没动过这个开关的人**:显式打开过的存量用户,选择存在本地,不被这次改动覆盖。
   */
  showLeftSidebarStateGroups: z.boolean(),
  /**
   * 指针压到会话行上时,这一行的内容要不要就地变成它的 agent 名字(`Claude 3`)。
   * 开(默认)= 划过一圈就知道每一行是谁;关 = 行上永远只写会话标题,悬浮什么都不换。
   *
   * 为什么给开关:它换掉的是用户正在读的那一行的**内容**,不是多画一个角标 ——
   * 有人要的就是「我扫的是标题,别在我眼皮底下变」(owner 2026-09-18:「变成任务设置中的一个可关的功能选项」)。
   * ❌ 关掉不等于退回 tooltip:关了就是不显示,产品里不存在第二种显示形态。
   */
  showLeftSidebarAgentNameOnHover: z.boolean(),
  hideContextBar: z.boolean(),
  /**
   * 会话页对话视图（#4874）：`single` = 每一行都占满整宽；`double` = 用户消息收到右侧的
   * 无边框胶囊、assistant 回复无气泡（assistant-ui「Base」骨架）。
   *
   * 默认 `double`（owner 2026-09-04：「初始默认改为双栏」）。首版发的是 `single`，理由是
   * 「老用户体验不变」；owner 实测两档后改了主意 —— 双栏才是他要的那一版。默认值只作用于
   * **没动过这个设置的人**：存量用户的选择存在本地，不会被这次改动覆盖。
   */
  chatView: z.enum(['single', 'double']),

  /**
   * 归档前弹不弹确认框。开(默认)= 每次归档都先问;关 = 直接归档。
   *
   * 关掉这一项的正规入口是确认框自己的「不再询问」——用户在真要归档的那一刻决定往后还谈不谈,
   * 而不是先去设置里翻一遍(owner 2026-09-05)。设置页留着这一行是为了**反悔**:勾过之后
   * 没有别的地方能把它调回来。
   *
   * 只管归档。删除会话不受它影响:删除不可撤销,确认不是偏好。
   */
  confirmBeforeArchive: z.boolean(),

  /**
   * 回合还在跑时点排队提示的「立即发送」,弹不弹「取消回合并发送」确认框。开(默认)= 先问;
   * 关 = 直接取消当前回合并发送。与 `confirmBeforeArchive` 同一个形状:确认框自带「不再询问」,
   * 设置页这一行是反悔的地方(owner 2026-09-23)。
   */
  confirmBeforeCancelAndSend: z.boolean(),
});

export const changesViewModeSchema = z.object({
  unstaged: z.enum(['flat', 'tree']),
  staged: z.enum(['flat', 'tree']),
  pr: z.enum(['flat', 'tree']),
});

export const browserPreviewSettingsSchema = z.object({ enabled: z.boolean() });

export const browserProfileIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
  .refine((value) => value !== BROWSER_ISOLATED_PROFILE_ID);

export const browserSettingsSchema = z
  .object({
    defaultProfileId: z.union([browserProfileIdSchema, z.literal(BROWSER_ISOLATED_PROFILE_ID)]),
    relaxCorsForLocalhost: z.boolean(),
    profiles: z
      .array(
        z.object({
          id: browserProfileIdSchema,
          name: z.string().trim().min(1).max(40),
        })
      )
      .min(1),
  })
  .refine(
    (settings) =>
      new Set(settings.profiles.map((profile) => profile.id)).size === settings.profiles.length
  )
  .refine(
    (settings) =>
      settings.defaultProfileId === BROWSER_ISOLATED_PROFILE_ID ||
      settings.profiles.some((profile) => profile.id === settings.defaultProfileId)
  );

export const resourceMonitorSettingsSchema = z.object({ enabled: z.boolean() });
export const globalSearchSettingsSchema = z.object({ v3: z.boolean() });

export const openInSettingsSchema = z.object({
  default: openInAppIdSchema,
  hidden: z.array(openInAppIdSchema),
});

export const APP_SETTINGS_SCHEMA_MAP = {
  localProject: localProjectSettingsSchema,
  project: projectSettingsSchema,
  sessions: sessionSettingsSchema,
  defaultAgent: defaultAgentSchema,
  newSessionMemory: newSessionMemorySchema,
  keyboard: keyboardSettingsSchema,
  notifications: notificationSettingsSchema,
  theme: themeSchema,
  openIn: openInSettingsSchema,
  interface: interfaceSettingsSchema,
  terminal: terminalSettingsSchema,
  browserPreview: browserPreviewSettingsSchema,
  browser: browserSettingsSchema,
  resourceMonitor: resourceMonitorSettingsSchema,
  globalSearch: globalSearchSettingsSchema,
  changesViewMode: changesViewModeSchema,
} as const;

export const appSettingsSchema = z.object({
  localProject: localProjectSettingsSchema,
  project: projectSettingsSchema,
  sessions: sessionSettingsSchema,
  defaultAgent: defaultAgentSchema,
  newSessionMemory: newSessionMemorySchema,
  keyboard: keyboardSettingsSchema,
  notifications: notificationSettingsSchema,
  theme: themeSchema,
  openIn: openInSettingsSchema,
  interface: interfaceSettingsSchema,
  terminal: terminalSettingsSchema,
  browserPreview: browserPreviewSettingsSchema,
  browser: browserSettingsSchema,
  resourceMonitor: resourceMonitorSettingsSchema,
  globalSearch: globalSearchSettingsSchema,
  changesViewMode: changesViewModeSchema,
});
