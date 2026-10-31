import { DEFAULT_FREE_PLATFORM_MODEL, DEFAULT_PLATFORM_MODEL_BY_PROVIDER } from '@shared/core/sessions/new-session-defaults';
import {
  autoApproveFromPermissionMode,
  isGuguPermissionMode,
  permissionModeFromAutoApprove,
  resolveDeclaredPermissionMode,
  strictestDeclaredPermissionMode,
  type GuguPermissionMode,
} from '@gugu/session-core/acp/client';
import { providerTakesMessageStartupInPty, type ResolvedModelEfforts } from '@gugu/session-core/agents/plugins';
import type { AgentProviderId } from '@gugu/session-plugins/agents';
import { nativeComposerAppearance } from '@renderer/lib/chat/native-chat-appearance.css';
import {
  AttachmentViewerDialog,
  ChatComposer,
  readAttachmentPreviewText,
} from '@gugu/session-ui/react/components';
import type {
  CommandItem,
  ComposerAgentOption,
  ComposerAttachment,
  ComposerEffortOption,
  ContextMentionProvider,
  MentionItem,
  PromptEditorRef,
} from '@gugu/session-ui/react/components';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import {
  attachmentChannelOf,
  firstTurnTransportOf,
  type SessionCreationSurface,
} from '@renderer/features/sessions/create-session-modal/first-turn-transport';
import { useEffectiveProvider } from '@renderer/features/sessions/use-effective-provider';
import { openComposerImage } from '@/lib/imageViewer';
import { rememberedProviderOf, sessionpageLegFor } from '@shared/core/sessions/provider-selection';
import type { NewSessionMemory } from '@shared/core/app-settings';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { IntegrationIcon } from '@renderer/features/integrations/integration-icon';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { resolveLegLoginGate } from './vendor-login-prompt';
import { usePromptLibrary } from '@renderer/features/library/prompts/use-prompt-library';
import { AgentIcon } from '@renderer/lib/components/agent-icon';
import {
  agentGroupLabel,
  agentRowAction,
  isAgentSelectable,
  sortAgentsByAvailability,
} from '@renderer/lib/components/agent-availability-groups';
import { useInstallingAgents } from '@renderer/lib/stores/use-agent-installation-statuses';
import {
  sessionViewOfLeg,
  sessionpageLegOfView,
  type SessionView,
} from '@shared/core/sessions/sessions';
import { UNATTENDED_SESSION_PERMISSION_MODE } from '@shared/core/sessions/unattended-session-autonomy';
import type { SessionViewLockState } from './session-view-lock';
import { SessionViewControl } from './session-view-control';
import { useTerminalEnabled } from '@renderer/features/settings/use-terminal-enabled';
import { DEFAULT_SESSION_VIEW } from '@shared/core/sessions/new-session-defaults';
import { toast } from '@renderer/lib/hooks/use-toast';
import { safeFailureLine } from '@renderer/features/sessions/gugu-reason';
import { stringifyMention } from '@gugu/session-shared/markdown';
import { log } from '@renderer/utils/logger';
import { composerAttachmentSource } from '@renderer/features/sessions/acp/composer-attachment-source';
import { isHeicLikeFile, mustCopyRatherThanReference } from '@renderer/lib/pty/terminal-image-paths';
import { electronApi } from '@renderer/lib/electron-api';
import { rpcOn } from '@renderer/lib/ipc';
import {
  harnessCatalogNotice,
  harnessCatalogToModelsCapability,
  harnessCatalogToOptions,
} from './harness-model-field';
import { useHarnessModelOptions } from './use-harness-model-options';
import { platformEffortFacts, resolveCreateEfforts } from '@shared/core/agents/create-efforts';
import { HARNESS_MODEL_CATALOG_QUERY_KEY, useHarnessModelCatalog } from '@renderer/lib/stores/use-harness-model-catalog';
import { queryClient } from '@renderer/lib/query-client';
import { useLibraryHost } from '@renderer/features/library/library-host';
import { useHarnessModelCredential } from '@renderer/lib/stores/use-harness-model-credential';
import { resolveSignInTarget } from '@renderer/features/settings/agents-page/agent-account';
import { useAgentAuthStatus } from '@renderer/lib/stores/use-agent-auth-status';
import { useAgents } from '@renderer/lib/stores/use-agents';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { Field } from '@renderer/lib/ui/field';
import { cn } from '@renderer/utils/utils';
import {
  agentOffersSessionView,
  agentReadingForLeg,
  agentSupportsAcp,
  agentSupportsAutoApprove,
  agentOffersEditMode,
  agentSupportsPermissionMode,
  agentSupportsPlanMode,
  agentSupportsReadOnlyMode,
  type AgentCapabilities,
  type AgentModelsCapability,
} from '@shared/core/agents/agent-payload';
import { offeredInModelPicker, type PlatformModelOption } from '@shared/core/agents/platform-model';
import {
  extractIssueMentionTargets,
  issueMentionToken,
  parseIssueMentionToken,
} from '@shared/core/issues/issue-context';
import type { LinkedIssue } from '@shared/core/linked-issue';
import { DEFAULT_SESSION_AUTO_APPROVE } from '@shared/core/sessions/default-session-autonomy';
import { buildIssueContextText } from '../context-bar/context-actions';
import { appendInitialSessionText } from '../create-session-modal/initial-session-text';
import { usePromptFileDrop } from '../create-session-modal/use-prompt-file-drop';
import { droppedDirectoryMention } from '@renderer/lib/drag-files';
import {
  createLocalSessionMentionProvider,
  localSessionMentionHiddenContext,
} from '@renderer/lib/chat/local-session-mention-provider';
import { useSessionAgentCreationTools } from '@renderer/lib/chat/use-session-agent-creation-tools';
import { useSessionMentionDrop } from '@renderer/lib/chat/use-session-mention-drop';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { entryUploadItems, type DropEntry } from '@renderer/features/remote-hosts/workspace/remote-drop-items';
import { useComposerFileUploads } from '@renderer/features/sessions/acp/use-composer-file-uploads';
import type { AttachmentUploadRpc } from '@renderer/features/sessions/acp/composer-file-upload';
import type { ComposerAttachmentDraft } from '../composer-attachment-draft';
import {
  guguCatalogNotice,
  usePlatformModelCatalog,
  type PlatformModelCatalog,
} from './platform-model-catalog';
import {
  composerModelSelection,
  composerSelectedOptionId,
  composerModelFooter,
  useComposerModelOptions,
} from './use-composer-model-options';

type RenderMentionIcon = NonNullable<Parameters<typeof ChatComposer>[0]['renderMentionIcon']>;

/**
 * 预览用的 blob URL 必须显式回收:图片 chip 的 previewUrl 是 `URL.createObjectURL` 铸的,
 * 不 revoke 就会把这张图的字节钉在 renderer 里直到进程退出(发一次钉一张)。
 * ChatComposer 只在用户点 × 时 revoke,发送成功与队列裁剪这两条路要自己收。
 */
