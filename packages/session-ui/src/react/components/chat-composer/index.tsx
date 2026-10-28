/**
 * ChatComposer —— 任务会话的输入区。
 *
 * # `data-slot` 词汇表（#3334 W2）
 *
 * `data-slot` 在本仓是**对外契约**，不是标注：chrome 已有 163 个，CSS 与测试正按它们选元素。
 * ⇒ 这批名字自本次落地起就是契约，改名要走 deprecation，不能就地改字符串。
 * 判据：`tests/composer-slot-contract-source-3334.test.ts`（源码层，进 CI 闸）
 *      + `tests/browser/composer-slot-contract-3334.test.tsx`（真 DOM，`session-browser`）。
 * ⚠️ 本行原写「不进闸，见 #3434」——**那是假的**：#3436 已把两个 browser project 接进必需闸
 * （`ci.yml` 的 `pnpm test:browser`）。两条判据都进闸，区别在覆盖的失败种类，不在谁进闸。
 *
 * 参照物是 assistant-ui 的 `elements-composer`（上游 660 行，我们 1100+ 行，是它的超集）。
 * 逐元素对照见 design notes #74–#85。
 * **「上游对应名」为 `—` 的是我们自己的概念**——下一个人拿它去上游 registry 里对不上时，
 * 那一列直接说明这不是抄错了。
 *
 * ## 规则：slot 名只描述真实存在的元素；没有元素就没有名字
 *
 * | 我们的 slot | 是哪个元素 | 上游对应名 | 归属 |
 * |---|---|---|---|
 * | `composer` | 最外层根 | `composer` | 共同词汇 |
 * | `composer-bar` | 输入卡片本体（`composerShell`） | `composer-bar` | 共同词汇 |
 * | `composer-input` | 编辑器区（含 @提及 / 斜杠弹层） | `composer-input` | 共同词汇 |
 * | `composer-toolbar` | 底排工具栏 | `composer-toolbar` | 共同词汇 |
 * | `composer-attachments` | 附件缩略图条 | `composer-attachments` | 共同词汇 |
 * | `composer-attachment` | 单个附件块 | `composer-attachment` | 共同词汇 |
 * | `composer-actions-start` | 工具栏左组（附件 + 权限档） | `composer-actions` ⚠️ | 解剖不同 |
 * | `composer-actions-end` | 工具栏右组（用量/agent/模型/发送） | `composer-actions` ⚠️ | 解剖不同 |
 * | `composer-effort` | 模型触发器内就地显示的推理强度 | — | 我们的 |
 * | `composer-model` | 包住模型触发器+面板的结构槽(`display:contents`) | `model-selector-trigger` ⚠️ | 解剖不同 |
 * | `composer-model-icon` | 一行左边那枚**厂商 logo** | `ModelIcon`(无 slot) | 共同解剖 |
 * | `composer-model-name` | 一行第一段:模型名 | — | 我们的 |
 * | `composer-effort-row` | 面板底部的「思考」那一段 | `model-selector-effort` | 共同词汇 |
 * | `composer-effort-value` | 那一段的读数:当前生效的档名 | — | 我们的 |
 * | `composer-effort-indicator` | 滑杆上走过的那一段填充 | — | 我们的 |
 * | `composer-effort-tick` | 滑杆上的一个刻点(一档一个) | — | 我们的 |
 * | `composer-permission-mode` | 权限档选择器的触发内容 | — | 我们的 |
 * | `data-permission-mode-id` | 权限档触发器/选项的稳定 item id（native 或 Gugu 档） | — | 稳定 DOM 合同 |
 * | `composer-queued-prompts` | 排队消息条 | — | 我们的 |
 * | `composer-permission-request` | ACP 权限请求条 | — | 我们的 |
 * | `composer-notice` | 通知条（stop reason 等） | — | 我们的 |
 *
 * ⚠️ `composer-actions-start` / `-end`：上游只有**一个** `composer-actions`，我们是左右两组
 * （Codex 版式）。两个都叫 `composer-actions` 会让选择器有歧义，而歧义选择器会长出
 * 「随便抓到哪个都算过」的判据。**没有**为了容纳上游那个名字新建包裹节点 ——
 * `composer-toolbar` 天然是两组的共同祖先，上游「一组 actions」的概念仍可表达。
 * 为了容纳一个名字而增加一个节点，和设一个空槽是同一个错误，且更难发现。
 *
 * ## 上游有、我们没有 —— 不设空槽
 *
 * `composer-voice` / `composer-voice-button`：我们没有语音管线（全仓实测 0 命中，
 * 见对照表 §2.9）。没有 DOM 就不给名字。
 *
 * ## 有面但不在上表里的两类
 *
 * **① primitive 渲染的控件不在这里命名**：附件 + 号、发送/停止、用量圆环、agent 选择器、
 * 模型触发器都由 `Button` / `Combobox.Trigger` / `DropdownMenu.Trigger` / `Popover.Trigger`
 * 渲染，而这些 primitive **先写自己的 `data-slot` 再 `{...props}` 展开**
 * （`primitives/button/index.tsx:19,21`）⇒ 调用点传 `data-slot` 会**静默顶掉**它们自己的那个。
 * 实测代价：第一版 W2 把 composer 里的 `dropdown-menu-trigger` 顶没了，而
 * `composer-model-menu-3249.test.tsx:72` 与 `composer-surface-3334.test.tsx:122` 正按它选元素
 * （后者用 `?.click()`，选不中不报错，红出现在几十行外「模型面板没打开」上）。
 * ⇒ 它们靠**结构 slot 限定作用域**定位，不覆盖：
 *   `[data-slot="composer-actions-end"] [data-slot="composer-model"] [data-slot="combobox-trigger"]`（模型触发器）
 *   `[data-slot="composer-actions-start"] [data-slot="button"]`（附件 + 号）
 *
 * ⚠️ 2026-09-05 模型触发器从 `DropdownMenu` 换成了 `Combobox`(套上游那版的搜索+过滤+分组),
 * 所以它现在报的是 `combobox-trigger`。而 `composer-actions-end` 里**有两颗** combobox 触发器
 * (agent 与模型),光靠 `combobox-trigger` 已经不唯一 —— 这正是 `composer-model` 这个
 * `display:contents` 结构槽存在的理由(上游自己也有一个 `model-selector-trigger` slot)。
 *
 * ### 这四个上游名字**现在没有**，以及为什么（缺席也需要一个写下来的理由）
 *
 * | 上游 slot | 我们的控件 | 现在怎么定位 |
 * |---|---|---|
 * | `composer-attach` | 附件 + 号 | `[data-slot="composer-actions-start"] [data-slot="button"]` |
 * | `composer-send` | 发送 / 停止键 | `[data-slot="composer-actions-end"] [data-slot="button"]` |
 * | `composer-context` | 用量圆环 | `[data-slot="composer-actions-end"] [data-slot="popover-trigger"]` |
 * | `composer-model-trigger` | 模型触发器 | `[data-slot="composer-actions-end"] [data-slot="composer-model"] [data-slot="combobox-trigger"]` |
 *
 * ❌ **不是漏了，是不能。** 给它们同名 slot 必然顶掉 primitive 自己的那个（上一段的实测），
 * 而作用域定位零基础设施改动、不造节点、不吃掉任何既有选择器，是满足需求的最小实现。
 * 要真正拿到这四个名字，得先修 primitive 的契约（让它合并而不是被顶掉）——
 * 那是 **#3486**，不是这张 PR。#3486 落地后这张表应当重审。
 *
 * ⚠️ 顺带记一笔实测（服务 #3486）：**截至 2026-08-12，走 TS AST 扫全仓 236 个 JSX `data-slot`
 * 属性（阳性对照：总数 236 ≠ 0，扫描器没瞎），没有任何调用点在向 primitive 传 `data-slot`**
 * ——非 primitive 目录里写 `button` /
 * `dropdown-menu-trigger` 这类名字的，全都是**原生 `<button>` 上的定义处**（如
 * `features/sidebar/sidebar-primitives.tsx:91`、`features/sessions/pane-empty-state.tsx:132`），
 * 不是调用点覆盖。⇒ 这个洞真实存在但**尚未被踩中**，本 PR 的第一版差点成为第一例。
 *
 * **② prompt history 没有 slot，因为它没有 DOM**：它是 `prompt-history-keymap.ts` 里的
 * 纯函数 + keymap，一个元素都不渲染（对照：同目录 `mention.ts` 有 render/element，因为它真有 pill）。
 * 它是一条按键**行为**，不是一个面。
 */