function releaseAttachmentPreview(attachment: { previewUrl?: string }): void {
  if (attachment.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(attachment.previewUrl);
}

/** 已落盘、待登记的一件 path-mention 附件(#5269)。`name` 是用户读的那个名字。 */
type StagedPathAttachment = {
  id: string;
  /** 我们自己那一份在哪。 */
  storedPath: string;
  /** 用户自己那个文件在哪(拖进来的才有)。 */
  originalPath?: string;
  /** 正文里那条 mention 指向谁 —— 有原路径就是原路径,否则是副本。 */
  mentionPath: string;
  name: string;
  mimeType?: string;
  size: number;
};

export type InitialSessionState = {
  provider: AgentProviderId | null;
  setProvider: (provider: AgentProviderId | null) => void;
  providerError: string | null;
  sessionpage?: AgentCapabilities['sessionpage'] | null;
  /** Full prompt capability used to select the provider's startup transport. */
  promptCapability?: AgentCapabilities['prompt'] | null;
  projectId?: string;
  prompt: string;
  setPrompt: Dispatch<SetStateAction<string>>;
  /** Facts for local-session @ mentions, carried by the ACP startup queue. */
  mentionContext?: string;
  setMentionContext: (context: string | undefined) => void;
  issueContext: string | null;
  setIssueContext: (ctx: string | null) => void;
  /** 三档权限的选中值;下游只认它。 */
  permissionMode: GuguPermissionMode;
  setPermissionMode: (mode: GuguPermissionMode) => void;
  /**
   * 这一刻选中的档能不能无人值守地跑:完全访问,且这家声明了自动批准(聊天页那一面照无人值守走)。
   * 只给「已安排」编辑器判「到点能不能自己开」用;会话记录与启动入参只认 `permissionMode`。
   */
  autoApprove: boolean;
  issueContextEditorOpen: boolean;
  setIssueContextEditorOpen: (open: boolean) => void;
  /**
   * Selected harness model id, or null to use the agent CLI default.
   * Always null while a platform model is selected — the platform choice is recorded on its own
   * (per-conversation platform record) and asserted from there; a harness-side model id here
   * would be a second, contradicting declaration.
   */
  model: string | null;
  setModel: (model: string | null) => void;
  /**
   * 「咕咕提供的模型」目录;取不到就是空数组 —— 分组缺席而 harness 模型照常。
   * Chat UI 开关与这份目录无关:两种会话类型都能选平台模型。
   */
  platformModels: PlatformModelOption[];
  /**
   * 分组不在的原因,给用户看的一行话;null = 没什么可说的(分组在,或者本来就不该有分组)。
   * ❌ 它不是错误状态,不阻断创建,也不弹 toast。
   */
  platformNotice: string | null;
  /**
   * Re-read the platform catalog. Present only while the notice is a reason that may clear by itself
   * (the reason table's `retry` action, `gugu-reason.ts`: host not ready / service unavailable / unreachable); the other
   * reasons are configuration facts a retry cannot change.
   */
  retryPlatformCatalog?: () => void;
  /** harness 模型目录拿不到时的那句话（没装 / 没登录 / 坏了）。 */
  harnessNotice: string | null;
  /** 「坏了」那一态的原因(宿主原文,长度不可控);就地显示在输入框下面,❌ toast(#6692)。 */
  harnessNoticeDetail: string | null;
  /**
   * 去登录的那条路；不是「该去登录」那一态、或开不了登录终端时为 null。
   *
   * ⚠️ 它存在的理由就是那句状态本身**不够**：owner 2026-08-26 实测读到「Kimi 需要先登录
   * （Login with Kimi account）」之后无处可去。一句陈述不是一步操作。
   * ❌ null 时**不渲染**任何入口 —— 控件要么真生效要么不渲染。
   *
   * ⚠️ **2026-09-05 起它只喂模型清单里那一条**(`harnessModelUnlock`)。工具栏上原本还并排着
   * 一枚「去登录」,已删:用咕咕提供的模型不需要登录任何一家,那颗按钮在用户打开任务、扫一眼
   * 底排的那一刻与他要做的事无关。更硬的理由是它会**退化成语义为空**——工具栏那句状态在选了
   * 平台模型时被刻意闭掉(那条会话根本不经过本机 harness),动作词却不受这个条件管,于是句子
   * 没了、按钮还在,变成一个没有上下文的「去登录」贴在一个不需要登录的模型旁边(owner 2026-09-05
   * 截图报的正是这一格)。⇒ 登录入口只在用户**正在挑模型**时出现。
   *
   * ⚠️ 它现在**跳抽屉的「账号」行**(#6100),不再自己弹登录终端。文案不变(「登录以使用 X 模型」),
   *    换的是落点 —— 登录终端只有一个主人,在资源库那一页。
   */
  harnessSignIn: (() => void) | null;
  /**
   * 模型清单里那一组「你的〈厂商〉模型 / 去登录」,与 `harnessSignIn` 同生共死。
   *
   * ⚠️ 为什么非得在**清单里**:没登录时 harness 那档是空的,原来那一行整个不渲染,面板上就只剩
   * 「推理强度」—— owner 2026-08-26 实测报的正是这句「只有推理强度,反而没有模型」。
   * 而它又必须**排在清单最前**:owner 2026-08-28 实测放末尾时它躺在咕咕那十几个模型下面,
   * 「我翻了半天才找到」。
   */
  harnessModelUnlock: { groupLabel: string; label: string; title: string } | null;
  /**
   * 选中的平台模型 id,null = 用 harness 自家模型(纯 BYOK)。
   * composer 是会话的唯一决策点:这里为 null 就不注入平台环境,即使 agent 级 model_access
   * 配了平台模型也一样。
   */
  platformModel: string | null;
  setPlatformModel: (modelId: string | null) => void;
  /**
   * Reasoning-effort levels the *selected model* accepts, or null when it takes none
   * (codex gpt-5.3-codex-spark, Claude Code haiku) — the composer then hides the control
   * rather than offering a level the CLI would reject.
   */
  effortOptions: Record<string, ComposerEffortOption> | null;
  /** Selected effort id, or null when nothing is armed (the CLI then resolves it itself). */
  effort: string | null;
  setEffort: (effort: string | null) => void;
  /** What the CLI would pick on its own for this model — shown in the 「默认」 row. */
  defaultEffort: string | null;
  /** Persist the complete launch configuration only after a session has actually been created. */
  /** Saves what was started into the new-session memory; rejects when it cannot be saved (fail loud). */
  rememberStartedConfiguration: () => Promise<void>;
  /**
   * 这条会话以哪一种**展示**开:`'code'` 编程视角(harness 自己的原生 TUI 跑在终端里),
   * `'general'` 通用视角(咕咕渲染的结构化聊天面板)。这是**生效值**:用户的持久偏好经这一家的
   * 能力与入口解析之后的结果,可能与偏好不同(见 `generalForcedHere`、只有通用视角的 agent)。
   * ⚠️ 运行时起哪种进程(pty / acp)是另一层事实,只在构造载荷那一刻翻译一次。
   */
  sessionView: SessionView;
  /** 人在框里选展示,或一条已存记录(自动化)自己的展示:只覆盖这一个框,生效值随之重算。 */
  setSessionView: (next: SessionView) => void;
  /**
   * 框里给不给「终端 | 通用」那个选择。两个条件都要:本机设置开着「允许以终端（TUI）模式启动 agent」
   * (`terminal.enabled`),且这一家有第二种展示(只有一种展示的 harness 没什么可切)。
   */
  sessionViewOffered: boolean;
  /**
   * 这一家在这个入口下被钉在某一种展示上。`view` 与 `sessionView` 一定相等 —— 控件显示的
   * 就是这条会话真实的展示,另一头灰掉并说明原因(reason 由控件翻成人话)。
   */
  sessionViewLock: SessionViewLockState | null;
  /** Session mode currently used to filter the session-page provider selector. */
  providerSelectionSurface?: 'acp' | 'tui';
  /**
   * 这一轮收不了附件(#6264:会话页在别的机器上开会话 —— 那条设备接口只收文字)。
   * 输入框据此把「+」键压成不可用、拖进来的文件当场说明,❌ 等到发送才失败。
   * 对话页在别的机器上建 agent 不在此列:它的附件走私聊,照常能发。
   */
  /** #6264 会话建在别的机器上(附件的字节落在那台机器上;本机文件夹的路径在那边不存在)。本机 = null。 */
  machine: string | null;
  issueMentionContexts: Record<string, string>;
  setIssueMentionContext: (token: string, context: string | null) => void;
  /**
   * 这一轮的附件走哪条路(#4325)。它**不是新轴**,是 `SessionCreationSurface` 那个既有事实的又一条
   * 后果——「这条消息以什么身份发出去」同时决定正文与附件怎么编码:
   * - `'chat-attachment'`:这条消息是一条真 IM 私聊消息(对话页创建),附件必须与该 DM 里任何
   *   一条附件消息同路——待发队列 → 上传 chat-media → attachment 消息 → 标准投递。
   * - `'path-mention'`:这条消息是会话内输入(会话页创建),附件按这条会话自己后续每一轮的
   *   编码方式给出绝对路径 mention。
   */
  attachmentChannel: 'chat-attachment' | 'path-mention';
  /** 待发附件(仅 chat-attachment 通道):composer 是它们唯一的保管者,一件真落库才移走一件。 */
  attachments: ComposerAttachment[];
  /**
   * 用户自己增删待发附件的次数。发送端 `dropAttachment` **不**计入 —— 它改的是「还剩什么没发」,
   * 不是「用户把这一轮改成了别的样子」。谁要判断「屏幕上这一轮还是不是失败原因描述的那一轮」,
   * 读这个,❌ 不读 `attachments.length`。
   */
  attachmentEditSeq: number;
  /** 把文件收进待发队列(chat-attachment 通道)。异步:入列时要读一份文本预览(#5269)。 */
  enqueueAttachments: (files: File[]) => Promise<void>;
  /**
   * 把文件收成 path-mention 通道的 chip(#5269)。落盘取路径 → 屏幕上是附件 chip,
   * 发送时由 `pathAttachmentMentions` 拼进正文。❌ 不进 chat 待发队列。
   */
  enqueuePathAttachments: (files: File[]) => Promise<void>;
  /**
   * 这一轮任务的 id。附件的字节要在任务建出来**之前**落进 `<userData>/task-attachments/<conversationId>/`
   * (那条路径就是首轮 mention 的目标),所以 id 由 composer 先定下来,创建时照用(#5269)。
   */
  reserveSessionId: () => string;
  /** 已落盘、等着任务建出来之后补登记进库的那几件(见 `rpc.sessionCreate.recordAttachments`)。 */
  pathAttachmentEntries: () => StagedPathAttachment[];
  /** path 通道这一轮的附件序列化成 `@[名字](绝对路径)` —— 发送时拼进正文。 */
  pathAttachmentMentions: () => string[];
  /**
   * #6264 path 通道的附件贴上来就开始传(传到会话要建在的那台机器),创建时还没传完就等:
   * 全都传成了 → true;有一件没成 → false(那一件的 chip 上写着为什么、能重试)。
   */
  waitForPathAttachments: () => Promise<boolean>;
  /** 有没有还没传成的 path 附件(没有就不必等)。 */
  pathAttachmentsUnsettled: () => boolean;
  /** 点了失败 chip 上的「重试」。 */
  retryPathAttachment: (id: string) => void;
  /** 拖进来的文件夹(别的机器上:整个传过去;本机:由调用方落成路径 pill)。 */
  enqueueFolderAttachments: (entries: FileSystemDirectoryEntry[]) => Promise<void>;
  /** 用户在 composer 上增删附件后的同步入口(chip 的 × 走它)。 */
  setAttachments: (next: ComposerAttachment[]) => void;
  /** 当前待发附件对应的原始 File —— 发送端据此知道「还剩哪几件没发」。 */
  pendingAttachmentFiles: () => Array<{ id: string; file: File }>;
  /** 某一件真的提交之后,把它从 composer 移走。 */
  dropAttachment: (id: string) => void;
  captureAttachmentDraft: () => ComposerAttachmentDraft;
};

interface InitialSessionStateOptions {
  resetPromptOnProjectChange?: boolean;
  /**
   * 这次创建从哪一面发起。它**不直接**决定附件编码 —— 编码由 `firstTurnTransportOf` 那一个
   * 表达式算出来,与正文走的是同一条(#4325)。❌ 不要在这里改成直接传 attachmentChannel:
   * 那等于让两条轴各算一遍,而它们漂开就是本票要修的那个 bug。
   */
  creationSurface?: SessionCreationSurface;
  /**
   * 这条会话开出来时**没人守着**(「已安排」到点自己跑)。默认档因此是无人值守那一档,且❌ 不继承会话页
   * 那份「上次启动记住的档」—— 与对话页创建同一个理由(见 `unattendedDefault`)。
   * 它只改权限档的默认值;首轮与附件怎么投递仍由 `creationSurface` 管。
   */
  unattended?: boolean;
  /**
   * 挂上时输入框里已经有的内容。新建页换机器会整棵重挂(上一台的 agent / 模型不带到下一台),
   * 但用户已经写好的话要跟着走 —— ❌ 换一台机器就把草稿清空。
   */
  initialPrompt?: string;
  initialAttachmentDraft?: ComposerAttachmentDraft;
  /** 这个框把首句派成群里的一张任务卡(`taskChatId`):首句是一条真的咕咕消息,见 `terminalLegUnstartableForCreation`。 */
  dispatchesToChat?: boolean;
}

/**
 * 从这里建,终端腿起不来:首句要终端腿接住一条真的咕咕消息,而它接不住。
 *  · 对话页:终端腿收不到入站(`inbound: 'none'`,kimi 那一格);同一家在会话页上终端照样可选。
 *  · 派进群里的任务(项目里的新任务):首句是那张任务卡,终端腿要有吃得下消息首句的启动通道
 *    (`providerTakesMessageStartupInPty`,codex 那一格)—— 主进程起 pty 时那道闸问的是同一个函数,
 *    所以框里给得出「终端」的,起得来。
 */
export function terminalLegUnstartableForCreation(input: {
  sessionpage: AgentCapabilities['sessionpage'] | null | undefined;
  prompt: AgentCapabilities['prompt'] | null | undefined;
  creationSurface: SessionCreationSurface;
  dispatchesToChat: boolean;
}): boolean {
  const tui = input.sessionpage?.['tui'];
  if (!tui) return false;
  if (input.creationSurface === 'chat-page') return tui.inbound === 'none';
  return input.dispatchesToChat && !providerTakesMessageStartupInPty(input.prompt ?? undefined, tui.messageTransport);
}

/** Resolve the leg for this creation without retiring a still-targeted TUI form. */
export function sessionpageLegForCreation(input: {
  sessionpage: AgentCapabilities['sessionpage'] | null | undefined;
  preferred: 'acp' | 'tui';
  /** `terminalLegUnstartableForCreation` 的答案。 */
  terminalUnstartable: boolean;
}): 'acp' | 'tui' {
  if (input.preferred === 'tui' && input.terminalUnstartable) {
    return sessionpageLegFor(input.sessionpage ?? undefined, 'acp') ?? input.preferred;
  }
  if (input.sessionpage?.[input.preferred] !== undefined) return input.preferred;
  return sessionpageLegFor(input.sessionpage ?? undefined, input.preferred) ?? input.preferred;
}

/**
 * What was last started (provider, model / platform model / effort, permission mode, whether the provider was the
 * person's or the factory guess) — a field of the app setting `newSessionMemory` (main's settings schema), which this
 * box writes when a session starts and main's spawnAgent reads.
 */
type LastStartedSessionConfiguration = NonNullable<NewSessionMemory['lastStarted']>;

export function resolveInitialModel(
  provider: AgentProviderId | null,
  models: AgentModelsCapability | undefined,
  lastStarted: LastStartedSessionConfiguration | null
): string | null {
  if (!provider || models?.kind !== 'selectable') return null;
  const availableModelIds = Object.keys(models.modelOptions);
  if (
    lastStarted?.provider === provider &&
    lastStarted.model &&
    availableModelIds.includes(lastStarted.model)
  ) {
    return lastStarted.model;
  }
  if (models.defaultModelId && availableModelIds.includes(models.defaultModelId)) {
    return models.defaultModelId;
  }
  return availableModelIds[0] ?? null;
}

/**
 * 下拉里该预选哪个平台模型,null = 预选 harness 自家模型。
 *
 * 优先级:用户在本 composer 上的显式选择 > 上次真的启动过的会话 > agent 级 model_access
 * > 引擎的出厂平台模型 > 凭据兜底(#4956)。第三档是 owner 的定调 —— 「运行模型」面板配的平台模型退位成**默认值**,
 * 不再决定会话是否上平台;所以它只在用户还没表过态时说话。
 *
 * 第四档是 product spec「模型来源与 UI」的默认预选规则:**将要预选的那个自家模型**
 * (恢复记录里的,或 harness 自家现行默认)判得出没有可用凭据时,预选平台目录第一条
 * (目录顺序由服务端 sort_order 决定)—— 把一条没凭据的自家 provider 当默认,是把新用户的
 * 第一次发送直接送进死路。判不出(unknown)一律不动,维持自家默认。
 *
 * 目录里没有的 id 一律当没选中:模型下线或换了 provider 之后,继续显示一个选不动的名字
 * 比回到 harness 更难看懂。
 */
export function resolvePlatformModel(
  catalog: PlatformModelCatalog,
  provider: AgentProviderId | null,
  /** 用户在本次会话里的选择:string = 某个平台模型,null = 明确要 harness,undefined = 还没选过。 */
  override: string | null | undefined,
  lastStarted: LastStartedSessionConfiguration | null,
  /**
   * 将要预选的那个自家模型(恢复记录里的,或 harness 自家现行默认)判得出没有可用凭据。
   * ⚠️ 必传,❌ 不给默认值:给了 `= false`,漏传的新调用点会静默把 #4956 那一档整个关掉,
   *    编译还照过 —— 那正是只有再来一轮真机复现才发现得了的洞。
   */
  harnessDefaultUncredentialed: boolean
): string | null {
  // 只认下拉里列着的(#7056):要会员的、他在设置「模型」页关掉的都不在下拉里 ——
  // 记住的、agent 默认的、凭据兜底的,一律跳过它们,❌ 新用户第一句话就撞上「要会员」。
  const usable = catalog.models.filter(offeredInModelPicker);
  const listed = (modelId: string | null | undefined): string | null =>
    modelId && usable.some((model) => model.id === modelId) ? modelId : null;

  if (override !== undefined) return listed(override);
  if (provider && lastStarted?.provider === provider && lastStarted.platformModel) {
    const remembered = listed(lastStarted.platformModel);
    // 记住的平台模型已从目录下架时**继续往下走**,❌ 不在这里定格成 null:那会跳过下面的
    // 凭据兜底档,把用户重新送回一条判得出无凭据的自家默认 —— 恰是本档要救的那类人。
    if (remembered) return remembered;
  }
  // 用户上次选了自家模型,有凭据或尚不能判定时沿用；无凭据仍走原来的可用性规则。
  if (provider && lastStarted?.provider === provider && lastStarted.model && !lastStarted.platformModel && !harnessDefaultUncredentialed) {
    return null;
  }
  const agentDefault = listed(catalog.agentDefault?.modelId);
  if (agentDefault) return agentDefault;
  const factoryDefault = listed(provider ? DEFAULT_PLATFORM_MODEL_BY_PROVIDER[provider] : null);
  if (factoryDefault) return factoryDefault;
  if (provider && DEFAULT_PLATFORM_MODEL_BY_PROVIDER[provider]) {
    const freeDefault = listed(DEFAULT_FREE_PLATFORM_MODEL);
    if (freeDefault) return freeDefault;
  }
  // ⚠️ 这一档刻意**不**给「上次记录里有自家模型」让路:记录写在**会话创建成功**那一刻,
  //    而 #4956 的死法发生在创建之后的第一次模型调用 —— 踩过一次坑的用户记录里躺着的
  //    正是那个死模型,给它让路等于把受害者永远钉在死路上。真正该让路的情形
  //    (恢复的模型有凭据/判不出)由入参本身表达:凭据判读作用于将要预选的那个模型。
  if (harnessDefaultUncredentialed) return usable[0]?.id ?? null;
  return null;
}

/**
 * Pick the effort level for a model, given what the user last picked for it.
 *
 * Effort is resolved per (provider, model) rather than per provider: the tiers differ by
 * model — codex gpt-5.6-sol reaches `ultra` while gpt-5.5 stops at `xhigh` — so a level
 * armed on one model is not necessarily offered by the next, and carrying it over would
 * send the CLI a value it rejects. An override the new model doesn't list is dropped.
 *
 * Nothing is armed by default. The plugin's `defaultEffortId` describes what the CLI would
 * pick on its own; arming it here would make every task pass an explicit level and thereby
 * override a user's own `model_reasoning_effort` in ~/.codex/config.toml with a value they
 * never chose. Null = send no flag and let the CLI resolve it — the level is shown as
 * 「默认」 in the picker instead.
 */
import { localizeEffortOptions } from './effort-options';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
export function resolveInitialEffort(
  efforts: ResolvedModelEfforts | null,
  override: string | null | undefined
): string | null {
  if (!efforts) return null;
  return override && efforts.options[override] ? override : null;
}

export function useInitialSessionState(
  projectId?: string,
  initialProvider?: AgentProviderId,
  autoApproveByDefault = DEFAULT_SESSION_AUTO_APPROVE,
  options: InitialSessionStateOptions = {}
): InitialSessionState {
  const {
    resetPromptOnProjectChange = true,
    unattended = false,
    creationSurface = 'session-page',
    initialPrompt = '',
    dispatchesToChat = false,
  } = options;
  const { translate } = useSessionMessages();
  // 新建会话的记忆 —— 应用设置 `newSessionMemory`,这台设备一份;主进程的 spawnAgent 读的是同一份(L11 复核 58)。
  const { value: memory, update: updateMemory, updateAsync: updateMemoryAsync } = useAppSettingsKey('newSessionMemory');
  const lastStartedConfiguration = memory?.lastStarted ?? null;
  /** 正在编辑一条已存记录(自动化)—— 它的 agent 是那条记录的属性,❌ 不写进全局的「我上次选的」。 */
  const editingStoredRecord = initialProvider !== undefined;
  // 新会话默认通用。设置里开着「允许以终端（TUI）模式启动 agent」时,框里给「终端 | 通用」由人选(owner 10-30);
  // 编辑一条已存的自动化时,先由那条记录自己的展示播种。两者都只覆盖这一个框(`setSessionView`,❌ 写回任何全局设置)。
  const terminalEnabled = useTerminalEnabled();
  const [sessionViewOverride, setSessionViewOverride] = useState<SessionView | null>(null);
  const sessionViewPreference = sessionViewOverride ?? DEFAULT_SESSION_VIEW;
  // #6264 远端创建框:只经云端连着的机器只有聊天界面那条腿(终端画面走不了云端消息通道),
  // 所以钉在它上面 —— 显示「编程」却建出「通用」就是界面说假话。
  // 在这台桌面上用 SSH 装上的机器和本机一样两种都给(behavior「别的机器上的编程只给用 SSH 装上的机器」)。
  const remoteHost = useLibraryHost().remote;
  const machine = remoteHost?.deviceId ?? null;
  const machineDevice = machine ? remoteHostsStore.device(machine) : null;
  const remoteGeneralOnly = machine !== null && machineDevice?.directTerminal !== true;
  const preferredSessionpageLeg = remoteGeneralOnly ? 'acp' : sessionpageLegOfView(sessionViewPreference);
  const {
    providerId,
    setProviderOverride,
    error: providerError,
    chosenByUser: providerChosenByUser,
  } = useEffectiveProvider(
    initialProvider,
    preferredSessionpageLeg,
    // 记忆单独一格传进去 —— 并进上面那个初值,换项目时的重置会连它一起抹掉(#5973)。
    // 亲手点过的那一家 > 上次真启动过的那家;出厂偏好猜出来的那家不算记忆,否则它排到「设置里的默认 Agent」
    // 前面,用户后来在设置里选的那家永远不生效。一个函数,主进程同用(`rememberedProviderOf`)。
    rememberedProviderOf(memory)
  );
  const { data: agents } = useAgents();
  const [prompt, setPrompt] = useState(initialPrompt);
  const [mentionContext, setMentionContext] = useState<string | undefined>();
  const [issueContext, setIssueContext] = useState<string | null>(null);
  const [permissionModeOverride, setPermissionModeOverride] = useState<GuguPermissionMode | null>(
    null
  );
  const [issueContextEditorOpen, setIssueContextEditorOpen] = useState(false);
  const [modelOverrides, setModelOverrides] = useState<Record<string, string>>({});
  // 每个 provider 一格三态:平台模型 id / null(明确选了 harness)/ 缺席(还没表过态)。
  // 缺席与 null 必须分得开 —— 前者才轮得到 agent 级默认值说话。
  const [platformModelOverrides, setPlatformModelOverrides] = useState<
    Record<string, string | null>
  >({});
  // Keyed by `${provider}:${model}` — see resolveInitialEffort for why effort is per-model.
  const [effortOverrides, setEffortOverrides] = useState<Record<string, string | null>>({});
  const [issueMentionContexts, setIssueMentionContexts] = useState<Record<string, string>>({});
  // #4325 —— chat-attachment 通道的待发队列。composer 是这些文件的唯一保管者:一件真的落库了才
  // 把它移走,所以「屏幕上还剩什么」逐字等于「重试还要发什么」,不需要第二份快照。
  const initialAttachmentDraft = useRef(options.initialAttachmentDraft).current;
  const [attachments, setAttachmentsState] = useState<ComposerAttachment[]>(() => initialAttachmentDraft?.pending.map(({ chip }) => chip) ?? []);
  const pendingAttachmentFilesRef = useRef(new Map(initialAttachmentDraft?.pending.map(({ chip, file }) => [chip.id, file])));
  // 用户**自己**动过这个队列多少次。⚠️ 只有用户的增删算数:发送端也在改队列(每送达一件
  // dropAttachment 一件),所以「还剩几件」不是「这一轮的内容变了没有」—— 拿它当后者用,
  // 会让一次部分成功之后的失败原因在同一批渲染里被自己清掉(见 use-create-session-callback
  // 的 deliveryErrorSubject)。那正是本票要判死的静默丢,只是换成了「原因静默消失」。
  const [attachmentEditSeq, setAttachmentEditSeq] = useState(0);
  // path-mention 通道自己的那一半(#5269)。这条通道上首轮还没有活的 agent 会话,文件到达
  // agent 的唯一途径是 prompt 里的绝对路径 —— 但那是**传输**,不该是用户看见的样子。
  // owner 2026-09-08:「我粘贴图片,你应该把他当作附件处理」。⇒ 屏幕上是 chip,发送时才把
  // 路径拼进这一轮的正文(见 `pathAttachmentMentions` 与 use-create-session-callback)。
  // ⚠️ 它**不进** `pendingAttachmentFilesRef` —— 那个队列是 chat-attachment 专属,
  // `strayChatAttachmentError` 会对它在 path-mention 轮上非空当场判死(#5049 的教训)。
  const pathAttachmentsRef = useRef(new Map<string, StagedPathAttachment>());
  /**
   * 这一轮任务的 id **在这里就定下来**(#5269)。
   *
   * 附件的字节要落进 `<userData>/task-attachments/<conversationId>/`,而这条绝对路径必须在**发送之前**
   * 就存在 —— 首轮里它就是正文中那条 mention 的目标。任务却要等用户点「创建」才建出来。
   * ⇒ id 先定,字节先落盘,库里那一行等任务建好之后补(`recordAttachments`)。
   * 中途走开留下的目录不会烂在那儿:目录名就是 conversationId,下次启动
   * `sweepOrphanSessionAttachmentDirectories` 按「库里有没有这个任务」精确认领。
   * ❌ 不再落 `$TMPDIR/gugu-dropped-blobs`:那是退出即清的传输缓冲,而消息里的 mention 长期
   * 指着它 —— owner 2026-09-09 报的「打不开」就是这条(那一刀先修的是任务内 composer,
   * 新建会话页这一格还留着)。
   */
  const reservedSessionIdRef = useRef<string | null>(null);
  const reserveSessionId = useCallback(() => {
    reservedSessionIdRef.current ??= crypto.randomUUID();
    return reservedSessionIdRef.current;
  }, []);
  // #6264 字节贴上来就开始传到会话要建在的那台机器(本机就是本机),进度在 chip 上;只落盘不登记,
  // 库里那一行等任务建好之后补(`recordAttachments`)。与任务内输入框同一套(use-composer-file-uploads.ts)。
  const fileUploads = useComposerFileUploads({
    sessionId: reserveSessionId,
    deviceLabel: () => (machine ? (remoteHostsStore.device(machine)?.label ?? machine) : null),
    setAttachments: setAttachmentsState,
    onUploaded: (chipId, committed) => pathAttachmentsRef.current.set(chipId, committed),
    translate,
    record: false,
    // ⚠️ 任务还没建出来,预留的 id 哪台机器都不认识 —— 按参数选线会落到本机。字节要去的机器由这里点名。
    uploadRpc: rpcOn(machine).sessionCreate as unknown as AttachmentUploadRpc,
  });
  const restoredAttachmentDraft = useRef(false);
  useEffect(() => {
    if (restoredAttachmentDraft.current) return;
    restoredAttachmentDraft.current = true;
    for (const { chip, source } of initialAttachmentDraft?.uploads ?? []) {
      void fileUploads.add(chip, source);
    }
  }, [initialAttachmentDraft, fileUploads]);
  const enqueuePathAttachments = useCallback(async (files: File[]) => {
    for (const file of files) {
      // 字节一律存一份;这里只判**发给 agent 的 mention 指向谁** —— 拖进来的带着用户自己盘上
      // 的真路径(他可能正想让 agent 就地改它),粘贴进来的没有路径,只能指副本。
      // 这个判断只有渲染层做得了(主进程拿到的只是参数),判据与任务内 composer 共用一份。
      // #6264 别的机器上:这台电脑上的路径在那边不存在,mention 一律指落在那台机器上的副本。
      const originalPath = machine ? '' : electronApi().getPathForFile(file).trim();
      const source = composerAttachmentSource({
        originalPath,
        mustCopy: mustCopyRatherThanReference(originalPath),
        isHeicLike: isHeicLikeFile(file),
      });
      const name = file.name || originalPath.split('/').pop() || 'attachment';
      const image = file.type.toLowerCase().startsWith('image/');
      // 文本类附件的内容在这里读一份 —— chip 点开要看的就是它(#5269)。❌ 不要等点开时再去
      // 磁盘上找:那条路上有找不到的一格,而用户看到的会是一个空对话框。
      const preview = image ? undefined : await readAttachmentPreviewText(file);
      void fileUploads.add(
        {
          id: crypto.randomUUID(),
          name,
          kind: image ? ('image' as const) : ('file' as const),
          mimeType: file.type,
          previewUrl: image ? URL.createObjectURL(file) : undefined,
          previewText: preview?.text,
          previewTruncated: preview?.truncated,
        },
        {
          kind: 'file',
          name,
          ...(file.type ? { mimeType: file.type } : {}),
          ...(source === 'reference' ? { originalPath } : {}),
          size: file.size,
          slice: async (start, end) => new Uint8Array(await file.slice(start, end).arrayBuffer()),
        }
      );
    }
    setAttachmentEditSeq((seq) => seq + 1);
  }, [machine, fileUploads]);
  const enqueueFolderAttachments = useCallback(async (entries: FileSystemDirectoryEntry[]) => {
    for (const entry of entries) {
      const pieces = await entryUploadItems(entry as unknown as DropEntry);
      void fileUploads.add(
        { id: crypto.randomUUID(), name: entry.name, kind: 'file', mimeType: 'inode/directory' },
        { kind: 'folder', name: entry.name, pieces }
      );
    }
    setAttachmentEditSeq((seq) => seq + 1);
  }, [fileUploads]);
  /** 已落盘、等任务建出来之后补登记的那几件。 */
  const pathAttachmentEntries = useCallback(() => [...pathAttachmentsRef.current.values()], []);
  /** 这一轮的 path 附件序列化成 mention —— 发送时拼进正文,那是它们到达 agent 的路。 */
  const pathAttachmentMentions = useCallback(
    () =>
      [...pathAttachmentsRef.current.values()].map((entry) =>
        stringifyMention({ label: entry.name, target: entry.mentionPath, kind: 'file' })
      ),
    []
  );
  const enqueueAttachments = useCallback(async (files: File[]) => {
    const queued = await Promise.all(
      files.map(async (file) => {
        const id = crypto.randomUUID();
        pendingAttachmentFilesRef.current.set(id, file);
        const image = file.type.toLowerCase().startsWith('image/');
        // 与 path-mention 那条车道同一句:chip 点开看的内容,入列时就得在手上。
        const preview = image ? undefined : await readAttachmentPreviewText(file);
        return {
          id,
          name: file.name,
          kind: image ? ('image' as const) : ('file' as const),
          mimeType: file.type,
          previewUrl: image ? URL.createObjectURL(file) : undefined,
          previewText: preview?.text,
          previewTruncated: preview?.truncated,
        };
      })
    );
    setAttachmentsState((current) => [...current, ...queued]);
    setAttachmentEditSeq((seq) => seq + 1);
  }, []);
  const setAttachments = useCallback((next: ComposerAttachment[]) => {
    // ChatComposer 是从它手上那份(可能已经过期的)props 算出 next 的。发送中途点掉某个 chip 时,
    // 那份快照里可能还留着刚刚送达、已被 dropAttachment 移走的那一件 —— 原样写回去会把它**复活**成
    // 一个没有 File 撑着的 chip:发不出去、又让 hasTurnContent 恒真。所以只允许做减法:
    // 交集 = 用户还留着的 ∩ 确实还有 File 的。
    // 「还有东西撑着」有两种:chat 通道靠 File,path 通道靠那条已落盘的路径。两边都算数,
    // ❌ 只认一种会让另一种的 chip 在用户点任意一个 × 时集体消失。
    const kept = next.filter(
      (attachment) =>
        pendingAttachmentFilesRef.current.has(attachment.id) ||
        pathAttachmentsRef.current.has(attachment.id) ||
        fileUploads.has(attachment.id)
    );
    const live = new Set(kept.map((attachment) => attachment.id));
    fileUploads.keepOnly(live);
    setAttachmentsState((current) => {
      for (const attachment of current) {
        if (!live.has(attachment.id)) releaseAttachmentPreview(attachment);
      }
      return kept;
    });
    for (const id of [...pendingAttachmentFilesRef.current.keys()]) {
      if (!live.has(id)) pendingAttachmentFilesRef.current.delete(id);
    }
    for (const id of [...pathAttachmentsRef.current.keys()]) {
      if (!live.has(id)) pathAttachmentsRef.current.delete(id);
    }
    setAttachmentEditSeq((seq) => seq + 1);
  }, [fileUploads]);
  const dropAttachment = useCallback((id: string) => {
    pendingAttachmentFilesRef.current.delete(id);
    pathAttachmentsRef.current.delete(id);
    fileUploads.forget(id);
    setAttachmentsState((current) => {
      const going = current.find((attachment) => attachment.id === id);
      if (going) releaseAttachmentPreview(going);
      return current.filter((attachment) => attachment.id !== id);
    });
  }, [fileUploads]);
  const pendingAttachmentFiles = useCallback(
    () => [...pendingAttachmentFilesRef.current].map(([id, file]) => ({ id, file })),
    []
  );
  // 通道一离开,属于那条通道的排队就地收掉 —— 留着只会伪装成「这一轮有内容」(见下面那个
  // effect 的长注释)。⚠️ 只收自己那一半:两条通道各有各的队列,互相清就是把对方的 chip 清没。
  const clearAttachmentsOfChannel = useCallback((channel: 'chat-attachment' | 'path-mention') => {
    const going = channel === 'chat-attachment' ? pendingAttachmentFilesRef : pathAttachmentsRef;
    const uploading = channel === 'path-mention' ? fileUploads.ids() : [];
    if (going.current.size === 0 && uploading.length === 0) return;
    const ids = new Set([...going.current.keys(), ...uploading]);
    going.current.clear();
    if (channel === 'path-mention') {
      fileUploads.keepOnly(new Set());
      fileUploads.clear();
    }
    setAttachmentsState((current) => {
      const kept: ComposerAttachment[] = [];
      for (const attachment of current) {
        if (ids.has(attachment.id)) releaseAttachmentPreview(attachment);
        else kept.push(attachment);
      }
      return kept;
    });
    setAttachmentEditSeq((seq) => seq + 1);
  }, [fileUploads]);
  // chip 的 ×、送达、通道切换都各自 revoke 了;唯独整棵子树被卸走时没人收 —— 那会把每张
  // 排过队的图的字节钉在 renderer 里直到进程退出。
  const attachmentsRef = useRef<ComposerAttachment[]>([]);
  const transferredPreviews = useRef(new Set<string>());
  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);
  useEffect(() => () => {
    for (const attachment of attachmentsRef.current) {
      if (!attachment.previewUrl || !transferredPreviews.current.has(attachment.previewUrl)) releaseAttachmentPreview(attachment);
    }
  }, []);
  const captureAttachmentDraft = useCallback((): ComposerAttachmentDraft => {
    const sources = fileUploads.sources();
    const snapshot: ComposerAttachmentDraft = { uploads: [], pending: [] };
    for (const chip of attachmentsRef.current) {
      const source = sources.get(chip.id);
      const file = pendingAttachmentFilesRef.current.get(chip.id);
      if (source) snapshot.uploads.push({ chip: { ...chip }, source });
      else if (file) snapshot.pending.push({ chip: { ...chip }, file });
      else throw new Error(`Missing attachment source: ${chip.id}`);
      // blob 预览的所有权一并交给目标草稿;卸载旧页不能把新页的图撤掉。
      if (chip.previewUrl) transferredPreviews.current.add(chip.previewUrl);
    }
    fileUploads.keepOnly(new Set());
    return snapshot;
  }, [fileUploads]);
  const [prevProjectId, setPrevProjectId] = useState(projectId);
  const projectChanged = projectId !== prevProjectId;

  if (projectChanged) {
    setPrevProjectId(projectId);
    if (resetPromptOnProjectChange) {
      // ❌ 不清 providerOverride:agent 选的是「谁来干」,不是项目的属性。从前这里连它一起清,
      // 于是「点了 Claude、还没发送、换个项目」就退回出厂偏好(#5973 报票人踩的正是这一类)。
      setPrompt('');
      setModelOverrides({});
      setPlatformModelOverrides({});
      setEffortOverrides({});
    }
    setIssueContext(null);
    setPermissionModeOverride(null);
    setIssueContextEditorOpen(false);
    setIssueMentionContexts({});
  }

  const resolvedCapabilities = agents?.find((agent) => agent.id === providerId)?.capabilities;
  // An unavailable provider can be retained for its diagnostic, but its payload may be partial.
  // Treat capabilities as absent so model/permission controls fail closed and the error can render.
  const capabilities = providerError ? null : resolvedCapabilities;
  const modelOverride = providerId ? modelOverrides[providerId] : undefined;
  // 「去登录」要跳资源库的智能体抽屉(#6100),所以这条状态 hook 也需要导航。
  const { navigate } = useNavigate();
  /**
   * **只有聊天腿的引擎** —— 聊天不是偏好，是这一家唯一的形态，所以锁死在聊天。
   *
   * ⚠️ 这不是「界面上好看一点」，不锁就**用不了**。一条根因两个症状（owner 2026-08-28 实测，
   * kimi）：下面 `sessionpageSurface` 由偏好推出，而平台模型目录是**按腿**取的 ——
   *  · 偏好为终端 ⇒ 按 `tui` 取目录 ⇒ 这家没有那条腿 ⇒ 目录空 ⇒ `guguModelsAvailable`
   *    为假 ⇒ 模型选择器被「需要先登录」那条提示整个顶掉，用户连咕咕自己的模型都挑不到；
   *  · 真发送时又走终端腿 ⇒ `resolveSessionTuiHostAdapter` 抛
   *    「does not declare a session-TUI host adapter」，会话根本起不来。
   *
   * ⇒ 判据用 `sessionpage['tui']` 而不是 `surfaces`：前者才是「会话页给不给这条腿」，
   *   而 `resolveSessionTuiHostAdapter` 抛不抛正是看它。opencode 从来就是这个形态，
   *   本条同时把它那一格补上。
   */
  // 压根没声明通用视角的 harness(如 Pi:surfaces 只有 tui)没有第二种展示,控件不出现。
  const sessionViewOffered = agentSupportsAcp(capabilities);
  const generalOnlyAgent = sessionViewOffered && !agentOffersSessionView(capabilities, 'code');
  // owner 2026-08-21:**声明没闭合 ≠ 不支持**。harness 自己说了 `acp: supported`,却因为 acp
  // 面的 identity / messageTransport 仍是 none 而接不通时,这条会话只能用编程视角 —— 偏好里存着
  // 「通用」也不算数,否则控件显示编程、载荷却是 acp,两边说的不是同一条会话。
  //
  // 判据与主进程建会话(create-session.ts)共用同一份(`agentOffersSessionView`),❌ 两处各写一份组合就会漂。
  const generalWired = agentOffersSessionView(capabilities, 'general');
  const resolvablePreferredSurface =
    sessionViewOffered && !generalOnlyAgent && !generalWired ? 'tui' : preferredSessionpageLeg;
  const terminalUnstartable = terminalLegUnstartableForCreation({
    sessionpage: capabilities?.sessionpage,
    prompt: capabilities?.prompt,
    creationSurface,
    dispatchesToChat,
  });
  const sessionpageSurface = sessionpageLegForCreation({
    sessionpage: capabilities?.sessionpage,
    preferred: resolvablePreferredSurface,
    terminalUnstartable,
  });
  // 目录按这条会话会落的那条腿取(#6246):两条腿的配置根可能不同(pi:终端腿读用户自己的根,
  // ACP 腿读咕咕自有的根),拿另一条腿的清单当菜单,就会列出这条腿跑不了的、或漏掉跑得了的。
  const harnessCatalog = useHarnessModelCatalog(providerId, sessionpageSurface);
  const harnessCatalogState = harnessCatalog.state;
  const liveModelsCapability = harnessCatalogToModelsCapability(
    harnessCatalogState,
    capabilities?.effort.kind === 'selectable' ? Object.keys(capabilities.effort.effortOptions) : []
  );
  // 不说 ACP 的 agent（amp / antigravity 等 15 家）永远拿不到活目录 —— 对它们，插件静态表
  // 就是原来那个唯一来源，照旧用。这不是「兜底」：那些 agent 从来没有第二个来源可退。
  const staticModelsCapability =
    capabilities?.models.kind === 'selectable' ? capabilities.models : undefined;
  const effectiveModelsCapability =
    harnessCatalogState.kind === 'unsupported' ? staticModelsCapability : liveModelsCapability;
  // 默认值也走活目录 —— 这是 owner 最初那个 bug 的另一条命：静态表的 `claude-opus-4-8`
  // 在 claude 2.1.229 里根本不被识别（原样透传、窗口回落 200K）。只换下拉不换默认值的话，
  // 界面显示「Not selected」，载荷里却仍旧带着那个死 id 发出去 —— 用户既看不见也改不掉。
  // 目录拿不到时默认就是 null：没有清单就没有模型，交给 harness 用它自己的默认。
  const resolvedDefaultModel = resolveInitialModel(
    providerId,
    effectiveModelsCapability ?? undefined,
    lastStartedConfiguration
  );
  // 同上：来源是 harness 真目录；只有「不说 ACP」那一态才用插件静态表。
  const modelOptions = harnessCatalogToOptions(
    harnessCatalogState,
    staticModelsCapability?.modelOptions
  );
  // 从这里建终端起不来 ⇒ 不管偏好是哪头都锁在通用(❌ 等人点了终端才变灰);只在通用那条腿真能落时锁,
  // 锁显示的才等于这条会话真实的展示。
  const generalForcedHere = terminalUnstartable && sessionpageSurface === 'acp';
  const sessionView = sessionViewOfLeg(sessionpageSurface);
  // 展示控件的锁:三种「选不了」各有各的含义,控件显示的必须等于这条会话真实的展示(上面那个
  // `sessionView`),❌ 不是偏好。owner 2026-08-28 实测过反例:「这里写死了,没法切换,没法测」。
  const sessionViewLock: SessionViewLockState | null = !sessionViewOffered
    ? null
    : remoteGeneralOnly
      // 对话页建的 agent 本来就只有通用那条腿,沿用那句;会话页上这是「这台机器没用 SSH 连着」的事。
      ? { view: 'general', reason: creationSurface === 'chat-page' ? 'general-required-here' : 'remote-needs-ssh' }
      : generalOnlyAgent
      ? { view: 'general', reason: 'general-only' }
      : generalForcedHere
        ? { view: 'general', reason: 'general-required-here' }
        : !generalWired
          ? { view: 'code', reason: 'code-only' }
          : null;
  const platformCatalog = usePlatformModelCatalog(providerId, sessionpageSurface);
  // #4956 —— 凭据读数问的是**将要预选的那个自家模型**(`resolvedDefaultModel`:上次记录里
  // 恢复的,或 harness 自家现行默认),❌ 不是裸的 catalog.selected:上次记录可能指向另一个
  // provider 的模型(如带 OPENAI key 的用户选过 openai/…),只判 selected 会把一条明明有凭据
  // 的恢复路误改到平台。只对活目录 ready 的家问;其余家 modelId 为 null,hook 不发请求、恒 'unknown'。
  // ⚠️ 只取读数:登完之后的作废由抽屉那一行按 provider 前缀做(#6100),❌ 别在这里再留一把
  //    没人调的 refresh —— 上一版留着它,是因为登录终端曾经就在本文件里弹。
  const { status: harnessDefaultCredential } =
    useHarnessModelCredential(
      providerId,
      harnessCatalogState.kind === 'ready' ? resolvedDefaultModel : null
    );
  /**
   * 这家是不是**强制登录**（spec: harness-vendor-account）—— 两个信号缺一不可，各管一半：
   *  · `vendorAccount === 'required'` 是**关于这家的固定事实**（给足三方 key 也跑不起来），
   *    与用户此刻装了什么无关；
   *  · catalog 的 `auth-required` 是**这位用户此刻的状态**（真起了一次会话、被它拒了）。
   *
   * ❌ 只看后者会误伤：那个探针起进程时**不带**咕咕的注入（只有 buildAgentEnv 白名单 + 插件自己
   *    的 spawn env），于是像 copilot 这种「注入之后就能跑」的家，在平台额度会话里也会报
   *    auth-required —— 用户其实能用，弹窗却拦着他。
   * ❌ 只看前者会烦人：已经登好的用户每切一次都要被打断一次。
   */
  /**
   * 这条腿的登录由哪个程序、哪个方法承担(#6335)—— 两条腿是两个不共享登录的程序时,编程模式问的是
   * 终端那个程序的读数,通用模式问的是主程序的(目录探针)。判据本体在 `resolveLegLoginGate`。
   * 只有伴随程序那一路才订阅它的读数;主程序那一路不起这一探(`providerId` 传 null)。
   */
  const signInTarget = resolveSignInTarget(
    agents?.find((agent) => agent.id === providerId),
    sessionpageSurface
  );
  const { auth: legProgramAuth } = useAgentAuthStatus(
    signInTarget?.program !== undefined ? providerId : null,
    signInTarget?.program
  );
  const legLoginGate = resolveLegLoginGate({
    capabilities,
    catalogState: harnessCatalogState,
    target: signInTarget,
    programStatus: legProgramAuth?.status,
  });
  const needsVendorLogin = legLoginGate.prompt;
  /**
   * **将要预选的自家模型**这条路判得出没有可用凭据(product spec 默认预选规则):
   *  · `auth-required` —— harness 自己拒了会话(这位用户此刻没登录),自家模型清单本来就是空的;
   *  · `ready` 但将要预选的模型(恢复的或自家默认)其 provider 判为 `'uncredentialed'`
   *    (opencode 家族:auth.json / 引擎自缓存的 env 名单 / 全局配置三关都寻不到,
   *    #4956 的 Zen / Xiaomi 正是这形状)。
   * `'unknown'`(含读数在途、这家没实现判读)一律不算 —— 维持自家默认,与改动前一致。
   *
   * ⚠️ 「探针不带咕咕注入,copilot 类会误报 auth-required」那条警告(vendor-login-prompt.ts)
   *    对**这个**判据不构成假阳性:探针环境与 BYOK 会话环境同构(同一 buildAgentEnv 白名单 +
   *    插件 spawn env),探针被拒 ⇒ 这条自家默认路的会话同样会被拒。它误报的是**平台**会话的
   *    可用性 —— 而平台恰是兜底指向的那条路(copilot「注入之后就能跑」说的就是它)。
   *
   * ⚠️ `!needsVendorLogin` 挡的是另一句假话(见 byokLoginOptional 抬头):强制登录那一家
   *    没有厂商账号**什么都跑不起来**,咕咕的模型也一样 —— 把默认挪到平台模型不但救不了首句,
   *    还会经下面 `harnessNoticeMessage` 的「选了平台模型就闭嘴」把「需要先登录」那句顶掉。
   *    强制登录走弹窗那条路,❌ 不走凭据兜底。
   */
  const harnessDefaultUncredentialed =
    !needsVendorLogin &&
    (harnessCatalogState.kind === 'auth-required' ||
      harnessDefaultCredential === 'uncredentialed');
  // 聊天(ACP)与终端(pty)在这件事上没有分别:composer 是会话的唯一决策点,两种会话都
  // 照它跑。所以这里不看 sessionView —— 切展示既不撤走分组,也不动用户已经选好的模型。
  const platformModel = resolvePlatformModel(
    platformCatalog,
    providerId,
    providerId ? platformModelOverrides[providerId] : undefined,
    lastStartedConfiguration,
    harnessDefaultUncredentialed
  );
  const agentDisplayName =
    agents?.find((agent) => agent.id === providerId)?.name ?? providerId ?? 'agent';
  /**
   * 这家没登录,但**咕咕自己的模型现在就能用**。
   *
   * owner 2026-08-26 实测读数:切到 Qwen 之后工具栏常驻一句「Qwen Code 需要先登录
   * (Use OpenAI API key)」—— 而那时咕咕的模型其实已经可选了。那句话是**误导**:
   * 它把一条可选路径说成了前置条件,读上去像「不登录就用不了」。
   *
   * 真实关系是二选一:登录 Qwen Code ⇒ 能用它自家(BYOK)的模型;不登录 ⇒ 直接用咕咕的模型。
   * ⇒ 这时**不占工具栏那一格**,改成一次短时提示(下面的 toast),而且措辞只陈述选择,
   *   ❌ 不催人去登录。
   *
   * ⚠️ 判据是「咕咕有没有模型给这家」,❌ 不是「用户挑没挑」:挑之前 `platformModel` 恒为 null,
   *    照那个判就等于这句误导永远都在 —— 那正是实测到的现象。
   */
  const guguModelsAvailable = platformCatalog.models.length > 0;
  /**
   * ⚠️ `!needsVendorLogin` 这一项不是防御性写法,它挡的是一句**假话**:
   *    强制登录那一家(qoder)没有厂商账号**什么都跑不起来**,咕咕的模型也一样 ——
   *    那时还说「咕咕自己的模型现在就能用」是在骗人。
   *    有了它,两条路互斥:强制登录 ⇒ 弹窗给指引;登录可选 ⇒ 一句短时提示 + 一条去登录的路。
   */
  const byokLoginOptional =
    harnessCatalogState.kind === 'auth-required' && guguModelsAvailable && !needsVendorLogin;
  // 真机验收抓到的缺口：这个 composer 原先只显示「Model — Not selected」，一句解释都没有。
  // 没装 / 没登录 / 坏了是三件不同的事，用户得知道下一步该干什么。
  // 选了平台模型就闭嘴：那条会话根本不经过本机 harness，「尚未安装 X」在那时是句噪音。
  // ⚠️ `!providerId` 这一项挡的是一句**假话**:还没选 agent 时根本没有目录要读,
  //    `harnessCatalogState` 恒停在 `'unknown'`,这一格就会永远显示「正在读取可用模型…」——
  //    一个不会结束的进度。从前它被 providerError 顺带挡住了(那时「没选」是一条错误);
  //    #5740 把「没选」改成合法空态之后,这一项必须自己写出来。
  // 选的是别的机器、此刻没连上:为什么连不上由右下角那台机器的提示说(重连中 / 离线 / 要先登录 / 版本太旧,
  // 见 remote-hosts/machine-notice.ts),❌ 这里再报一句「读取 X 的模型失败」—— 那不是 X 的问题,是机器的。
  const machineUnreachable = Boolean(remoteHost && !remoteHost.online);
  const harnessNoticeMessage = !providerId || providerError || platformModel || byokLoginOptional || machineUnreachable
    ? null
    : harnessCatalogNotice(harnessCatalogState, agentDisplayName, translate);

  // 切到一家**强制登录**的 harness 时,给一次提示并留一条退路(spec: harness-vendor-account)。
  // 判据本体在上面 `needsVendorLogin`。
  const vendorLoginMethods = legLoginGate.methodNames;
  const showHarnessLoginRequired = useShowModal('harnessLoginRequiredModal');
  /**
   * 这家的**命令行登录**方式 —— 「把用户带到能登录的地方」的那个「地方」就靠它。
   *
   * 咕咕本来就有那个地方:`agentSignInModal` 起一个内嵌终端,跑厂商自己的 `<cli> login`
   * (`agent-config/runtime/auth.ts` 的 `startLogin`),并把它印出来的验证链接接成「打开浏览器」。
   * 缺的一直是**从这里过去的路**:composer 只把「需要先登录」说出口,再无下一步 ——
   * owner 2026-08-26 实测点的就是这一下。
   *
   * ⚠️ 查不到就传 null,弹窗那边据此退回「知道了」。❌ 不摆一个点了没反应的「去登录」。
   *    只有**显式声明**了登录方式的家才有这条(spec: harness-auth-surface):没声明的家
   *    (pi 等,payload 直通 `{kind:'none'}`)登录是用户自己终端里的事,这里恒为 null,
   *    于是解锁组、登录终端、弹窗的「去登录」对它们一概不出现。
   */
  const cliLoginMethod = signInTarget?.method ?? null;
  /**
   * 「去登录」= **跳资源库 → 智能体 → 这一家的抽屉**,那里有「账号」一行(#6100)。
   *
   * ❌ 不再在这里自己弹登录终端。三处入口(这里、会话末行、强制登录弹窗)各弹一个终端的时候,
   * 「装」和「登」分居两页,而设置页对登录零表达 —— 用户装完回设置页一切正常,到会话里才被
   * 「要登录才能接着聊」拦住(#4900 / #5705 / #5605 一族)。现在终端只有一个主人:抽屉那一行。
   *
   * ⚠️ 登完不必由这里重读:抽屉那一行刷的是**同一把** react-query key
   * (`['agents','modelCatalog',providerId]` / `['agents','modelCredential',providerId]`),
   * composer 手上这份因此当场跟着翻 —— 这正是 #6100 验收要的「三处同时翻成已登录」。
   *
   * 两半动作缺一不可,与「去装」那一下同形(见 `onAgentAction`):外壳管顶层 tab,
   * 会话页管自己的资源库路由。
   */
  const showAgentSignIn = useShowModal('agentSignInModal');
  const remoteAgentCommand = agents?.find((agent) => agent.id === providerId)?.command ?? null;
  const openAgentAccount = useCallback(() => {
    if (!providerId || !cliLoginMethod) return;
    /**
     * #6264 所选机器不是本机:在**那台机器上**登录,❌ 跳本机的资源库 —— 那一页画的是这台电脑的安装与登录
     * (/opt/homebrew/bin/codex、「已登录」),当成那台机器的就是张冠李戴。窗口还是那一个登录窗口,
     * 命令跑在那台机器上、链接在这台电脑的浏览器里开;登完 / 关窗都让那台机器的目录重问一遍。
     */
    const refreshAfterRemoteLogin = () =>
      void queryClient.invalidateQueries({ queryKey: [...HARNESS_MODEL_CATALOG_QUERY_KEY, providerId] });
    if (machine) {
      // 别的机器上只有不靠回跳的登录能在那台机器上跑(浏览器在这台电脑上);协议登录的家说「到那台机器上敲」。
      const cliLogin = cliLoginMethod.kind === 'cli-login' ? cliLoginMethod : null;
      showAgentSignIn({
        providerId,
        providerName: agentDisplayName,
        steps: [{ methodId: cliLoginMethod.id }],
        remote: {
          deviceId: machine,
          deviceLabel: machineDevice?.label ?? machine,
          headless: !!cliLogin?.headlessArgs,
          command: [remoteAgentCommand?.split(/[\\/]/).filter(Boolean).pop() || providerId, ...(cliLogin?.args ?? [])].join(' '),
        },
        // 登没登成只有那台机器知道:登完 / 关窗都让这一家的目录(那台机器那一份在同一前缀下)重问。
        onSuccess: refreshAfterRemoteLogin,
        onClose: refreshAfterRemoteLogin,
      });
      return;
    }
    (
      window as typeof window & {
        __GUGU_OPEN_SESSIONPAGE_AGENT_INSTALL__?: (agentId: string) => void;
      }
    ).__GUGU_OPEN_SESSIONPAGE_AGENT_INSTALL__?.(providerId);
    navigate('library', { tab: 'agents', agentId: providerId });
  }, [
    providerId,
    cliLoginMethod,
    navigate,
    machine,
    machineDevice,
    showAgentSignIn,
    agentDisplayName,
    remoteAgentCommand,
  ]);
  // 上一家 —— 取消时回到它。用 ref 而不是 state:它只在切换发生时被读,不该驱动重渲染。
  const previousProviderRef = useRef<AgentProviderId | null>(null);
  // 同一家只提示一次,别在 catalog 每次刷新时重弹。
  const promptedProviderRef = useRef<AgentProviderId | null>(null);
  useEffect(() => {
    if (!providerId) return;
    if (!needsVendorLogin) {
      // 这一家现在不需要提示了(登上了 / 换成了别家)——把它从「已提示」里放出来,
      // 否则用户登录后又退出登录,第二次就不会再被提醒。
      if (promptedProviderRef.current === providerId) promptedProviderRef.current = null;
      previousProviderRef.current = providerId;
      return;
    }
    if (promptedProviderRef.current === providerId) return;
    promptedProviderRef.current = providerId;
    const previous = previousProviderRef.current;
    const previousName = previous
      ? agents?.find((agent) => agent.id === previous)?.name ?? previous
      : null;
    showHarnessLoginRequired({
      harnessName: agentDisplayName,
      previousHarnessName: previous && previous !== providerId ? previousName : null,
      authMethods: vendorLoginMethods,
      signInMethod: cliLoginMethod
        ? {
            id: cliLoginMethod.id,
            ...(cliLoginMethod.description ? { description: cliLoginMethod.description } : {}),
          }
        : null,
      onSuccess: (result) => {
        // 「去登录」把人送到抽屉的「账号」那一行(#6100) —— ❌ 不在这里再弹一个登录终端。
        if (result.action === 'sign-in') {
          openAgentAccount();
          return;
        }
        if (result.action !== 'revert') return;
        if (!previous || previous === providerId) return;
        setProviderOverride(previous);
      },
    });
  }, [
    providerId,
    needsVendorLogin,
    agentDisplayName,
    agents,
    setProviderOverride,
    showHarnessLoginRequired,
    cliLoginMethod,
    openAgentAccount,
    // 数组每次渲染都是新对象，进依赖表会每渲染都重跑；join 成一个字符串比的才是内容。
    vendorLoginMethods.join('\u0000'),
  ]);
  const harnessNotice = harnessNoticeMessage
    ? translate(harnessNoticeMessage.key, harnessNoticeMessage.values)
    : null;
  /**
   * 「去登录」这条路。判据是**这一家现在没登录、而且它自己声明了命令行登录方式**,
   * ❌ 不是「行内那句说明恰好在喊登录」。
   *
   * ⚠️ **2026-08-28 修:旧判据让这条路几乎永不出现。**
   * 旧写法是 `harnessNoticeMessage?.action === 'login'`,可 `harnessNoticeMessage` 在
   * `byokLoginOptional` 那一支被**刻意闭掉**(咕咕自己的模型能用时不占工具栏)—— 而那
   * 恰恰是最常见的一支(kimi 就是)。于是登录入口跟着一起没了,用户在模型清单里
   * 一个字都看不到。owner 报的「登录解锁那枚标签基本不出现」就是这么来的。
   *
   * 四态里只有 `auth-required` 算「没登录」;「该去装」和「坏了可重试」各有各的去处,
   * ❌ 不共用这一条。
   */
  // 按这条腿的程序判(#6335,`resolveLegLoginGate`):主程序那一路仍是「目录 auth-required 且声明了登录」。
  const harnessSignIn = legLoginGate.signIn ? openAgentAccount : null;
  // 同一个判据算两次没有意义:能去登录才给入口,不能去就一个字都不画(控件要么真生效要么不渲染)。
  const harnessModelUnlock = harnessSignIn
    ? {
        // 这三格构成模型清单**里**的一组(组头 + 一条可点的动作),用户点开清单挑模型时才看见。
        // 组头与登录后那一档**是同一个** `ownModelsGroup`(「你的 Codex 模型」)—— 同一档换内容
        // 不换标题,用户才看得出「登录填的就是这一格」。它与「咕咕提供的模型 · 按积分计费」对仗。
        groupLabel: translate('harnessCatalog.ownModelsGroup', { name: agentDisplayName }),
        // #6264 登录过、但登录已失效(凭据还在、真用时被拒):说「重新登录」,❌ 说成从没登录过。
        ...(harnessCatalogState.kind === 'auth-required' && harnessCatalogState.expired
          ? {
              label: translate('harnessCatalog.signInAgain', { name: agentDisplayName }),
              title: translate('harnessCatalog.signInAgainHint', { name: agentDisplayName }),
            }
          : {
              label: translate('harnessCatalog.unlockModels', { name: agentDisplayName }),
              title: translate('harnessCatalog.unlockModelsHint', { name: agentDisplayName }),
            }),
      }
    : null;
  // 一行说明,不是弹窗也不是阻断:分组为什么不在,用户有权知道 —— 主进程给原因码,这里翻成人话。
  // ❌ 不再原样转达主进程的原话:mac1 实测它可以是 `net::ERR_PROXY_CONNECTION_FAILED`(#6473 后续)。
  //
  // owner 2026-08-21:平台分组**没给这个引擎**时原先直接返回 null —— 一句解释都没有。可模型本
  // 就分「本地配的」和「咕咕提供的」两类(product spec「模型来源与 UI」),两类都拿
  // 不出来却一声不吭,用户看到的只是「模型选择器不见了」,读上去像界面坏了。所以分组不在时一定有
  // 一句定性 ——「没给这个引擎」也是宿主报的一个原因码(`not-routable`)。
  // ❌ 别再在这里自己编一句「咕咕模型尚未对 X 开通」:原来「已安排」那一面关掉分组时就这么写,
  //    而那时咕咕的模型明明对 X 开着,是界面自己没去读。
  // 宿主报的是原因码,这里按界面语言说成人话;认不出的原文(老版本宿主)❌ 上屏。
  // 机器没连上时同理:咕咕模型的目录也是问那台机器要的,问不到是机器离线的结果,❌ 说成「模型列表尚未就绪」再给个「重试」。
  const platformCatalogNotice = machineUnreachable ? null : guguCatalogNotice(platformCatalog.catalogError, translate);
  const platformNotice = platformCatalogNotice?.text ?? null;
  // 失败细节 ❌ 不拼进上面那句内联文案:那是 composer 工具栏,而 reason 是长度不可控的外部串,拼进去会把
  // 工具栏撑破、溢出到卡片外(真机上就是这么炸的)。工具栏留一句定性(「读取 X 的模型失败」),原因就地
  // 显示在输入框下面一行(#6692)。从前它走 toast,可 <Toaster/> 只挂在会话页根上 —— 对话页「新建 Agent」
  // 用的是同一个 section,原因在那里无处可见;启动失败那条早就为同一个理由改成了就地显示。
  const harnessNoticeDetail = harnessNoticeMessage?.detail ?? null;

  /**
   * ⚠️ **这里原来有一条右下角 toast:「{name} 未登录」。2026-08-28 去掉了(owner 定)。**
   *
   * 去它的理由不是「话说得不好」,是**说错了时机**:用咕咕自己的模型**不需要**登录任何一家,
   * 所以用户刚进会话页、还没决定用什么跑的那一刻,这条提示与他要做的事无关 —— 是噪音。
   * 它还离模型选择器隔了大半屏,而且会自己消失;消失之后那条「去登录」的路就没了。
   *
   * 替代它的是**渐进披露**:登录入口挪进模型清单里(见 `harnessModelUnlock` 与
   * `ComposerModelUnlock`)。用户点开清单、正在挑模型时才看到它 —— 那一刻它才第一次相关,
   * 而且就在视线里、不会消失。
   *
   * ❌ 别把它加回来:`byokLoginOptional` 这个判据还留着,但它现在只用来**闭掉**那句
   * 「尚未安装/未登录」的行内说明(见上面 `harnessNoticeMessage`),不再驱动任何弹出物。
   */
  // 选了平台模型就没有 harness 模型可言:模型由网关签发的 token 钉死,这里再报一个只会打架。
  const model = platformModel
    ? null
    : modelOverride && modelOptions?.[modelOverride]
      ? modelOverride
      : resolvedDefaultModel;
  // 活目录 → 插件声明 → 静态表三级合成,与手机新建页共用同一个 resolveCreateEfforts(shared),
  // ❌ 别在这里再展开一遍那三步 —— 两处各写一份就会漂。
  const modelEfforts = resolveCreateEfforts({
    state: harnessCatalogState,
    effortCapability: capabilities?.effort,
    staticModelsCapability: staticModelsCapability,
    model,
    platformModel: platformEffortFacts(platformModel, platformCatalog.models),
    leg: sessionpageSurface,
  });
  // 平台模型没有 harness model id,但它同样要记住用户选过的档 —— 用平台模型 id 当 key。
  // ❌ 不能省成只按 provider 记:同一引擎下换平台模型,档位不一定还在(见 resolveInitialEffort)。
  const effortKey = providerId
    ? platformModel
      ? `${providerId}:platform:${platformModel}`
      : model
        ? `${providerId}:${model}`
        : null
    : null;
  const effort = resolveInitialEffort(
    modelEfforts,
    effortKey
      ? (effortOverrides[effortKey] !== undefined ? effortOverrides[effortKey] :
        // 上次启动的档位只在**同一个模型**上继承。平台模型时 harness `model` 两边都空,只比它
        // 会让所有付费模型共用一格(换个平台模型就继承了另一个的档),所以另比平台模型 id。
        // `?? null` 不能省:记录里缺省是 `undefined`,而这里的 model/platformModel 是 `null`,
        // 不归一的话 `undefined === null` 恒 false —— 平台模型那一支永远不命中,上次选的档记不住。
        (lastStartedConfiguration?.provider === providerId &&
        (lastStartedConfiguration.model ?? null) === model &&
        (lastStartedConfiguration.platformModel ?? null) === platformModel
          ? lastStartedConfiguration.effort
          : undefined))
      : undefined
  );
  const autoApproveSupported = agentSupportsAutoApprove(capabilities);
  const grokStructuralFullAccess = providerId === 'grok';
  // @@@5597-draft-decides — **草稿上显示的档 = 落库的档 = 进程里生效的档**,三者同一个事实。
  //
  // 聊天页创建出来的是**聊天成员**:没有人守在会话页答权限弹窗,所以这一面的**默认**是完全访问
  // (`UNATTENDED_SESSION_PERMISSION_MODE`,与 agent 自己派活的那两条路同一个常量)。
  // ⚠️ 但那**只是默认**。此前这个决定是在 `buildInitialSession` 里**无条件覆盖**掉
  // `state.permissionMode` 的(#5597):草稿上选了只读,库里写的却是 full-access,于是三家一律
  // 开成最松那档、而且不报错 —— 用户以为自己限制了 agent,实际没有。安全边界上的静默失效。
  // 出处不是判断题:`new-session-page.tsx` 递 `showAutoApproveToggle` 那句注释逐字写着
  // 「The surface only changes where the created session lands; it must **not hide the user's
  //  pre-dispatch permission choice**」—— 覆盖式实现与它自己的声明矛盾。
  // ⇒ 默认值分面给,**选中值一律照选中的走**。
  const unattendedCreation = creationSurface === 'chat-page';
  // 没人守着的两面 —— 对话页创建、「已安排」到点自己开 —— 默认都是无人值守那一档。
  // ⚠️ 只管**默认值**:下面 `autoApprove` 那条对话页专属的兜底(这家没声明自动批准也照无人值守走)
  //    不跟着扩到定时任务 —— 那一面的主进程校验要求这家**真**支持无人值守,界面得如实说它不行。
  const unattendedDefault = unattendedCreation || unattended;
  // @@@5597-loosest-default-already-holds — 「**两面的默认都是最松那档**」这件事**已经成立**,
  // 不必也不该在这一行再写一次:
  //   · 聊天页 = `UNATTENDED_SESSION_PERMISSION_MODE`(= `full-access`);
  //   · 会话页 = `permissionModeFromAutoApprove(autoApproveByDefault)`,而那颗设置的**出厂值**
  //     `DEFAULT_SESSION_AUTO_APPROVE` 本来就是 `true` ⇒ 同样落在 `full-access`
  //     (见 `@@@factory-default-autonomy`,owner 2026-08-27 定)。
  // ⚠️ 2026-09-14 有人(我)把这一行硬编码成 `UNATTENDED_SESSION_PERMISSION_MODE`,以为那样才算
  //   "实现" owner 那句「默认都改成最松吧」。**错在两处**:
  //   ① 出厂默认本来就是最松 ⇒ 那一刀对全新 profile **改不出任何新行为**;
  //   ② 它顺手越过了**用户自己关掉的那颗开关** —— 设置页那行「默认自动批准」从此点了没用,
  //      而且在 `@@@factory-default-autonomy` 明令「只能有一处字面量」的地方开了第二处。
  //   ⇒ 要动「出厂默认」就改 `DEFAULT_SESSION_AUTO_APPROVE` 那**一处**,❌ 不要在这里绕过设置。
  const defaultPermissionMode: GuguPermissionMode = unattendedDefault
    ? UNATTENDED_SESSION_PERMISSION_MODE
    : permissionModeFromAutoApprove(autoApproveByDefault);
  // ⚠️ 聊天页**不**继承「上次启动记住的档」:那份记录是会话页那一面的偏好(应用设置 newSessionMemory),
  //    让它决定一个无人值守面的默认值,等于用一次无关的选择改掉这一面的产品默认。
  //    这一面的默认是产品决定,不是偏好;而用户在这张草稿上显式选的档照旧优先于它。
  const rememberedPermissionMode =
    !unattendedDefault &&
    lastStartedConfiguration !== null &&
    lastStartedConfiguration.provider === providerId &&
    lastStartedConfiguration.permissionMode !== undefined
      ? lastStartedConfiguration.permissionMode
      : defaultPermissionMode;
  // 不支持自动批准的 agent 不显示这个选择框(permissionModeOptions 为 null)。底排上没有那颗控件
  // ⇒ 不存在「用户选中的档」这回事 ⇒ 两面各自保持既有取值:聊天页仍按无人值守走,会话页跟
  // 出厂默认(`defaultPermissionMode`,即「默认自动批准」那颗设置)走。
  // ⚠️ ❌ 不许在这里退回硬编码档:#5608 曾把这一支写成恒 'edit',于是 pi 这类「无阶梯但
  //    acp 腿有自治物化」的家默认落 approval-required,每个工具都弹一次 yes 卡
  //    (owner 2026-09-19:「正常 pi 应该是默认是 full access」),而设置开关对它完全失效。
  //    ladder-less 家的「中位档」没有用户可见的入口,硬编码等于替用户做了看不见的选择;
  //    出厂默认才是这一支唯一既有的、用户可改的默认来源。
  const wantedPermissionMode: GuguPermissionMode = grokStructuralFullAccess
    ? 'full-access'
    : autoApproveSupported
    ? (permissionModeOverride ?? rememberedPermissionMode)
    : unattendedCreation
      ? UNATTENDED_SESSION_PERMISSION_MODE
      : defaultPermissionMode;
  // 换到一个没有这一档的 agent 时,记住的档落到这家**实际能兑现**的档 —— 否则界面上没有这一档可选,
  // 载荷里却带着它,又成了「显示的和实际跑的不是一回事」。
  // · 档位表**完整**的家(`modesExhaustive`):与终端腿 argv(注册表)同一条规则
  //   (`resolveDeclaredPermissionMode`,不比所选更松、离它最近;#6221)。一档都落不到时,这里挑的只是
  //   **看得见的初始选中项**,取这家最严的一档 —— 用户看得见、可改;真要以它启动也经同一条规则,不会更松。
  // · 其余家保持现状:没有这一档就落回 edit(#6231 逐家实测后再收)。
  const exhaustiveModes = capabilities?.autoApprove.modesExhaustive
    ? capabilities.autoApprove.modes
    : undefined;
  const permissionMode: GuguPermissionMode = grokStructuralFullAccess
    ? wantedPermissionMode
    : exhaustiveModes
      ? (resolveDeclaredPermissionMode(wantedPermissionMode, exhaustiveModes)
        ?? strictestDeclaredPermissionMode(exhaustiveModes)
        ?? wantedPermissionMode)
      : wantedPermissionMode !== 'edit' &&
          wantedPermissionMode !== 'full-access' &&
          !agentSupportsPermissionMode(capabilities, wantedPermissionMode, sessionpageSurface)
        ? 'edit'
        : wantedPermissionMode;
  // 由档位派生,❌ 不另存一份可能与档位矛盾的真值。聊天页那一面即使这家没声明 autoApprove capability
  // 也要照无人值守走 —— 那一格没有控件可显示。
  const autoApprove =
    (autoApproveSupported || unattendedCreation) && autoApproveFromPermissionMode(permissionMode);

  // 附件编码 = 正文 transport 的函数。两者同一个表达式,故不可能指向不同的路。
  // ⚠️ 入参必须与 use-create-session-callback 那一次调用**逐字相同**(含 prompt):#5049 之前这里少传了
  // prompt,对话页 + 通用视角在这里算成 router、在提交那侧算成 startup —— 同一个决定两处产地、答案不同,
  // chip 照常排队而提交被 tripwire 挡住。
  const attachmentChannel = attachmentChannelOf(
    firstTurnTransportOf({
      creationSurface,
      sessionpage: capabilities?.sessionpage ?? null,
      sessionView,
      prompt: capabilities?.prompt ?? null,
    }),
    creationSurface,
  );
  // 待发队列是 **chat-attachment 这一条通道自己的**存储。这一轮的 transport 一变(换 provider、
  // 切回编程视角),ChatComposer 就不再拿到 attachments —— chip 从界面上消失,可队列还在。
  // 那是一个**看不见的队列**:它照样让 hasTurnContent 恒真、照样拿那个看不见的文件名去命名会话,
  // 用户对着一个空 composer 被告知「这个 provider 没有 transport」,而界面上没有任何控件能清掉它。
  // 所以通道一离开就把它收掉 —— 此刻这些文件没有任何路径能送出去,留着只会伪装成"这一轮有内容"。
  useEffect(() => {
    clearAttachmentsOfChannel(
      attachmentChannel === 'chat-attachment' ? 'path-mention' : 'chat-attachment'
    );
  }, [attachmentChannel, clearAttachmentsOfChannel]);

  return {
    provider: providerId,
    setProvider: (next) => {
      setProviderOverride(next);
      // 点一下就记住 —— ❌ 不等到「发送成功」:用户点完换个页面是常态,而那时还没有会话可记。
      if (next && !editingStoredRecord) updateMemory({ lastPicked: next });
    },
    projectId,
    prompt,
    setPrompt,
    mentionContext,
    setMentionContext,
    issueContext,
    setIssueContext,
    permissionMode,
    setPermissionMode: setPermissionModeOverride,
    autoApprove,
    issueContextEditorOpen,
    setIssueContextEditorOpen,
    model,
    setModel: (nextModel) => {
      if (!providerId) return;
      // 选 harness 模型同时就是「这条会话不上平台」的表态,agent 级默认值不再回来顶掉它。
      setPlatformModelOverrides((current) => ({ ...current, [providerId]: null }));
      setModelOverrides((current) => {
        if (!nextModel) {
          const next = { ...current };
          delete next[providerId];
          return next;
        }
        return { ...current, [providerId]: nextModel };
      });
    },
    platformModels: platformCatalog.models,
    platformModel,
    platformNotice,
    // 只有过一会儿可能自己好的原因值得重试;其余原因是配置事实,重试也不会变。
    retryPlatformCatalog: platformCatalogNotice?.retryable ? platformCatalog.retry : undefined,
    providerError,
    sessionpage: capabilities?.sessionpage ?? null,
    promptCapability: capabilities?.prompt ?? null,
    harnessNotice,
    harnessNoticeDetail,
    harnessSignIn,
    harnessModelUnlock,
    setPlatformModel: (nextModel) => {
      if (!providerId) return;
      setPlatformModelOverrides((current) => ({ ...current, [providerId]: nextModel }));
    },
    // 档名走词表 —— 插件那份是硬编码中文,原样摆出来英文壳里就漏中文(见 effort-options.ts)。
    effortOptions: localizeEffortOptions(modelEfforts?.options ?? null, translate),
    effort,
    defaultEffort: modelEfforts?.defaultId ?? null,
    setEffort: (nextEffort) => {
      if (!effortKey) return;
      // null is an explicit reset; absence alone may inherit a remembered choice.
      setEffortOverrides((current) => ({ ...current, [effortKey]: nextEffort || null }));
    },
    rememberStartedConfiguration: async () => {
      if (!providerId) return;
      // 真启动过的那一家同样算「用户选的」(除非它是出厂偏好猜出来的),同步进上面那一格,
      // 两份记忆就不会一新一旧地分叉。
      await updateMemoryAsync({
        lastPicked: providerChosenByUser && !editingStoredRecord ? providerId : memory?.lastPicked ?? null,
        lastStarted: {
          provider: providerId,
          ...(model && { model }),
          ...(effort && { effort }),
          ...(platformModel && { platformModel }),
          providerChosenByUser,
          permissionMode,
        },
      });
    },
    sessionView,
    setSessionView: setSessionViewOverride,
    sessionViewOffered: sessionViewOffered && terminalEnabled,
    sessionViewLock,
    providerSelectionSurface: sessionpageSurface,
    machine,
    attachmentChannel,
    attachments,
    attachmentEditSeq,
    enqueueAttachments,
    enqueuePathAttachments,
    enqueueFolderAttachments,
    waitForPathAttachments: fileUploads.waitForUploads,
    pathAttachmentsUnsettled: fileUploads.unsettled,
    retryPathAttachment: fileUploads.retry,
    reserveSessionId,
    pathAttachmentEntries,
    pathAttachmentMentions,
    setAttachments,
    pendingAttachmentFiles,
    dropAttachment,
    captureAttachmentDraft,
    issueMentionContexts,
    setIssueMentionContext: (token, context) =>
      setIssueMentionContexts((current) => {
        if (context === null) {
          const next = { ...current };
          delete next[token];
          return next;
        }
        return { ...current, [token]: context };
      }),
  };
}