import { Button } from '@session-ui/react/primitives/button';
import { cx } from '@session-ui/styles/utilities/cx';
import { ArrowUp, CircleAlert, Plus, Search, ShieldCheck } from '../../../icons'
import { ToolbarDisclosureProvider, useToolbarDisclosure } from './use-toolbar-disclosure'
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ComboboxPopover } from '../combobox-popover';
import { PromptEditor } from '../prompt-editor/prompt-editor';
import type {
  CommandItem,
  ContextMentionProvider,
  MentionItem,
  PromptEditorRef,
  RenderMentionIcon,
} from '../prompt-editor/types';
import { ContextUsageIndicator } from './context-usage-indicator';
import type { ContextUsage } from './context-usage-indicator';
import { PermissionBand } from './permission-band';
import type { ComposerPermissionRequest } from './permission-band';
import { QueuedPromptsBand } from './queued-prompts-band';
import type { ComposerQueuedPrompt } from './queued-prompts-band';
import * as styles from './chat-composer.css';
import './composer-contract.css';
import { splitDroppedFiles } from './composer-drop-files';
import { useMessages } from '../../localization/message-provider';

export type { MentionItem, CommandItem };
export type {
  MentionKind,
  MentionRole,
  CommandBehavior,
  ContextMentionProvider,
  PromptEditorRef,
  RenderMentionIcon,
} from '../prompt-editor/types';
export type { ContextUsage } from './context-usage-indicator';
export type { ComposerQueuedPrompt } from './queued-prompts-band';

// ── 拆出去的几块（#4981 A1）─────────────────────────────────────────────────────
//
// `index.tsx` 在 `scripts/im-architecture-migration-gate.json` 的 `migrationProduction`
// 逐文件名单里（按精确路径匹配），该类别有净增行数上限；同目录的新文件不在名单里。
// ⇒ 与渲染主体无关的东西（数据形状、纯函数、两个自成一体的控件）搬到隔壁，
//   **公开 API 仍从这里 re-export**，外部调用点一个都不用改。
export type {
  ComposerAgentOption,
  ComposerAttachment,
  ComposerAttachmentState,
  ComposerEffortItem,
  ComposerEffortOption,
  ComposerModelFact,
  ComposerModelGroup,
  ComposerModelItem,
  ComposerModelOption,
  ComposerModelUnlock,
  ComposerModelUpgrade,
  ComposerNotice,
  ComposerNoticeVariant,
  ComposerPermissionModeItem,
  ComposerPermissionModeOption,
} from './composer-options';
export { stopReasonNotice } from './composer-notice';
export {
  PASTED_TEXT_AS_FILE_MIN_CHARS,
  formatAttachmentSize,
  isImageFile,
  pastedTextFile,
} from './composer-attachment-file';
export { ComposerAttachmentChip } from './composer-attachment-chip';
export {
  ATTACHMENT_PREVIEW_TEXT_MAX_BYTES,
  attachmentPreviewKind,
  isTextPreviewableFile,
  readAttachmentPreviewText,
} from './composer-attachment-preview';
export type { AttachmentPreviewKind, AttachmentPreviewText } from './composer-attachment-preview';
export {
  ComposerModelMenu,
  buildComposerModelGroups,
  modelTitle,
  resolveComposerModelPanel,
} from './composer-model-menu';
export type { ComposerModelPanel } from './composer-model-menu';
export { ComposerAgentSelector, buildAgentGroups } from './composer-agent-selector';
export type { AgentGroup, ComposerAgentSelectorProps } from './composer-agent-selector';