function useAgentCapabilities(providerId: AgentProviderId | null): AgentCapabilities | null {
  const { data: agents } = useAgents();
  if (!providerId) return null;
  return agents?.find((agent) => agent.id === providerId)?.capabilities ?? null;
}

const SLASH_PROMPTS_SECTION = 'Prompts';

function promptPreview(text: string): string {
  return text.split(/\r?\n/, 1)[0] ?? '';
}

function toLinkedIssueMentionItem(issue: LinkedIssue): MentionItem {
  const token = issueMentionToken(issue.provider, issue.identifier);
  return {
    id: token,
    label: token,
    name: issue.displayIdentifier ?? issue.identifier,
    kind: 'issue',
    description: issue.title,
    icon: <IntegrationIcon provider={issue.provider} size={13} />,
  };
}

function promptHasIssueMention(text: string, token: string): boolean {
  return extractIssueMentionTargets(text).some((target) => target.token === token);
}

/** 框此刻是哪件事、标签长什么样(见 ComposerVerbTag);标签上画所选 agent 的标,所以给成 agent 的函数。 */
export interface ComposerVerbLook {
  tone: 'task';
  tag: (agentId: string | undefined) => ReactNode;
}

interface InitialSessionFieldProps {
  state: InitialSessionState;
  linkedIssue?: LinkedIssue;
  includeIssueContextByDefault: boolean;
  enableMentions?: boolean;
  onPromptBlur?: () => void;
  /** 给成函数 = 随所选 agent 变(「想让 Claude 做点什么？」)。 */
  placeholder?: string | ((agentName: string) => string);
  /** 这一框是一件事(新任务 / 定时任务,gugu-dev#181):框换那件事的色,标签排在输入行最前面。 */
  verb?: ComposerVerbLook;
  textareaClassName?: string;
  showAutoApproveToggle?: boolean;
  /**
   * 这一面收不收附件。「已安排」不收:它存的只是一句话,附件没有地方落 —— 摆着「+」、拖进来照收,
   * 一保存就悄悄没了,是个假控件。false = 不画「+」、拖放与粘贴文件都不接(长文本粘贴照旧是文字)。
   */
  enableAttachments?: boolean;
  /** When provided, renders the send button inline in the composer toolbar. */
  onSubmit?: () => void;
  /** Whether the inline send button is enabled. Ignored when onSubmit is absent. */
  canSubmit?: boolean;
}

export function InitialSessionField({
  state,
  linkedIssue,
  includeIssueContextByDefault,
  enableMentions = true,
  onPromptBlur,
  placeholder,
  verb,
  textareaClassName,
  showAutoApproveToggle = true,
  enableAttachments = true,
  onSubmit,
  canSubmit = false,
}: InitialSessionFieldProps) {
  const { translate } = useSessionMessages();
  const { navigate } = useNavigate();
  const editorApiRef = useRef<PromptEditorRef | null>(null);
  const syncingEditorTextRef = useRef(false);
  const localMentionItemsRef = useRef<MentionItem[]>([]);
  const { value: promptLibrary } = usePromptLibrary();
  const harnessModelOptions = useHarnessModelOptions(state.provider, sessionpageLegOfView(state.sessionView));
  const { data: agents, isLoading: agentsLoading } = useAgents();
  // #6264 名单要跨云问另一台机器时,那一格画「正在读取」,❌ 空着让人以为那台机器上什么都开不了。
  // 只在真在读时画(isLoading):那台机器没连上就不问,❌ 一直转到它回来(原因由机器的提示说)。
  const remoteCreateForActions = useLibraryHost().remote !== null;
  const agentOptionsLoading = remoteCreateForActions && agentsLoading;
  const { tools: agentCreationTools, renderMentionIcon: renderAgentMentionIcon } = useSessionAgentCreationTools();
  const agentCreationToolsByEngine = useMemo(
    () => new Map<string, (typeof agentCreationTools)[number]>(agentCreationTools.map((tool) => [tool.engine, tool])),
    [agentCreationTools],
  );
  const selectedAgentName =
    agents?.find((agent) => agent.id === state.provider)?.name ?? state.provider ?? 'agent';
  // owner:平台额度这件事在 UI 上的核心标志,就是 composer 的模型下拉里多出咕咕提供的模型。
  // 它们与用户自己那档并列在同一个下拉里(不是另开一个选择器),每条自带积分标注。
  //
  // 分类两级(owner 2026-09-05,照 assistant-ui 那版):**一级是厂商**(组头 / 过滤药丸 /
  // 行内 logo 都按它),**二级**才是「你的 {厂商} 模型」/「咕咕提供的模型 · 按积分计费」,
  // 挂在组头厂商名后面。二级那句由这里翻好再递进去 —— `platform-model-options` 自己不碰 i18n
  // (它同时被黑盒 e2e 引用);图标同理由这里给成品节点,那个模块也够不到 React。
  // 装配在 `useComposerModelOptions` 里(@@@composer-model-assembly),两个入口共用一份。
  const modelOptions = useComposerModelOptions(
    harnessModelOptions,
    state.platformModels,
    state.provider
  );
  const installingAgents = useInstallingAgents();
  // spec 项目首页 (owner): provider selector lives in the composer toolbar (下方小按钮), next to
  // Model / 询问 — not as a big full-width row above the input.
  // @@@task-fusion (#2802) — 每个 agent 自带安装读数,从前这里把它扔了:于是列表
  // 扁平一列、全部可选,点中没装的 agent 只会在会话启动时炸(owner 实遇)。口径见
  // `agent-availability-groups`,两个 composer 入口共用一份,免得同一个选择器两处表现不同。
  // #6101:读的是四态 `reading`(去装 / 去修 / 重新选一份是三件不同的事),❌ 不再看 `status`。
  const agentOptions = useMemo<ComposerAgentOption[]>(
    () =>
      sortAgentsByAvailability(
        (agents ?? []).flatMap((a) => {
          // 会话形态按引擎定（见 `sessionpageLegFor` 抬头）：开关只在**两条腿都能跑**时择一，
          // 只有一条腿的引擎跟着自己那条走 —— ❌ 不因为开关拨在另一边就从选择器里消失。
          const leg = sessionpageLegFor(a.capabilities.sessionpage, state.providerSelectionSurface ?? 'tui');
          // 读数问**要起的那条腿**的程序(#6335):Antigravity 只装了聊天面板那个程序时,
          // 通用视角照样能选,编程视角提示去装 `agy`。
          return leg === null ? [] : [{ ...a, reading: agentReadingForLeg(a, leg) }];
        })
      )
        .map((a) => ({
          id: a.id,
          name: a.name,
          icon: <AgentIcon id={a.id} size={14} className="rounded-sm" />,
          // 没装的 agent 不是 disabled —— 它有动作:点它去装。
          // 别的机器(#6264):分组照那台机器的读数(useAgents 已换成它报的),与本机同一套四态。
          // 那里没装的照样可选 —— 建会话时那台机器当场装(behavior gugu-server 第 6 条);
          // ❌ 给本机的「去装」:那只会装到这台电脑上。装了起不来的(坏了)不让选。
          disabled: remoteCreateForActions && a.reading === 'detected-but-broken',
          groupLabel: agentGroupLabel(a.reading, translate),
          action: isAgentSelectable(a.reading) || remoteCreateForActions
            ? undefined
            : agentRowAction(installingAgents.has(a.id), translate),
        })),
    [agents, installingAgents, state.providerSelectionSurface, remoteCreateForActions]
  );
  const defaultIssueContext = useMemo(
    () => (linkedIssue ? buildIssueContextText(linkedIssue) : null),
    [linkedIssue]
  );

  // Auto-inject issue context whenever the linked issue changes.
  useEffect(() => {
    state.setIssueContext(includeIssueContextByDefault ? defaultIssueContext : null);
  }, [defaultIssueContext, includeIssueContextByDefault]);

  const resolvedCapabilities = useAgentCapabilities(state.provider);
  // An unavailable provider stays in state so the error can name it, but its payload may contain
  // incomplete capability fields (for example autoApprove: null). Capability-driven controls must
  // treat that state as absent instead of dereferencing a partial payload before the error renders.
  const capabilities = state.providerError ? null : resolvedCapabilities;
  const canToggleAutoApprove = agentSupportsAutoApprove(capabilities);
  const leg = sessionpageLegOfView(state.sessionView);
  const readOnlyModeSupported = agentSupportsReadOnlyMode(capabilities, leg);
  const planModeSupported = agentSupportsPlanMode(capabilities, leg);
  const editModeOffered = agentOffersEditMode(capabilities, leg);

  // #4325 —— 这条消息以什么身份发出去,同时决定它的附件怎么编码。
  const chatAttachmentChannel = state.attachmentChannel === 'chat-attachment';
  const { isDragOver, dropHandlers } = usePromptFileDrop({
    // OS 文件拖拽**一律**交给 ChatComposer 自己的 drop(→ onFilesDropped → 附件 chip),
    // 这一层只留「从任务的文件树里拖一行进来」那条(它走 workspace-file 通道,不受这个开关影响)。
    // ⚠️ 从前这里只在 chat-attachment 轮关掉,于是 path-mention 轮上一次拖拽被**两边都收**:
    // composer 收成 chip,这一层同时把绝对路径写进正文 —— 屏幕上一个附件、正文里一段路径。
    // composer 的 handleDrop 只 preventDefault、不 stopPropagation,所以事件照样冒泡到这里。
    // (SSH 项目本来就不该收本地路径:远端不存在这个文件。那条理由现在被上面这条覆盖。)
    disableLocalFiles: true,
    workspaceId: state.projectId,
    onDropText: (text) =>
      state.setPrompt((current) => appendInitialSessionText(current, text)),
  });

  useEffect(() => {
    const editor = editorApiRef.current;
    if (!editor || editor.getText() === state.prompt) return;
    syncingEditorTextRef.current = true;
    try {
      editor.setText(state.prompt);
    } finally {
      syncingEditorTextRef.current = false;
    }
  }, [state.prompt]);

  const linkedIssueMention = useMemo(
    () => (linkedIssue ? toLinkedIssueMentionItem(linkedIssue) : null),
    [linkedIssue]
  );

  useEffect(() => {
    const editor = editorApiRef.current;
    if (!editor || !linkedIssueMention) return;

    if (!state.issueContext) {
      editor.removeMention(linkedIssueMention.id);
      return;
    }

    if (!promptHasIssueMention(editor.getText(), linkedIssueMention.id)) {
      editor.prependMention(linkedIssueMention);
    }
  }, [linkedIssueMention, state.issueContext, state.prompt]);

  const renderMentionIcon = useCallback<RenderMentionIcon>((attrs) => {
    const { id, kind } = attrs;
    if (kind === 'custom') return renderAgentMentionIcon(attrs);
    if (kind !== 'issue') return null;
    const target = parseIssueMentionToken(id);
    if (!target) return null;
    return <IntegrationIcon provider={target.provider} size={12} />;
  }, [renderAgentMentionIcon]);

  // Automation prompts use this field as a plain text input. Keep their existing contract while
  // the normal New task composer shares the session mention provider with in-session ACP chat.
  const localSessionMentionProvider = useMemo(
    () =>
      enableMentions
        ? createLocalSessionMentionProvider({
            creationToolsByEngine: agentCreationToolsByEngine,
          })
        : null,
    [agentCreationToolsByEngine, enableMentions]
  );

  // 侧栏会话行拖进来 = 与 @ 弹层同一枚 pill(behavior session-page「把会话拖成 @」)。这里还要**先记账**:
  // 隐藏上下文按 token 回查这枚条目才拿得到 `session_message` 的地址,而拖拽这条路一次 @ 弹层都没开过。
  const { dataDropTypes, onDataDropped } = useSessionMentionDrop({
    provider: localSessionMentionProvider,
    editorApiRef,
    onMentionResolved: useCallback((item: MentionItem) => {
      const known = new Map(localMentionItemsRef.current.map((entry) => [entry.label, entry]));
      known.set(item.label, item);
      localMentionItemsRef.current = [...known.values()];
    }, []),
  });

  const mentionProvider = useMemo<ContextMentionProvider | undefined>(() => {
    const localProvider = localSessionMentionProvider;
    if (!localProvider) return undefined;
    return {
      // Only local sessions. The linked issue's pill is owned by the effect above, which
      // prepends and removes it as `state.issueContext` attaches and detaches; offering it here
      // too would let the popup insert a duplicate at the caret, or insert one that the effect
      // then deletes because the context is not attached.
      async search(query: string): Promise<MentionItem[]> {
        const localItems = await localProvider.search(query);
        // The popup query narrows, so a peer the user already inserted may be absent from the
        // next result. Remember what we have seen for this composer, so the hidden-context
        // builder can still resolve every token in the text.
        const knownItems = new Map(localMentionItemsRef.current.map((item) => [item.label, item]));
        for (const item of localItems) {
          if (item.role === 'agent') knownItems.set(item.label, item);
        }
        localMentionItemsRef.current = [...knownItems.values()];
        return localItems;
      },
    };
  }, [localSessionMentionProvider]);

  const querySlashItems = useCallback(
    async (query: string): Promise<CommandItem[]> => {
      const normalized = query.trim().toLowerCase();
      return promptLibrary
        .filter((prompt) => {
          if (!normalized) return true;
          return [prompt.title, prompt.prompt].some((value) =>
            value.toLowerCase().includes(normalized)
          );
        })
        .map((prompt) => ({
          id: `prompt:${prompt.id}`,
          name: prompt.title,
          label: prompt.title,
          description: promptPreview(prompt.prompt),
          behavior: 'insert-text' as const,
          insertText: prompt.prompt,
          section: SLASH_PROMPTS_SECTION,
        }));
    },
    [promptLibrary]
  );

  // @@@permission-independent-of-chat-ui — 权限选择与 Chat UI 开关是两件事,不该互相牵制。
  // ACP start input carries the same permissionMode intent as TUI. The session runtime translates it
  // to a provider mode before the initial prompt, so visibility does not depend on the Chat UI toggle.
  // @@@permission-three-modes — 与会话 composer 共用同一组档位和文案。这里的 key 就是
  // GuguPermissionMode 本身,❌ 别再用 'ask'/'bypass' 这种只表达二值的别名。
  const permissionModeOptions =
    showAutoApproveToggle && canToggleAutoApprove
      ? {
          ...(state.provider === 'grok'
            ? {
                'full-access': {
                  name: translate('taskConfig.grokPermissionFullAccess'),
                  description: translate('taskConfig.grokPermissionWarning'),
                  destructive: true,
                },
              }
            : {
              // ⚠️ 规划档、只读档都只对**真有那一档**的 agent 出现(capability 里核实过的那些)。
              // 其余 harness 的 argv 上只有一个 auto-approve 开关,给它们摆这些档 =
              // 用户以为锁住了 agent、实际照跑不误。少一档好过多一个骗人的档。
              // 顺序按约束从严到松:规划 → 只读 → 编辑 → 完全访问。
              ...(planModeSupported
                ? {
                    plan: {
                      name: translate('taskConfig.permissionPlan'),
                      description: translate('taskConfig.permissionPlanHint'),
                    },
                  }
                : {}),
              ...(readOnlyModeSupported
                ? {
                    'read-only': {
                      name: translate('taskConfig.permissionReadOnly'),
                      description: translate('taskConfig.permissionReadOnlyHint', { agent: selectedAgentName }),
                    },
                  }
                : {}),
              ...(editModeOffered
                ? {
                    edit: {
                      name: translate('taskConfig.permissionEdit'),
                      description: translate('taskConfig.permissionEditHint'),
                    },
                  }
                : {}),
              'full-access': {
                name: translate('taskConfig.permissionFullAccess'),
                description: translate('taskConfig.permissionFullAccessHint'),
                destructive: true,
              },
            }),
        }
      : null;

  const handleComposerInputChange = useCallback(
    (text: string) => {
      state.setPrompt(text);
      state.setMentionContext(localSessionMentionHiddenContext(text, localMentionItemsRef.current));
      if (syncingEditorTextRef.current || !linkedIssueMention || !state.issueContext) return;

      if (!promptHasIssueMention(text, linkedIssueMention.id)) {
        state.setIssueContext(null);
      }
    },
    [linkedIssueMention, state]
  );

  // 附件有两条编码,选哪条由**这条消息走哪个 transport**决定(#4325,见 attachmentChannel):
  // - 会话内输入(会话页创建):插绝对路径 @提及 —— 与这条会话后续每一轮的编码方式相同,
  //   agent 自己去读,且对 CLI agent 而言路径比内联图更有用。
  // - IM 私聊消息(对话页创建):收进待发队列,由发送端上传 chat-media 并写 attachment 消息 ——
  //   与用户稍后在同一 DM 里再发一个文件完全同路。❌ 不把本机路径塞进正文冒充"发过去了":
  //   那条路 chat-media 零上传、会话里没有附件气泡、跨设备时目标机上根本没有那个路径。
  const attachInputRef = useRef<HTMLInputElement | null>(null);
  const handleAttach = useCallback(() => {
    attachInputRef.current?.click();
  }, []);
  // 掉进 composer 的文件,两条通道都变成**附件 chip**(#5269,owner 2026-09-08:「你应该把他
  // 当作附件处理」)。差别只在它怎么到达 agent:chat 通道是 attachment 行,path 通道是发送时
  // 拼进正文的绝对路径 mention。❌ 不再往正文里插一条路径 pill —— 那是把传输方式摆到用户脸上。
  const remoteMachine = state.machine;
  const handleFiles = useCallback((files: File[]) => {
    if (files.length === 0) return;
    if (chatAttachmentChannel) {
      // 与下面那条同一个理由:❌ 不裸 `void promise`,抛出会变成没人看见的静默丢。
      state.enqueueAttachments(files).catch((error: unknown) => {
        log.error('Failed to queue chat attachments', { error });
      });
      return;
    }
    // ❌ 不写成裸 `void promise`:这条链里任何一步抛出都会变成一次没人看见的 unhandled rejection,
    // 屏幕上只表现为「文件掉进去了什么都没发生」。#5269 实撞:`formatAttachmentSize` 在一份把整个
    // session-ui 入口 mock 掉的测试里是 undefined,调用即抛,整批文件静默消失。
    state.enqueuePathAttachments(files).catch((error: unknown) => {
      log.error('Failed to attach dropped files', { error });
    });
  }, [chatAttachmentChannel, state]);
  const handleAttachPicked = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    handleFiles(Array.from(e.target.files ?? []));
    // 允许连续挑同一个文件:不清空的话第二次 change 不触发。
    e.target.value = '';
  }, [handleFiles]);
  /**
   * 拖进来的是**文件夹**:不进附件通道(它没有可上传的字节,进去只能静默消失),
   * 落成正文里一条路径引用 —— 与终端/文本框拖文件夹写路径同一个意图,只是这里有 pill 可用。
   * 聊天附件通道(IM)两头都到不了:正文不放本机路径,附件收不下文件夹 ⇒ 响亮报错,❌ 静默丢。
   */
  const handleDirectoriesDropped = useCallback(
    (files: File[], entries: FileSystemDirectoryEntry[]) => {
      if (files.length === 0) return;
      if (chatAttachmentChannel) {
        toast({
          title: translate('chat.folderDropUnsupportedTitle'),
          description: translate('chat.folderDropUnsupportedDescription'),
          variant: 'destructive',
        });
        return;
      }
      // #6264 别的机器上的会话:本机文件夹的路径那边没有 —— 整个文件夹传过去,正文里给那台机器上的路径。
      if (remoteMachine) {
        state.enqueueFolderAttachments(entries).catch((error: unknown) => {
          log.error('Failed to attach dropped folders', { error });
        });
        return;
      }
      for (const file of files) {
        const mention = droppedDirectoryMention(file);
        if (mention) editorApiRef.current?.insertMention(mention);
      }
    },
    [chatAttachmentChannel, remoteMachine, state, translate]
  );

  // 平台分组缺席的原因,贴在模型选择器同一排。ChatComposer 的模型列表是平铺的
  // `DropdownMenu.RadioItem`,`ComposerModelOption` 没有 disabled/说明行的位置(组件在
  // packages/session-ui),所以这句话只能落在工具栏里 —— 不可点、无边框、跟 Chat UI 标签同一档
  // 字号与色阶,不额外造视觉层级。
  // ⚠️ 这两条的长度不由这里决定（平台那句按主进程的原因码取、harness 那句是失败定性 + 插值名字）——
  // 所以必须自己封顶：`min-w-0` 让 flex 子项允许被压缩（默认 `min-width:auto` 不缩），
  // `max-w-*` + `truncate` 保证再长也只占一行、多出来的用省略号收掉。
  // ❌ 别指望文案短就不会溢出：真机上一条主进程原样转达的英文错误就把这排撑破、溢出到卡片外。
  // 全文不会因此丢失 —— `title` 悬浮可看，失败细节另有 toast。
  const noticeClassName = 'min-w-0 max-w-[22rem] truncate px-1 text-xs text-foreground-muted';

  const platformNotice = state.platformNotice ? (
    <span role="status" title={state.platformNotice} className={noticeClassName}>
      {state.platformNotice}
    </span>
  ) : undefined;
  const platformRetry = state.platformNotice && state.retryPlatformCatalog ? (
    <button
      type="button"
      onClick={() => state.retryPlatformCatalog?.()}
      className="shrink-0 px-1 text-xs text-foreground-muted underline underline-offset-2 hover:text-foreground"
    >
      {translate('harnessCatalog.retry')}
    </button>
  ) : undefined;

  // 与 platformNotice 同一档视觉：无边框、跟 Chat UI 标签同字号色阶。
  //
  // 这里**只留一句状态**（没装 / 没登录 / 读坏了），不可点：它长度不由前端决定，整句做成按钮
  // 会把一条会被 truncate 的文字变成一个热区。
  // ⚠️ 2026-09-05 删掉了曾并排在它后面的那枚「去登录」动作词 —— 去登录的路搬进了模型清单
  // （`harnessModelUnlock`），理由写在 `harnessSignIn` 的 prop 文档里：那颗按钮在选了平台模型
  // 时会退化成一个没有上下文的孤零零「去登录」。❌ 别再往这排加登录入口。
  const harnessNotice = state.harnessNotice ? (
    <span role="status" title={state.harnessNotice} className={noticeClassName}>
      {state.harnessNotice}
    </span>
  ) : undefined;

  const grokPermissionNotice = state.provider === 'grok' ? (
    <span
      role="status"
      title={translate('taskConfig.grokPermissionWarning')}
      className="min-w-0 max-w-[28rem] truncate px-1 text-xs text-foreground-destructive"
    >
      {translate('taskConfig.grokPermissionWarning')}
    </span>
  ) : undefined;

  // 点开一枚 chip 看里面是什么(#5269,owner 2026-09-09:「点击怎么没法展开预览啊,文件也是」)。
  // ⚠️ 这一格从前**根本没接**这个回调 —— 于是新建会话页的 chip 一枚都点不开,而那正是他每天
  // 打开就看见的那一面。
  const [attachmentViewer, setAttachmentViewer] = useState<ComposerAttachment | null>(null);

  // 「终端 | 通用」经 toolbarExtra 进底排(给不给见 `sessionViewOffered`)。选不了的那一头留在原地、
  // 灰掉并说明原因(`sessionViewLock`),❌ 凭空消失(owner 2026-08-21)。
  const sessionViewControl = state.sessionViewOffered ? (
    <SessionViewControl
      value={state.sessionView}
      onChange={state.setSessionView}
      lock={state.sessionViewLock}
      agentName={selectedAgentName}
      disabled={!state.provider}
    />
  ) : undefined;

  const toolbarExtra =
    sessionViewControl || platformNotice || harnessNotice || grokPermissionNotice ? (
      <>
        {sessionViewControl}
        {harnessNotice}
        {platformNotice}
        {platformRetry}
        {grokPermissionNotice}
      </>
    ) : undefined;

  return (
    <Field>
      <input
        ref={attachInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleAttachPicked}
      />
      {/* The project home and the New session page use the same composer as a session, so they carry
          the same region marker: ← lands the keyboard in here (behavior session-page「键盘导航」), and
          `session.focusComposer` (⇧Esc) — a no-op on these pages until now — starts working too. */}
      <div
        data-region="composer"
        className={cn(
          nativeComposerAppearance,
          'transition-colors',
          isDragOver && 'rounded-lg bg-background-2 ring-2 ring-border-2 ring-inset'
        )}
        onBlur={onPromptBlur}
        {...dropHandlers}
      >
        <ChatComposer
          canSubmit={canSubmit}
          showSubmitButton={!!onSubmit}
          placeholder={
            (typeof placeholder === 'function' ? placeholder(selectedAgentName) : placeholder) ??
            'Describe what the agent should do, or use / to select a prompt...'
          }
          tone={verb?.tone}
          leading={verb?.tag(state.providerError ? undefined : (state.provider ?? undefined))}
          onSubmit={() => onSubmit?.()}
          onInputChange={handleComposerInputChange}
          editorApiRef={editorApiRef}
          mentionProvider={mentionProvider}
          renderMentionIcon={renderMentionIcon}
          queryCommands={querySlashItems}
          agentOptions={agentOptions}
          agentOptionsLoading={agentOptionsLoading}
          // Keep the unavailable id in state for the diagnostic below, but do not hand it to
          // ChatComposer as a selected option: the composer expects selected agents to have a
          // capabilities payload and would otherwise crash before rendering the repair message.
          selectedAgent={state.providerError ? undefined : (state.provider ?? undefined)}
          onAgentChange={(id) => state.setProvider(id as AgentProviderId)}
          // The shell owns the top-level tab; the task renderer keeps ownership of its library
          // route and installation surface. Both intents happen in one click.
          // 远端:没有「去本机资源库装」这一步 —— 跳过去看到的是这台电脑的安装,不是那台机器的
          // (那台机器上没装的,选了之后建会话时由那台机器当场装)。
          onAgentAction={remoteCreateForActions ? undefined : (id) => {
            (window as typeof window & {
              __GUGU_OPEN_SESSIONPAGE_AGENT_INSTALL__?: (agentId: string) => void
            }).__GUGU_OPEN_SESSIONPAGE_AGENT_INSTALL__?.(id)
            navigate('library', { tab: 'agents', agentId: id })
          }}
          modelOptions={modelOptions}
          // 编解码都在装配那份里(@@@composer-model-assembly)—— 这里只把分好的两路写回
          // **本页自己的**两套 state。❌ 别把 state 也合过去:那两套决定 spawn 走哪条路,
          // 会话页只有一个活会话,合起来只能靠 surface flag 在里面分叉。
          selectedModel={composerSelectedOptionId(state)}
          onModelChange={(optionId) => {
            const selection = composerModelSelection(optionId);
            if (selection.source === 'platform') state.setPlatformModel(selection.modelId);
            else state.setModel(selection.modelId || null);
          }}
          // 一个模型都拿不到时,「模型」那一行改放一枚「登录解锁 X」的标签,点了开登录终端。
          // ❌ 不靠左边工具栏那句「需要先登录」代劳:它离模型控件隔了半个底排,
          //    人在模型那里找不到任何交代(owner 2026-08-26 实测)。
          modelUnlock={state.harnessModelUnlock}
          onModelUnlock={state.harnessSignIn ?? undefined}
          // 底部「管理模型 / 升级解锁更多模型」(#7056),三个模型菜单同一份。
          {...composerModelFooter(state.platformModels)}
          effortOptions={state.effortOptions}
          selectedEffort={state.effort ?? undefined}
          onEffortChange={(effortId) => state.setEffort(effortId || null)}
          defaultEffort={state.defaultEffort ?? undefined}
          permissionModeOptions={permissionModeOptions}
          selectedPermissionMode={permissionModeOptions ? state.permissionMode : undefined}
          onPermissionModeChange={(modeId) => {
            if (isGuguPermissionMode(modeId)) state.setPermissionMode(modeId);
          }}
          onAttach={enableAttachments ? handleAttach : undefined}
          onImageFilesDropped={enableAttachments ? handleFiles : undefined}
          onFilesDropped={enableAttachments ? handleFiles : undefined}
          onDirectoriesDropped={enableAttachments ? handleDirectoriesDropped : undefined}
          onRetryAttachment={state.retryPathAttachment}
          dataDropTypes={dataDropTypes}
          onDataDropped={onDataDropped}
          attachments={state.attachments}
          onAttachmentsChange={enableAttachments ? state.setAttachments : undefined}
          onViewAttachment={(att) => {
            if (!openComposerImage(att)) setAttachmentViewer(att);
          }}
          toolbarExtra={toolbarExtra}
          className={textareaClassName}
        />
        <AttachmentViewerDialog
          open={!!attachmentViewer}
          onOpenChange={(open) => {
            if (!open) setAttachmentViewer(null);
          }}
          name={attachmentViewer?.name}
          text={attachmentViewer?.previewText}
          truncated={attachmentViewer?.previewTruncated}
        />
        {state.providerError ? (
          <p role="alert" className="mt-1 text-xs text-foreground-destructive">
            {state.providerError}
          </p>
        ) : null}
        {/* #6692 读不到模型目录的原因:工具栏那句定性的下文,就地一行。原文长度不可控 —— 只取第一行、遮掉路径与
            令牌、封顶 280 字(与启动失败同一个 safeFailureLine)。这一行窄了会省略号收掉,title 里放的是同一份
            处理过的那一行,悬停看得到被省略的部分;原文的其余部分不显示。 */}
        {state.harnessNotice && state.harnessNoticeDetail ? (
          <p
            role="status"
            data-testid="harness-catalog-failure-detail"
            title={safeFailureLine(state.harnessNoticeDetail)}
            className="mt-1 truncate px-1 text-xs text-foreground-muted"
          >
            {safeFailureLine(state.harnessNoticeDetail)}
          </p>
        ) : null}
      </div>
    </Field>
  );
}