import type {
  ComposerAgentOption,
  ComposerAttachment,
  ComposerEffortItem,
  ComposerEffortOption,
  ComposerModelItem,
  ComposerModelOption,
  ComposerModelUnlock,
  ComposerModelUpgrade,
  ComposerNotice,
  ComposerPermissionModeItem,
  ComposerPermissionModeOption,
} from './composer-options';
import { NoticeBand } from './composer-notice';
import {
  PASTED_TEXT_AS_FILE_MIN_CHARS,
  isImageFile,
  pastedTextFile,
  readImageAttachment,
} from './composer-attachment-file';
import { ComposerAttachmentChip } from './composer-attachment-chip';
import { ComposerModelMenu, resolveComposerModelPanel } from './composer-model-menu';
import { ComposerAgentLoading, ComposerAgentSelector } from './composer-agent-selector';
// ── Props ─────────────────────────────────────────────────────────────────────

export type ComposerQueuedPromptEdit = { id: string; text: string; originalDraftText: string; pending?: boolean };

export interface ChatComposerProps {
  editorOptions?: Pick<import('../prompt-editor/types').PromptEditorProps, 'inputTestId' | 'inputRef' | 'enterBehavior' | 'clearOnSubmit'>;
  mobile?: boolean;
  disabled?: boolean;
  isWorking?: boolean;
  stopDisabled?: boolean;
  /** False while the session is still starting up. Blocks Send/Enter but keeps the editor typeable. */
  canSubmit?: boolean;
  /** Hide the submit/stop control for draft-only composer surfaces. */
  showSubmitButton?: boolean;
  /** Override the idle editor placeholder. Disabled/working placeholders still take precedence. */
  placeholder?: string;
  /** Override the disabled editor placeholder for setup/empty states. */
  disabledPlaceholder?: string;

  agentOptions?: ComposerAgentOption[] | null;
  /** 智能体名单还在路上:名单还空着时画占位(ComposerAgentLoading)。 */
  agentOptionsLoading?: boolean;
  selectedAgent?: string;
  onAgentChange?: (agentId: string) => void;
  /**
   * 点了一个带 `action` 的 agent 行(目前只有没装的 agent → 去安装)。宿主决定这一步做什么;
   * composer 只知道「这一行的点击不是选中」。
   */
  onAgentAction?: (agentId: string) => void;
  /**
   * True once the session has history (any prompt sent). ACP cannot switch
   * agents mid-conversation, so the trigger becomes a disabled icon button.
   */
  agentLocked?: boolean;
  /** The conversation header already identifies an agent that cannot be changed. */
  hideLockedAgent?: boolean;

  modelOptions?: Record<string, ComposerModelOption> | null;
  selectedModel?: string;
  onModelChange?: (modelId: string) => void;
  /** 宿主要把模型面板打开:每变一次开一次(见 `ComposerModelMenu.openRequest`)。 */
  modelMenuOpenRequest?: number;
  /**
   * 拿不到模型时「模型」那一行放什么。设了它,面板即使一个模型都没有也照常打开 ——
   * 否则触发器整颗消失,用户连「为什么没有模型」都无处可问。
   */
  modelUnlock?: ComposerModelUnlock | null;
  /** 点了那枚标签。宿主决定这一步做什么;composer 只知道「这一行的点击不是选中」。 */
  onModelUnlock?: () => void;
  /** 模型面板底部「管理模型」—— 宿主打开设置里的「模型」那一页(#7056)。不给 = 不画。 */
  onManageModels?: () => void;
  /** 模型面板底部「升级解锁更多模型」(免费档才有,见 `ComposerModelUpgrade`)。 */
  modelUpgrade?: ComposerModelUpgrade | null;
  onModelUpgrade?: () => void;

  effortOptions?: Record<string, ComposerEffortOption> | null;
  selectedEffort?: string;
  onEffortChange?: (effortId: string) => void;
  /**
   * Level the agent would pick for itself when none is armed. Named in the 「默认」 row so the
   * unset state still says what will happen, rather than leaving the user to guess.
   */
  defaultEffort?: string;

  permissionModeOptions?: Record<string, ComposerPermissionModeOption> | null;
  selectedPermissionMode?: string;
  onPermissionModeChange?: (modeId: string) => void;
  /** Extra control(s) appended to the toolbar-left row, after the permission selector. */
  toolbarExtra?: React.ReactNode;

  onSubmit: (text: string) => void;
  /** Called whenever the editor serialized plain text changes. */
  onInputChange?: (text: string) => void;
  /** Called after a mention node is inserted. Raw insertText entries do not trigger this. */
  onMentionInsert?: (item: MentionItem) => void;
  /**
   * Called instead of onSubmit when the user attempts to send while the
   * session is actively working (isWorking === true). Lets the host queue,
   * confirm interruption, or otherwise resolve the conflict.
   * When absent, submit attempts while working are silently ignored.
   */
  onSubmitWhileWorking?: (text: string) => void;
  onStop?: () => void;
  onAttach?: () => void;
  /** Context-window usage data for the toolbar donut indicator. Hidden when null/undefined. */
  contextUsage?: ContextUsage | null;

  /**
   * Host-controlled attachment list. By default the composer creates image
   * attachments itself from drag-drop and forwards them via `onAttachmentsChange`.
   * Hosts can override image handling with `onImageFilesDropped`.
   */
  attachments?: ComposerAttachment[];
  onAttachmentsChange?: (next: ComposerAttachment[]) => void;
  /**
   * Called with pasted or dropped image files before the default data-url attachment path.
   * When supplied, the host owns uploading and adding preview attachments.
   */
  onImageFilesDropped?: (files: File[]) => void;
  /**
   * Called whenever files are dropped onto the composer.
   * The host should resolve real filesystem paths and insert non-image files
   * as path mentions via the `editorApiRef` (using `insertMention`).
   */
  onFilesDropped?: (files: File[]) => void;
  /**
   * 拖进来的是**文件夹**时走这里,❌ 不进附件通道:文件夹没有可读的字节,
   * 附件管线对它只能静默失败;宿主应把它的绝对路径放进正文(譬如经 `editorApiRef`
   * 插一枚 `file` 提及)。未提供时文件夹回落进 `onFilesDropped`(旧行为,仅供未迁移宿主)。
   * `entries` 与 `files` 一一对应:会话在别的机器上时,宿主据此读出文件夹里的东西传过去(#6264)。
   */
  onDirectoriesDropped?: (files: File[], entries: FileSystemDirectoryEntry[]) => void;

  /**
   * 应用内部拖拽(不是 OS 文件)的载荷类型 —— 宿主用 `DataTransfer` 上的自定义 MIME 认领它。
   * 列在这里的类型,输入框不碰(❌ 不会被 ProseMirror 当文本插进正文),整条交给 `onDataDropped`。
   */
  dataDropTypes?: readonly string[];
  /**
   * 落下了一次 `dataDropTypes` 认领的拖拽。宿主自己决定它变成什么 —— 譬如把一条会话行
   * 变成一枚 @ 提及(经 `editorApiRef.insertMention`)。
   */
  onDataDropped?: (dataTransfer: DataTransfer) => void;

  /**
   * Optional ref forwarded to the inner PromptEditor imperative API, giving
   * the host access to `insertMention` (and focus/clear/getText).
   */
  editorApiRef?: React.Ref<PromptEditorRef>;

  /**
   * 用户点了附件条上的一枚 chip —— 宿主拿它开预览对话框(#5269)。
   * 只有手上真有可看内容的 chip 才点得开(`attachmentPreviewKind`),所以宿主这里不必再判类型。
   */
  onViewAttachment?: (att: ComposerAttachment) => void;
  /** 点了失败 chip 上的「重试」(只对 `retryable` 的 chip 出现)。 */
  onRetryAttachment?: (id: string) => void;

  /**
   * Preferred: typed provider for @ mention suggestions.
   * When both `mentionProvider` and `queryMentions` are provided,
   * `mentionProvider` takes precedence.
   */
  mentionProvider?: ContextMentionProvider;
  /** Optional host renderer for inline mention pill icons. */
  renderMentionIcon?: RenderMentionIcon;
  /** Legacy: async callback returning @ mention suggestions for the given query. */
  queryMentions?: (query: string) => Promise<MentionItem[]>;
  /**
   * This session's already-sent prompts, oldest first, for ↑↓ recall in the editor
   * (behavior session-page「键盘导航」). Read on the keypress, so hosts may derive it from a live
   * transcript. Omit to leave ↑↓ as plain caret movement.
   */
  getPromptHistory?: () => readonly string[];
  /** Async callback returning / command suggestions for the given query. */
  queryCommands?: (query: string) => Promise<CommandItem[]>;
  /** Called when a / command with behavior='execute' is selected. */
  onCommand?: (item: CommandItem) => void;
  /** Session-state notice shown flush above the input (e.g. ACP stop reasons). */
  notice?: ComposerNotice | null;
  /**
   * Pending ACP permission request to show in the band above the input.
   * When present, the notice band is replaced by the permission band.
   * Pass null/undefined when no request is pending.
   */
  permissionRequest?: ComposerPermissionRequest | null;
  /** Total number of queued permission requests. Drives the "1 of N" counter. */
  permissionQueueCount?: number;
  /** Called with the chosen optionId when the user resolves a permission request. */
  onResolvePermission?: (optionId: string) => void;

  /** Prompts accepted while the agent is busy and waiting to be sent. */
  queuedPrompts?: ComposerQueuedPrompt[];
  /** 排队条里那行字**显示**成什么(@ 提及显示成名字而不是地址)。缺席就按原文显示。 */
  renderQueuedPromptText?: (text: string) => React.ReactNode;
  onEditQueuedPrompt?: (id: string, text: string) => void;
  /** Controlled runtime reservation; omission keeps the component's local queue editor. */
  queuedPromptEdit?: ComposerQueuedPromptEdit | null;
  onBeginEditQueuedPrompt?: (id: string, originalDraftText?: string) => void;
  onChangeQueuedPromptEdit?: (text: string) => void;
  onFinishQueuedPromptEdit?: (text: string | null) => void;
  onDeleteQueuedPrompt?: (id: string) => void;
  onReorderQueuedPrompts?: (ids: string[]) => void;
  onSendQueuedPromptNow?: (id: string) => void;
  /**
   * 这一框此刻不是发消息而是新任务:框整张换成那件事的色,`leading` 那枚标签
   * 排在输入行的最前面、紧挨占位文字。
   */
  tone?: 'task';
  leading?: React.ReactNode;
  className?: string;
}

// ── Main component ────────────────────────────────────────────────────────────

export function ChatComposer({
  editorOptions,
  mobile = false,
  disabled = false,
  isWorking = false,
  stopDisabled = false,
  canSubmit: hostCanSubmit,
  showSubmitButton = true,
  placeholder,
  disabledPlaceholder,
  agentOptions,
  agentOptionsLoading = false,
  selectedAgent,
  onAgentChange,
  onAgentAction,
  agentLocked = false,
  hideLockedAgent = false,
  modelOptions,
  selectedModel,
  onModelChange,
  modelMenuOpenRequest,
  modelUnlock,
  onModelUnlock,
  onManageModels,
  modelUpgrade,
  onModelUpgrade,
  effortOptions,
  selectedEffort,
  onEffortChange,
  defaultEffort,
  permissionModeOptions,
  selectedPermissionMode,
  onPermissionModeChange,
  toolbarExtra,
  onSubmit,
  onInputChange,
  onMentionInsert,
  onSubmitWhileWorking,
  onStop,
  onAttach,
  contextUsage,
  attachments = [],
  onAttachmentsChange,
  onImageFilesDropped,
  onFilesDropped,
  onDirectoriesDropped,
  dataDropTypes,
  onDataDropped,
  editorApiRef,
  mentionProvider,
  renderMentionIcon,
  queryMentions,
  queryCommands,
  onCommand,
  onViewAttachment,
  onRetryAttachment,
  notice,
  permissionRequest,
  permissionQueueCount = 1,
  onResolvePermission,
  queuedPrompts = [],
  renderQueuedPromptText,
  onEditQueuedPrompt,
  queuedPromptEdit,
  onBeginEditQueuedPrompt,
  onChangeQueuedPromptEdit,
  onFinishQueuedPromptEdit,
  onDeleteQueuedPrompt,
  onReorderQueuedPrompts,
  onSendQueuedPromptNow,
  getPromptHistory,
  tone,
  leading,
  className,
}: ChatComposerProps) {
  const { translate } = useMessages();
  const rootRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<PromptEditorRef | null>(null);
  // 底排放不下时按档把标签收成图标(渐进披露),见 use-toolbar-disclosure.ts
  const toolbarDisclosure = useToolbarDisclosure();
  const [dragActive, setDragActive] = useState(false);
  const [localQueueEdit, setLocalQueueEdit] = useState<ComposerQueuedPromptEdit | null>(null);
  const queueEdit = queuedPromptEdit === undefined ? localQueueEdit : queuedPromptEdit;
  const previousEdit = useRef<ComposerQueuedPromptEdit | null>(null);
  if (localQueueEdit && !queuedPrompts.some((prompt) => prompt.id === localQueueEdit.id)) setLocalQueueEdit(null);

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (queueEdit) {
      const opening = previousEdit.current?.id !== queueEdit.id;
      previousEdit.current = queueEdit;
      if (editor.getText() !== queueEdit.text) editor.setText(queueEdit.text);
      if (opening) editor.focus();
    } else if (previousEdit.current) {
      const original = previousEdit.current.originalDraftText;
      previousEdit.current = null;
      editor.setText(original);
      editor.focus();
    }
  }, [queueEdit]);

  const beginQueueEdit = (id: string, text: string) => {
    if (queueEdit) return;
    if (onBeginEditQueuedPrompt) { onBeginEditQueuedPrompt(id, editorRef.current?.getText() ?? ''); return; }
    setLocalQueueEdit({ id, text, originalDraftText: editorRef.current?.getText() ?? '' });
  };
  const changeQueueEdit = (text: string) => {
    if (queuedPromptEdit !== undefined) onChangeQueuedPromptEdit?.(text);
    else setLocalQueueEdit((edit) => edit ? { ...edit, text } : null);
  };
  const finishQueueEdit = (text: string | null) => {
    if (!queueEdit || queueEdit.pending || (text !== null && !text.trim())) return;
    if (queuedPromptEdit !== undefined) { onFinishQueuedPromptEdit?.(text); return; }
    if (text !== null) onEditQueuedPrompt?.(queueEdit.id, text);
    setLocalQueueEdit(null);
  };


  // Retain the last notice so its content stays rendered while the band
  // collapses out, letting the exit transition play before unmount.
  const [retainedNotice, setRetainedNotice] = useState<ComposerNotice | null>(notice ?? null);
  useEffect(() => {
    if (notice) setRetainedNotice(notice);
  }, [notice]);

  // Revoke object URLs for image attachments on unmount to avoid leaks.
  // Track the latest attachments in a ref so the unmount cleanup revokes the
  // current set rather than a stale, mount-time snapshot.
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  useEffect(() => {
    return () => {
      attachmentsRef.current.forEach((att) => {
        if (att.kind === 'image' && att.previewUrl?.startsWith('blob:')) {
          URL.revokeObjectURL(att.previewUrl);
        }
      });
    };
  }, []);

  const canSubmit = hostCanSubmit ?? true;
  const handleSubmit = (text: string) => {
    if (queueEdit) { finishQueueEdit(text); return; }
    // Attachment-only sends are valid for both images and ordinary files.
    if (!text.trim() && attachments.length === 0 && hostCanSubmit !== true) return;
    // While the agent is actively working, route to the host's conflict handler
    // (e.g. queueing or a cancel-and-send confirmation) instead of submitting.
    if (isWorking) {
      onSubmitWhileWorking?.(text);
      return;
    }
    if (disabled || !canSubmit) return;
    onSubmit(text);
    // Every phone host (chat, agent thread, new task) submits here. Settle focus
    // synchronously: a deferred refocus reopens the keyboard and jumps the shell.
    // Scope the blur to this composer so another input never loses its focus.
    const active = rootRef.current?.ownerDocument.activeElement;
    if (mobile && active instanceof HTMLElement && rootRef.current?.contains(active)) active.blur();
  };

  /**
   * 超长的纯文本粘贴自己变成一个 `.txt` 文件(#5269,owner 2026-09-08 的预期)。
   *
   * 走 `onFilesDropped` —— 与「把一个 .txt 拖进来」完全同一条路,所以每个宿主已有的编码方式
   * (chat 附件 / 绝对路径 mention)照旧成立,这里不替它们选。宿主没有那个口子就**放行**:
   * 拦下一段收不走的文字 = 用户的话凭空消失,比让它长一点糟得多。
   *
   * 返回 true 才算收走 —— 这个签名由 `PromptEditor.onPasteText` 定,它在 ProseMirror 插入
   * **之前**问,是唯一拦得住的时机(见那个 prop 的注释)。
   */
  const handlePastedText = (text: string): boolean => {
    if (disabled || !onFilesDropped) return false;
    if (text.length < PASTED_TEXT_AS_FILE_MIN_CHARS) return false;
    onFilesDropped([pastedTextFile(text)]);
    return true;
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const files = Array.from(e.clipboardData.items).flatMap((item) => {
      if (item.kind !== 'file') return [];
      const file = item.getAsFile();
      if (!file) return [];
      return [{ file, isImage: isImageFile(file, item.type || file.type) }];
    });
    if (files.length === 0) return;

    const imageFiles = files.filter((entry) => entry.isImage).map((entry) => entry.file);
    const nonImageFiles = files.filter((entry) => !entry.isImage).map((entry) => entry.file);

    if (!e.clipboardData.types.some((type) => type.startsWith('text/'))) e.preventDefault();
    if (onImageFilesDropped) {
      onImageFilesDropped(imageFiles);
    } else if (onAttachmentsChange) {
      const base = attachments;
      void Promise.all(imageFiles.map(readImageAttachment)).then((newAttachments) => {
        onAttachmentsChange([...base, ...newAttachments]);
      });
    }
    // Keep file semantics identical to drag/drop: task-local files become local
    // path mentions, while image bytes use the ACP attachment upload path above.
    onFilesDropped?.(nonImageFiles);
  };

  // ── Drag-and-drop ───────────────────────────────────────────────────────────

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!dragActive) setDragActive(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    // Only clear when leaving the root element itself (not a child).
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragActive(false);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);

    // 应用内部的拖拽先认领:它带的是自定义 MIME,`dataTransfer.files` 是空的,
    // 走下面那条文件通道等于当场丢掉。
    if (
      onDataDropped &&
      dataDropTypes?.some((type) => e.dataTransfer.types.includes(type))
    ) {
      onDataDropped(e.dataTransfer);
      return;
    }

    const split = splitDroppedFiles(e.dataTransfer);
    // 宿主没接文件夹那条道时保持旧行为(与普通文件同路),❌ 不替它静默丢掉。
    const directoryHandler = onDirectoriesDropped;
    const files = directoryHandler ? split.files : [...split.files, ...split.directories];
    const directories = directoryHandler ? split.directories : [];
    if (files.length === 0 && directories.length === 0) return;

    const imageFiles = files.filter((file) => isImageFile(file));
    const nonImageFiles = files.filter((file) => !isImageFile(file));
    if (imageFiles.length > 0 && onImageFilesDropped) {
      onImageFilesDropped(imageFiles);
    } else if (imageFiles.length > 0 && onAttachmentsChange) {
      const base = attachments;
      void Promise.all(imageFiles.map(readImageAttachment)).then((newAttachments) => {
        onAttachmentsChange([...base, ...newAttachments]);
      });
    }

    if (directoryHandler && directories.length > 0) directoryHandler(directories, split.directoryEntries);
    // 只有文件夹时 nonImageFiles 为空 —— 文件通道对空载荷保持沉默,❌ 不发空数组。
    if (nonImageFiles.length > 0) onFilesDropped?.(nonImageFiles);
  };

  // ── Attachment removal ──────────────────────────────────────────────────────

  const removeAttachment = (id: string) => {
    const att = attachments.find((a) => a.id === id);
    if (att?.kind === 'image' && att.previewUrl?.startsWith('blob:')) {
      URL.revokeObjectURL(att.previewUrl);
    }
    onAttachmentsChange?.(attachments.filter((a) => a.id !== id));
  };

  // ── Model items ─────────────────────────────────────────────────────────────

  const modelItems: ComposerModelItem[] = modelOptions
    ? Object.entries(modelOptions).map(([id, opt]) => ({ id, ...opt }))
    : [];
  const selectedAgentItem =
    selectedAgent && agentOptions
      ? (agentOptions.find((a) => a.id === selectedAgent) ?? null)
      : null;
  const selectedAgentTitle = selectedAgentItem
    ? agentLocked && !hideLockedAgent
      ? `${selectedAgentItem.name} — agents can't be switched after a conversation starts`
      : selectedAgentItem.name
    : undefined;

  // ── Effort items ─────────────────────────────────────────────────────────────

  const effortItems: ComposerEffortItem[] = effortOptions
    ? Object.entries(effortOptions).map(([id, opt]) => ({ id, ...opt }))
    : [];

  // 面板的开合与「模型」行的归属只在这里决定一次 —— 判断长在 JSX 条件里就没法被判假,
  // 见 `resolveComposerModelPanel` 的注释(owner 2026-08-26「只有推理强度,反而没有模型」)。
  const modelPanel = resolveComposerModelPanel({
    modelCount: modelItems.length,
    effortCount: effortItems.length,
    unlock: Boolean(modelUnlock),
  });

  // ── Permission mode items ────────────────────────────────────────────────────

  const permissionModeItems: ComposerPermissionModeItem[] = permissionModeOptions
    ? Object.entries(permissionModeOptions).map(([id, opt]) => ({ id, ...opt }))
    : [];
  // 只在权限档是底排最左那一个时收紧内边距,让它和卡片左沿对齐。
  // harness/模型已经搬到右边,所以现在左边唯一可能排在它前面的是附件键。
  const permissionModeIsFirst = !onAttach;

  const canShowQueuedPrompts =
    queuedPrompts.length > 0 &&
    !!(onEditQueuedPrompt || onBeginEditQueuedPrompt) &&
    !!onDeleteQueuedPrompt &&
    !!onReorderQueuedPrompts &&
    !!onSendQueuedPromptNow;
  // The permission band takes priority over the notice band.
  const hasBand = !!(permissionRequest ?? notice);
  const receiveEditor = React.useCallback((handle: PromptEditorRef | null) => {
    editorRef.current = handle;
    if (typeof editorApiRef === 'function') editorApiRef(handle);
    else if (editorApiRef) (editorApiRef as React.MutableRefObject<PromptEditorRef | null>).current = handle;
  }, [editorApiRef]);

  const shouldHandleSubmitAttempt = !disabled && !queueEdit?.pending && (queueEdit ? true : isWorking ? !!onSubmitWhileWorking : canSubmit);
  const resolvedPlaceholder = disabled
    ? (disabledPlaceholder ?? translate('composer.sessionClosed'))
    : isWorking
      ? translate('composer.followUpPlaceholder')
      : (placeholder ?? translate('composer.messagePlaceholder'));

  const promptEditor = (
    <PromptEditor
      {...editorOptions}
      ref={receiveEditor}
      placeholder={resolvedPlaceholder}
      disabled={disabled || !!queueEdit?.pending}
      onChange={queueEdit ? changeQueueEdit : onInputChange}
      onPasteText={queueEdit ? undefined : handlePastedText}
      clearOnSubmit={queueEdit ? false : (editorOptions?.clearOnSubmit ?? true)}
      hostDropTypes={onDataDropped ? dataDropTypes : undefined}
      onSubmit={shouldHandleSubmitAttempt ? handleSubmit : undefined}
      onMentionInsert={onMentionInsert}
      mentionProvider={mentionProvider}
      renderMentionIcon={renderMentionIcon}
      queryMentions={queryMentions}
      queryCommands={queryCommands}
      onCommand={onCommand}
      getPromptHistory={queueEdit ? undefined : getPromptHistory}
    />
  );

  return (
    <div ref={rootRef} data-slot="composer" data-mobile={mobile || undefined} className={cx(styles.composerRoot, className)} onKeyDown={(event) => {
      if (queueEdit && event.key === 'Escape' && !event.defaultPrevented && !event.nativeEvent.isComposing && event.keyCode !== 229) {
        event.preventDefault(); finishQueueEdit(null);
      }
    }}>
      {canShowQueuedPrompts && (
        <QueuedPromptsBand
          prompts={queuedPrompts}
          renderPromptText={renderQueuedPromptText}
          onEdit={beginQueueEdit}
          editingId={queueEdit?.id}
          onDelete={onDeleteQueuedPrompt}
          onReorder={onReorderQueuedPrompts}
          onSendNow={onSendQueuedPromptNow}
        />
      )}

      {/* Permission band — shown when the agent is awaiting user approval. */}
      {permissionRequest && onResolvePermission && (
        <PermissionBand
          request={permissionRequest}
          queueCount={permissionQueueCount}
          onResolve={onResolvePermission}
        />
      )}

      {/* Notice band — height + opacity animate on enter/exit via the
          grid-rows 0fr↔1fr technique so add/remove transitions are smooth.
          Hidden when the permission band is active. */}
      {!permissionRequest && (
        <div
          className={cx(
            styles.noticeAnimWrapper,
            notice ? styles.noticeAnimVisible : styles.noticeAnimHidden
          )}
          aria-hidden={!notice}
        >
          <div className={styles.noticeOverflowClip}>
            {retainedNotice && <NoticeBand notice={retainedNotice} />}
          </div>
        </div>
      )}

      <div
        data-slot="composer-bar"
        data-drag-active={dragActive || undefined}
        className={styles.composerShell({ hasBand: !!hasBand, dragActive, tone })}
        onPaste={queueEdit ? undefined : handlePaste}
        onDragOver={queueEdit ? undefined : handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={queueEdit ? undefined : handleDrop}
      >
        {/* Attachment chips — anatomy vendored from assistant-ui (#5269), see composer-attachment-chip.tsx */}
        {!queueEdit && attachments.length > 0 && (
          <div data-slot="composer-attachments" className={styles.attachmentStrip}>
            {attachments.map((att) => (
              <ComposerAttachmentChip
                key={att.id}
                attachment={att}
                onView={onViewAttachment}
                onRemove={onAttachmentsChange ? removeAttachment : undefined}
                onRetry={onRetryAttachment}
              />
            ))}
          </div>
        )}

        {/* Editor area */}
        <div
          data-slot="composer-input"
          className={styles.editorArea}
          // @@@composer-click-target 的收尾:编辑器已经长满内容盒,只剩这块的**内距**接不到
          // 点击(padding 不属于任何子元素)。落在内距上的那一下在这里转成聚焦,光标停在
          // 上一次的位置。`preventDefault` 是必须的:不拦的话浏览器会把焦点收给这个 div
          // 自己,紧接着把刚给出去的焦点又抢回来。
          // 判 `e.target !== e.currentTarget` 才不会抢编辑器自己的点击(那一下要让
          // ProseMirror 原样处理,否则拖选、点某个字定位光标全废)。
          onMouseDown={(e) => {
            if (disabled) return;
            if (e.target !== e.currentTarget) return;
            e.preventDefault();
            editorRef.current?.focus();
          }}
        >
          {leading ? (
            <div className={styles.editorLeadRow}>
              <span className={styles.editorLead}>{leading}</span>
              <div className={styles.editorLeadBody}>{promptEditor}</div>
            </div>
          ) : promptEditor}
        </div>

        {/* Toolbar */}
        <div
          data-slot="composer-toolbar"
          data-disclosure={toolbarDisclosure.level}
          ref={toolbarDisclosure.ref}
          className={styles.toolbar}
        >
          {/* Left: attach + permission (Codex 版式:模型那一组归右边,见 toolbarRight) */}
          <div data-slot="composer-actions-start" className={styles.toolbarLeft}>
            {/* 附件在最左,用 + 而不是回形针 —— 这一格的语义是「往这条消息里加东西」,
                回形针窄化成了「附文件」。图标换了,行为没换,插的还是文件绝对路径的 @提及。 */}
            {onAttach && (
              <Button
                variant="ghost"
                // size 从 sm(1.5rem)长到 base(2rem):与同排触发器、发送键同高。
                size="base"
                icon
                className={styles.attachButtonRound}
                onClick={onAttach}
                disabled={disabled || !!queueEdit}
                aria-label={translate('composer.addAttachment')}
              >
                <Plus />
              </Button>
            )}
            {permissionModeItems.length > 0 && (
              <ComboboxPopover<ComposerPermissionModeItem>
                items={permissionModeItems}
                value={selectedPermissionMode ?? null}
                onValueChange={(id) => onPermissionModeChange?.(id)}
                itemToKey={(item) => item.id}
                itemToLabel={(item) => item.name}
                disabled={disabled}
                searchPlaceholder={translate('common.search')}
                className={permissionModeIsFirst ? styles.permissionModeTrigger : undefined}
                contentStyle={{ minWidth: '18rem' }}
                // 面板自己不留内距 —— 与模型/agent 面板同一族,见 @@@composer-panel-row。
                contentClassName={styles.composerPanelContent}
                // 底排不画下拉箭头 —— 见 composer-model-menu.tsx 的 @@@composer-no-chevron。
                // ComboboxPopover 自己画一枚,只有这一处关掉;另外 8 个消费方(设置页等)不受影响。
                hideChevron
                // 与模型面板同一族的行与搜索框 —— 见 @@@composer-panel-row。
                itemClassName={styles.composerPanelItem}
                searchLeftAddon={<Search />}
                renderTrigger={(selected) => (
                  <span
                    data-slot="composer-permission-mode"
                    data-permission-mode-id={selected?.id}
                    // 档 2 起名字被收掉、只剩图标:悬停时把名字说出来。
                    title={selected?.name ?? translate('composer.permissions')}
                    className={cx(
                      styles.permissionModeContent,
                      selected?.destructive && styles.permissionModeContentDestructive,
                    )}
                  >
                    {/* @@@composer-permission-icon — 图标**只在名字被收掉之后**才出现
                        (档 2 起,见 chat-composer.css.ts 里配对的 globalStyle)。

                        owner 2026-09-07:「感叹号图标也没必要」—— 档 0 名字就写着「完全访问」,
                        再挂一枚感叹号是把同一件事说两遍,而这一排最缺的就是横向空间。
                        危险性在档 0 由**文字颜色**承担(destructive 那条是橙的),不靠图标。

                        ❌ 但不能整枚删掉:档 2 起名字被藏,图标是这颗控件仅剩的身份 ——
                        删了那一档就是个空药丸。形状随危险性换(⚠ / 盾)而不只换色调:
                        余光里形状比色相好认,而这是底排唯一一个能造成破坏的控件。 */}
                    {selected?.destructive ? (
                      <CircleAlert
                        className={styles.permissionModeIcon}
                        style={{ width: '0.75rem', height: '0.75rem', flexShrink: 0 }}
                      />
                    ) : (
                      <ShieldCheck
                        className={styles.permissionModeIcon}
                        style={{ width: '0.75rem', height: '0.75rem', flexShrink: 0 }}
                      />
                    )}
                    <span className={styles.permissionModeLabel}>
                      {selected?.name ?? translate('composer.permissions')}
                    </span>
                  </span>
                )}
                renderItem={(item) => (
                  <div
                    className={styles.composerPanelItemText}
                    data-permission-mode-id={item.id}
                  >
                    <span className={styles.composerPanelItemName}>{item.name}</span>
                    {item.description && (
                      <span className={styles.composerPanelItemDesc}>{item.description}</span>
                    )}
                  </div>
                )}
              />
            )}
            {/* 外来控件(现在是「编程 | 通用」)要能按档位换形态,见 use-toolbar-disclosure。 */}
            <ToolbarDisclosureProvider value={toolbarDisclosure.level}>
              {toolbarExtra}
            </ToolbarDisclosureProvider>
          </div>

          {/* Right: usage donut + harness + model + send/stop */}
          <div data-slot="composer-actions-end" className={styles.toolbarRight}>
            {contextUsage && contextUsage.size > 0 && (
              <ContextUsageIndicator usage={contextUsage} disabled={disabled} />
            )}
            {/* Harness (agent) selector first, then model — owner-specified order: gugu wants
                the Harness picked explicitly first rather than folded into the model trigger's icon. */}
            {agentOptionsLoading && !agentOptions?.length && (
              <ComposerAgentLoading label={translate('composer.agent')} title={translate('composer.agentsLoading')} />
            )}
            {agentOptions && agentOptions.length > 0 && !(agentLocked && hideLockedAgent) && (
              <ComposerAgentSelector
                options={agentOptions}
                selectedId={selectedAgent}
                onSelect={(id) => onAgentChange?.(id)}
                onAction={(id) => onAgentAction?.(id)}
                locked={agentLocked}
                disabled={disabled}
                label={translate('composer.agent')}
                searchPlaceholder={translate('composer.searchAgents')}
                lockedLabel={selectedAgentItem
                  ? translate('composer.agentLocked', { agentName: selectedAgentItem.name })
                  : undefined}
                optionTestIdPrefix="composer-agent-option"
                searchTestId="composer-agent-search"
              />
            )}
            {/* 模型 + 推理强度:Codex 点开是一个两行折叠面板,不是铺开的模型列表 ——
                「模型」和「推理强度」结构对称,各自显示当前值并向右飞出二级。
                解剖与那批注释随组件一起搬去了 `composer-model-menu.tsx`(#4981 A1),
                渲染出来的 DOM 一个字节都没变。 */}
            <ComposerModelMenu
              panel={modelPanel}
              disabled={disabled}
              triggerTitle={selectedAgentTitle}
              modelItems={modelItems}
              selectedModel={selectedModel}
              onModelChange={onModelChange}
              openRequest={modelMenuOpenRequest}
              modelUnlock={modelUnlock}
              onModelUnlock={onModelUnlock}
              onManageModels={onManageModels}
              modelUpgrade={modelUpgrade}
              onModelUpgrade={onModelUpgrade}
              effortItems={effortItems}
              selectedEffort={selectedEffort}
              onEffortChange={onEffortChange}
              defaultEffort={defaultEffort}
            />

            {queueEdit ? (
              <>
                <Button type="button" variant="ghost" size="sm" disabled={!!queueEdit.pending}
                  onClick={() => finishQueueEdit(null)}>{translate('common.cancel')}</Button>
                <Button type="button" variant="primary" size="sm" disabled={disabled || !!queueEdit.pending || !queueEdit.text.trim()}
                  onClick={() => finishQueueEdit(editorRef.current?.getText() ?? '')}>{translate('common.save')}</Button>
              </>
            ) : showSubmitButton ? (
              isWorking ? (
                <Button
                  variant="primary"
                  tone="destructive"
                  size="base"
                  icon
                  // ❌ 停止键不套 sendButtonInk:停止是 destructive,红色是它在说
                  //    "这会中断正在跑的东西",不该被换成与正文同色的墨点。
                  className={styles.sendButtonRound}
                  data-composer-action="stop"
                  disabled={disabled || stopDisabled}
                  aria-busy={stopDisabled || undefined}
                  onClick={onStop}
                  aria-label={translate('composer.stopGeneration')}
                >
                  <span className={styles.stopIcon} aria-hidden="true" />
                </Button>
              ) : (
                <Button
                  variant="primary"
                  size="base"
                  icon
                  className={cx(styles.sendButtonRound, styles.sendButtonInk)}
                  onClick={() => handleSubmit(editorRef.current?.getText() ?? '')}
                  disabled={disabled || !canSubmit}
                  aria-label={translate('composer.sendMessage')}
                >
                  <ArrowUp />
                </Button>
              )
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
