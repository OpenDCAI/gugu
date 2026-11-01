import { readNativeOfflineDraft, writeNativeOfflineDraft } from '@/lib/nativeOfflineDraft';
import { useSessionInputAccount } from '@/lib/sessionInputOutboxBridge';
import { appendToDraft } from '@/store/chatContext';
import { registerNativeComposer } from '@/lib/nativeComposerHandoff';
import { useSessionSourceMessage } from './use-session-source-message';
import { canQueueNativeInput } from './queue-native-input';
import { useConversationVisibility } from '@/components/chat/useConversationVisibility';
import { useNativeConversationRead } from '@/hooks/useNativeConversationRead';
import { takeTaskReveal } from '@/hooks/useSourceMessageReveal';
import { UI_EVENTS } from '@/lib/uiEvents';
import { SessionInputQueue } from '@/components/chat/SessionInputQueue';
import { sessionLifeView } from '../stores/session-life-views';
import { lifeIsStarting } from '@shared/core/sessions/session-life';
import { NeedsYouSlot } from '@/components/needsYou/NeedsYouSlot';
import { takeComposerCarry, useComposerVerb } from '@/lib/composerVerbBridge';
import { useSessionMessageQuotes } from './use-session-message-quotes';
import { useSessionPromptEditor } from './use-session-prompt-editor';
import { continueSessionTurn } from './continue-session-turn';
import { projectGroupsStore } from '@renderer/features/projects/stores/project-groups-store';
import { SessionComposerVerbs, SessionVerbDock, sessionVerbKey } from '../session-verb-dock';
import type { AttachmentMimeType, AttachmentRef } from '@gugu/session-core/acp/client';
import { followConversationLink } from '@/lib/followConversationLink';
import { openMessageSender } from '@/lib/openMessageSender';
import { classifyFileLink } from '@gugu/core/shared/ui/guguLink';
import {
  AttachmentViewerDialog,
  MermaidViewerDialog,
  formatAttachmentSize,
  readAttachmentPreviewText,
} from '@gugu/session-ui/react/components';
import type {
  CommandItem,
  ComposerAgentOption,
  ComposerAttachment,
  ContextMentionProvider,
  MentionItem,
  PromptEditorRef,
} from '@gugu/session-ui/react/components';
import { autorun } from 'mobx';
import { observer, useObserver } from 'mobx-react-lite';
import { collectBackgroundCommands, collectSubagents } from '@renderer/features/sessions/view/background-task-rosters';
import { dismissSubagent } from '@renderer/features/sessions/view/subagent-dismissals';
import { useCallback, useContext, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { PageShownContext } from '@renderer/app/recent-session-pages';
import { nativeChatAppearance } from '@renderer/lib/chat/native-chat-appearance.css';
import { useMarkSeenWhenShown } from '@renderer/features/sessions/hooks/use-mark-seen-when-shown';
import { createPortal } from 'react-dom';
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator';
import { sessionRegistry } from '@renderer/features/sessions/stores/session-registry';
import { IntegrationIcon } from '@renderer/features/integrations/integration-icon';
import { useConnectedIssueProviders } from '@renderer/features/integrations/use-connected-issue-providers';
import { usePromptLibrary } from '@renderer/features/library/prompts/use-prompt-library';
import { asMounted, getProjectStore, getProjectViewStore } from '@renderer/features/projects/stores/project-selectors';
import { sessionNavigationFocus } from '@renderer/features/sidebar/session-navigation-focus';
import { usePaneContext } from '@renderer/features/tabs/pane-context';
// TODO(conversations-extraction): Inject task editor/file-opening behavior into ACP chat.
import {
  makeFileLinkHandlers,
  openFileBesideConversation,
  reopenSessionOutput,
} from '@renderer/features/sessions/stores/open-file-in-file-editor';
// TODO(conversations-extraction): Pass task state into ACP chat instead of importing task stores.
import {
  asProvisioned,
  getRegisteredSessionData,
  getSessionPageStore,
} from '@renderer/features/sessions/stores/session-selectors';
import {
  chatMentionProvider,
  clearLocalSessionMentions,
  issueMentionToken,
  parseIssueMentionToken,
} from '@renderer/lib/chat/chat-mention-provider';
import { AgentConversationView as ChatTranscript, AgentConversationComposer as ChatComposer } from '@renderer/lib/chat/agent-conversation-view';
import { useSessionChatLayout } from '@renderer/lib/chat/use-session-chat-layout';
import type { ChatCommands, ChatView } from '@renderer/lib/chat/chat-transcript';
import { AgentIcon } from '@renderer/lib/components/agent-icon';
import {
  agentGroupLabel,
  sortAgentsByAvailability,
} from '@renderer/lib/components/agent-availability-groups';
import { toast } from '@renderer/lib/hooks/use-toast';
import { useNavigate } from '@renderer/lib/layout/navigation-actions';
import type { SessionCondition as ChatSessionCondition } from '@gugu/session-chat-ui';
import { rpc, rpcOn } from '@renderer/lib/ipc';
import { nudgeWorkspace } from '@renderer/features/sessions/stores/workspace-nudges';
import { machineLabel } from '@renderer/lib/machine-clients';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { isEmbedVisible } from '@renderer/lib/portal-container';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { platformModelIdFromRuntimeOption, platformOptionId } from '@/session/shared/platform-model-id';
import { openComposerImage, openImageViewer } from '@/lib/imageViewer';
import { showModal, useShowModal } from '@renderer/lib/modal/modal-provider';
import { resolveSignInTarget } from '@renderer/features/settings/agents-page/agent-account';
import { formatBytes } from '@renderer/utils/formatBytes';
import { composePromptText, fileMentionsFor } from './composer-file-paths';
import {
  droppedImageRefs,
  enqueueImageAttachment,
  imageAttachmentRoute,
  imagePromptAttachments,
} from './composer-image-attachments';
import { isHeicLikeFile, mustCopyRatherThanReference } from '@renderer/lib/pty/terminal-image-paths';
import { droppedDirectoryMention } from '@renderer/lib/drag-files';
import { pathAttachmentTarget } from '@gugu/session-chat-ui/markdown-attachment-mentions';
import { readMermaidTheme } from '@gugu/session-chat-ui/mermaid';
import { composerAttachmentSource } from './composer-attachment-source';
import { SessionScheduleChip } from '../session-schedule-chip';
import { sessionComposerFrameLiftClassName, sessionComposerTrayClassName, sessionComposerTrayStyle } from '../session-composer-styles';
import { useSessionSchedules } from '@renderer/features/automations/use-session-schedules';
import { toComposerPermission } from './composer-permission';
import { useHostAskBand } from '@renderer/features/extensions/use-session-host-ask';
import { SessionHostQuestion } from '@renderer/features/extensions/session-host-question';
import { uploadComposerAttachment, type AttachmentUploadRpc, type UploadSource } from './composer-file-upload';
import { useComposerFileUploads } from './use-composer-file-uploads';
import { entryUploadItems, type DropEntry } from '@renderer/features/remote-hosts/workspace/remote-drop-items';
import { useAgents } from '@renderer/lib/stores/use-agents';
import { ThreadScrollToBottom } from '@renderer/lib/ui/assistant-ui/thread-scroll-to-bottom';
import {
  ThreadWelcome,
  type ThreadSuggestion,
} from '@renderer/lib/ui/assistant-ui/thread-welcome';
import { log } from '@renderer/utils/logger';
import { agentSteersActiveAcpTurn } from '@shared/core/agents/agent-payload';
import { linkedIssueMentionName, type LinkedIssue } from '@shared/core/linked-issue';
import type { AcpChatStore, AcpPromptAttachment } from './acp-chat-store';
import {
  detachedPermissionModeOptions,
  localizePermissionModeOptions,
  sessionPermissionModeOptions,
  selectedPermissionModeId,
} from './permission-mode-options';
import { resolveVisualEvidenceAttachmentDataUrl } from './acp-chat-resource-manager';
import { useOpenedOutputMenu } from './opened-output-menu';
import type { AcpChatTabResource } from './acp-chat-tab-resource';
import { chatViewCommandForShortcut, executeChatViewCommand } from './acp-chat-view-commands';
import {
  effortSourceFor,
  localizeEffortOptions,
  platformEffortFacts,
  resolveEffortCatalog,
} from '@renderer/features/sessions/session-config/effort-options';
import {
  composerModelSelection,
  composerModelFooter,
  composerSelectedOptionId,
  useComposerModelOptions,
  openMembershipPage,
} from '@renderer/features/sessions/session-config/use-composer-model-options';
import { ownModelTierOptions } from '@renderer/features/sessions/session-config/own-model-tier';
import { harnessCatalogToOptions } from '@renderer/features/sessions/session-config/harness-model-field';
import {
  refreshPlatformModelCatalogs,
  usePlatformModelCatalog,
} from '@renderer/features/sessions/session-config/platform-model-catalog';
import { failureReason, failureText, guguReasonCopy, guguReasonText, reasonActions } from '@renderer/features/sessions/gugu-reason';
import { askPlatformAgain } from '@renderer/features/sessions/platform-retry';
import { guguReasonOf } from '@gugu/session-core/session-record/contract';
import { sessionBillingRoute, runningPlatformModelId } from '@renderer/features/sessions/session-config/platform-model-selection';
import { planModelSwitch } from '@renderer/features/sessions/session-config/model-switch-plan';
import { findSessionHostBridge } from '@renderer/lib/electron-api';
import { SessionReloadConfirm } from '@renderer/features/sessions/session-reload-confirm';
import { requestSendQueuedPromptNow } from './send-queued-prompt-now-flow';
import { requestSessionReload } from '@renderer/features/sessions/request-session-reload';
import {
  confirmReasonFor,
  reloadRequestFor,
  type RestartTarget,
} from '@renderer/features/sessions/pending-setting-restart';
import {
  McpSessionPanelAdapter,
  type McpSessionPanelAdapterServer,
  type McpSessionPanelAdapterSkill,
} from '@renderer/features/mcp/components/mcp-session-panel-adapter';
import { GUGU_CLIENT_COMMAND_MCP, isGuguClientCommand } from '@gugu/session-core/acp/commands';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { useBoundChatView } from './use-bound-chat-view';
import { useLastTurnSignInRequired } from './use-last-turn-sign-in';
import { useAgentAuthStatus } from '@renderer/lib/stores/use-agent-auth-status';
import { isAuthExpired } from '@renderer/lib/stores/harness-auth-expiry';
import { forceRefreshHarnessModelCatalog, useHarnessModelCatalog } from '@renderer/lib/stores/use-harness-model-catalog';
import { harnessModelCredentialKey } from '@renderer/lib/stores/use-harness-model-credential';
import { useQueryClient } from '@tanstack/react-query';
import { filterSlashCommands } from './slash-command-matching';
import { startupPlaceholderKey } from './startup-placeholder';
import { FindBar } from '@renderer/lib/ui/find-bar';
import { useFindBar, type FindBackend } from '@renderer/lib/ui/use-find-bar';
import { enUSMessages, type SessionMessageKey } from '@renderer/localization/messages';
import type { InterruptedBy } from '@shared/core/sessions/sessions';
import {
  createLocalSessionMentionProvider,
} from '@renderer/lib/chat/local-session-mention-provider';
import { useSessionAgentCreationTools } from '@renderer/lib/chat/use-session-agent-creation-tools';
import { useSessionMentionDrop } from '@renderer/lib/chat/use-session-mention-drop';
import { getDraggedScreenContent } from '@renderer/lib/drag-screen-content';

// ── Helpers ───────────────────────────────────────────────────────────────────

const attachmentDataUrlCache = new Map<string, Promise<string | null>>();
/** `/mcp` 这条自有命令的匹配 —— 与 agent 命令同一口径:空查询全列,否则按名字包含。 */
function commandMatchesClientQuery(normalized: string): boolean {
  return normalized.length === 0 || 'mcp'.includes(normalized);
}
const ISSUE_SEARCH_MIN_LENGTH = 2;
const ISSUE_SEARCH_LIMIT = 20;
/** 空态最多摆几个建议芯片 —— 再多就成了一堵墙,而空态要的是「开个头」。 */
const WELCOME_SUGGESTION_LIMIT = 3;

function promptPreview(text: string): string {
  return text.split(/\r?\n/, 1)[0] ?? '';
}

function declaredMessageKey(key: string | null | undefined): SessionMessageKey | undefined {
  if (!key) return undefined;
  if (!Object.prototype.hasOwnProperty.call(enUSMessages, key)) {
    throw new Error(`ACP startup notice '${key}' is not present in the session message catalog`);
  }
  return key as SessionMessageKey;
}

function toIssueMentionItem(issue: LinkedIssue): MentionItem {
  const token = issueMentionToken(issue.provider, issue.identifier);
  return {
    id: token,
    label: token,
    name: linkedIssueMentionName(issue),
    kind: 'issue',
    description: issue.title,
    icon: <IntegrationIcon provider={issue.provider} size={13} />,
  };
}

function issueMatchesQuery(issue: LinkedIssue, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [issue.identifier, issue.displayIdentifier, issue.title]
    .filter((value): value is string => !!value)
    .some((value) => value.toLowerCase().includes(normalized));
}

const supportedAttachmentMimeTypes = new Set<AttachmentMimeType>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);
const attachmentMimeTypeByExtension: Record<string, AttachmentMimeType> = {
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

function toAttachmentMimeTypeValue(value: string): AttachmentMimeType | null {
  const mimeType = value.toLowerCase();
  return supportedAttachmentMimeTypes.has(mimeType as AttachmentMimeType)
    ? (mimeType as AttachmentMimeType)
    : null;
}

function toAttachmentMimeType(file: File): AttachmentMimeType | null {
  const declaredMimeType = toAttachmentMimeTypeValue(file.type);
  if (declaredMimeType) return declaredMimeType;
  const extension = file.name.split('.').pop()?.toLowerCase();
  return extension ? (attachmentMimeTypeByExtension[extension] ?? null) : null;
}

function readFileAsDataUrl(file: File): Promise<string | undefined> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : undefined);
    reader.onerror = () => resolve(undefined);
    reader.readAsDataURL(file);
  });
}

/**
 * #6264 会话在别的机器上:这台电脑上的原路径那台机器上没有 —— 只传字节,❌ 把本机路径当 mention / 来历交过去
 * (agent 会去那台机器上找一个不存在的文件)。
 */
function localPathOf(store: AcpChatStore, file: File): string {
  return machineRegistry.machineOf(store.projectId) ? '' : electronApi().getPathForFile(file).trim();
}

/**
 * 「正文里给一条绝对路径」这条路的附件,那条路径从哪儿来(#5269)。
 *
 * 字节**存一份在我们自己的地盘**(`<userData>/task-attachments/<conversationId>/`,库里记一行挂任务外键),
 * ❌ 不再落进 `$TMPDIR`:那是一次投递的传输缓冲,退出即清、24 小时扫,而消息里的 mention 会
 * 长期指着它 —— 传输方式当了记录,历史消息里的附件就迟早点不开。顺带地 userData 本来就在
 * home 里,所以「点开附件」那一下不需要给任何一道闸开口子。
 *
 * ⚠️ **拖进来的也存一份**(owner 2026-09-10)。只记指向的话,那件东西同时依赖「原文件还在不在」
 * 与「它在不在 home 里」——home 之外 `openPath` 直接判死,点开就是「打不开」。原路径不丢:
 * 它随这一件记进库,只决定**发给 agent 的 mention 指向谁**(用户拖文件进来往往是想让 agent
 * 就地改它);显示与点开一律走副本。
 *
 * #6264 字节贴上来就开始一块块传到会话所在的机器(本机会话就是本机),进度在 chip 上。
 */
function fileUploadSource(store: AcpChatStore, file: File): UploadSource {
  const rawPath = localPathOf(store, file);
  // 这一格只回答「有没有一条**稳定的**原路径可以给 agent」——❌ 不决定要不要拷贝(一律存一份)。
  const originalPath =
    composerAttachmentSource({
      originalPath: rawPath,
      mustCopy: mustCopyRatherThanReference(rawPath),
      isHeicLike: isHeicLikeFile(file),
    }) === 'reference'
      ? rawPath
      : undefined;
  return {
    kind: 'file',
    name: file.name || 'attachment',
    ...(file.type ? { mimeType: file.type } : {}),
    ...(originalPath ? { originalPath } : {}),
    size: file.size,
    slice: async (start, end) => new Uint8Array(await file.slice(start, end).arrayBuffer()),
  };
}

/**
 * 把一个图片文件推上 ACP 会话。只管上传,不管 UI:调用方(`addImageFiles`)在调用**前**
 * 就把 chip 以 `uploading` 态挂上条,这里返回的 ref 再把它翻成 `done`,失败翻 `error`(#5269)。
 * 传输层没有进度回调,所以 chip 只转圈、不画进度条。
 */
async function uploadImageFile(
  store: AcpChatStore,
  file: File,
  mimeType: AttachmentMimeType,
  options: { signal?: AbortSignal; uploadId: string; onProgress: (progress: { sent: number; total?: number }) => void }
): Promise<AttachmentRef | null> {
  // 字节一律存一份 —— ❌ 不再「有原路径就只记指向」。那条记录会随着用户挪走/删掉那个文件
  // 当场作废,而消息里那张图要长期画得出来(#5269,owner 2026-09-10 拍板)。
  // 原路径仍然交上去,但只当来历:发给 agent 的 mention 指向谁由另一条腿决定。
  const originalPath = localPathOf(store, file);
  const provenance =
    originalPath.length > 0 && !mustCopyRatherThanReference(originalPath) && !isHeicLikeFile(file)
      ? originalPath
      : undefined;
  return store.uploadAttachment({
      ...options,
      source: file.stream(),
      size: file.size,
      mimeType,
      name: file.name,
      ...(provenance ? { originalPath: provenance } : {}),
    });
}

function resolveAttachmentDataUrl(store: AcpChatStore, id: string): Promise<string | null> {
  const fixtureDataUrl = resolveVisualEvidenceAttachmentDataUrl(store, id);
  if (fixtureDataUrl) return Promise.resolve(fixtureDataUrl);
  // 正文里那条绝对路径投影出来的附件(#5269):字节在盘上,不在 agent 的附件仓里。
  // 首轮(新建会话页)只能这么送,所以这一支不接的话,那一张图永远画不出来。
  const path = pathAttachmentTarget(id);
  if (path) {
    const cachedPath = attachmentDataUrlCache.get(id);
    if (cachedPath) return cachedPath;
    // ⚠️ mention 指着的是**用户那个文件**(agent 要改的就是它),显示却不能跟着走那条路:
    // 它依赖「文件还在不在」和「在不在 home 里」两件我们管不了的事。先问一句有没有副本。
    const promise = rpc.sessionCreate
      .resolveAttachmentPath(store.sessionId, path)
      // 字节在会话所在的那台机器上(别的机器上的会话 = 问那台机器)。
      .then((resolved) =>
        rpcOn(machineRegistry.machineOf(store.projectId)).app.readUserImageDataUrl(resolved.success ? resolved.data : path)
      )
      .then((result) => (result.success ? result.dataUrl : null))
      .catch((error: unknown) => {
        // 读不到就退回中性占位块(旧消息里那些指着临时目录的路径就是这种)——❌ 不弹错。
        log.warn('Failed to read attachment image', { path, error });
        return null;
      });
    attachmentDataUrlCache.set(id, promise);
    return promise;
  }
  if (!store.session) return Promise.resolve(null);
  const cached = attachmentDataUrlCache.get(id);
  if (cached) return cached;
  const promise = store.session
    .downloadAttachment(id)
    .then((result) => {
      if (!result.success) return null;
      return `data:${result.data.ref.mimeType};base64,${bytesToBase64(result.data.data)}`;
    })
    .catch((error: unknown) => {
      log.warn('Failed to resolve ACP attachment', { id, error });
      return null;
    });
  attachmentDataUrlCache.set(id, promise);
  return promise;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

// ── Composer for a single store ────────────────────────────────────────────────
//
// Keyed by conversationId in the parent so that drafts, focus, and editor state
// reset when switching conversations — the same isolation the old remount gave.

const ComposerForStore = observer(function ComposerForStore({
  store,
  editorApiRef,
  composerSlot,
  onViewAttachment,
  onScrollToBottom,
  modelMenuRequest,
  onMembershipLockChange,
}: {
  store: AcpChatStore;
  editorApiRef: RefObject<PromptEditorRef | null>;
  composerSlot: HTMLElement;
  /** 面板要把模型菜单打开(「这个模型要会员」那一行上的「换模型」):每变一次开一次。 */
  modelMenuRequest: number;
  /** 这条会话正在用的咕咕模型要开会员了(#7056):报给面板,由它挂那一行条件。null = 没有。 */
  onMembershipLockChange: (lock: { modelName: string } | null) => void;
  /** 点开一枚附件 chip 看里面是什么(#5269)。图片看图,文本看内容。 */
  onViewAttachment: (att: ComposerAttachment) => void;
  /** Keep a newly sent prompt or stop result visible in the transcript. */
  onScrollToBottom?: () => void;
}) {
  const { translate } = useSessionMessages();
  const life = sessionLifeView(store.runtimeSessionId);
  // 这个任务给自己排的定时:有就在输入框上沿挂一条托盘放那颗芯片,输入框往上压住它的下沿(与芯片读同一份缓存)。
  const scheduleMachine = machineRegistry.machineOf(store.projectId);
  const schedules = useSessionSchedules(scheduleMachine, store.sessionId);
  // gugu-dev#181 ⑫ 在会话里也能派:项目里的会话,卡落项目群;没有项目的会话(就是和这个 agent 的私聊),卡落那个私聊。
  const groupChatId = projectGroupsStore.chatIdOf(store.projectId);
  const verb = useComposerVerb(sessionVerbKey(store.sessionId));
  // 点了新任务框标签上的 ×:那一框写的话交回这里(composerVerbBridge 的 carry)。
  useEffect(() => {
    const back = verb ? '' : takeComposerCarry(sessionVerbKey(store.sessionId));
    if (back) store.setDraftText(back);
  }, [verb, store]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [attachments, setAttachmentState] = useState<ComposerAttachment[]>([]);
  const attachmentsRef = useRef(attachments);
  // 发送等待的是上传 promise;账本必须在它 resolve 前更新,不能等 React 的下一次渲染。
  const setAttachments = useCallback((update: ComposerAttachment[] | ((prev: ComposerAttachment[]) => ComposerAttachment[])) => {
    const next = typeof update === 'function' ? update(attachmentsRef.current) : update;
    attachmentsRef.current = next;
    setAttachmentState(next);
  }, []);
  // 非图片文件到达 agent 的路是**正文里的绝对路径**(ACP 的附件上传只收图片)。但那是传输方式,
  // 不该摆到用户脸上 —— 屏幕上和图片一样是一枚 chip,路径发送时才拼进正文(#5269,与新建任务
  // 页那一半同构)。id → 路径的账在这儿记,chip 被 × 掉时跟着删。
  const filePathsRef = useRef(new Map<string, string>());
  // 图片 chip 的 id 是**本地的、终身不变的**,服务端 ref 记在这张表里。⚠️ 曾经的写法是「上传完把
  // chip 的 id 换成 ref.id」,那让每一个按 id 打的异步补丁都变成一场赛跑:预览图那条(FileReader)
  // 只要比上传慢,补丁就落在一个已经不存在的 id 上,静默丢掉。而这条赛道是**有偏的** —— 文件带
  // 磁盘路径时上传只是把路径递过去,快到必赢,于是「从访达拷来的图」必然没有缩略图、点开预览也是
  // 空的(#5269,owner 2026-09-08 实撞)。id 不动,顺序就不再是判据。
  const imageRefsRef = useRef(new Map<string, AttachmentRef>());
  const imageUploadsRef = useRef(new Map<string, AbortController>());
  useEffect(() => {
    const uploads = imageUploadsRef.current;
    return () => { for (const controller of uploads.values()) controller.abort(); uploads.clear(); };
  }, []);
  // 文件 / 文件夹 chip:贴上来就开始传到会话所在的机器,进度在 chip 上(#6264,product spec)。
  const fileUploads = useComposerFileUploads({
    sessionId: () => store.sessionId,
    deviceLabel: () => {
      const machine = machineRegistry.machineOf(store.projectId);
      return machine ? (remoteHostsStore.device(machine)?.label ?? machine) : null;
    },
    setAttachments,
    onUploaded: (chipId, committed) => filePathsRef.current.set(chipId, committed.mentionPath),
    translate,
  });
  // 图片 chip 的上传(ACP 附件 + 存一份)还没回来的那几件 —— 发送时同样要等。
  const pendingImagesRef = useRef(new Set<Promise<unknown>>());
  /** 发送时附件还没传完:在等(发送键禁用、输入框上方一句话);有一件没成:不发,说一句。 */
  const [sendHold, setSendHold] = useState<'waiting' | 'blocked' | null>(null);
  const sendingRef = useRef(false);
  const promptEditor = useSessionPromptEditor(store, editorApiRef);
  const { value: promptLibrary } = usePromptLibrary();

  // Autofocus when the slot becomes available — only while the session page is on screen. 宿主把它常驻挂载在
  // 对话页后面(隐藏);启动时恢复会话在后台挂上这里,抢走对话页输入框的焦点,用户打的字进了看不见的这一格。
  const shouldAutoFocus = sessionNavigationFocus.focusLayer !== 'nav';
  useEffect(() => {
    if (!shouldAutoFocus || !isEmbedVisible()) return;
    editorApiRef.current?.focus();
  }, [shouldAutoFocus]);

  useEffect(() => {
    const editor = editorApiRef.current;
    if (!editor || store.queuedPromptEdit || editor.getText() === store.draftText) return;
    editor.setText(store.draftText);
  }, [store, store.draftText, store.queuedPromptEdit?.id]);

  /**
   * 发出去。附件还在传就先等(product spec:发送时还没传完就等它传完再发);有一件失败就不发,
   * 那一件的 chip 上写着为什么、能重试。正文在等的时候留在输入框里,❌ 先清掉再说。
   */
  const sendWhenReady = useCallback(
    async (value: string, deliver: (text: string, attachments: AcpPromptAttachment[]) => void | Promise<void>) => {
      if (sendingRef.current) return;
      sendingRef.current = true;
      try {
        // 没有还在传的就当场发(❌ 每次发送都闪一下「在等」)。
        if (fileUploads.unsettled() || pendingImagesRef.current.size > 0) {
          setSendHold('waiting');
          await fileUploads.waitForUploads();
          await Promise.all([...pendingImagesRef.current]);
        }
        const failed = fileUploads.unsettled() || attachmentsRef.current.some((att) => att.state === 'error');
        setSendHold(failed ? 'blocked' : null);
        if (failed) {
          // 输入框在交出正文时已经自己清空了:没发出去就把话放回去,❌ 让人重打一遍。
          editorApiRef.current?.setText(value);
          return;
        }
        const current = attachmentsRef.current;
        const promptAttachments = imagePromptAttachments(current, imageRefsRef.current);
        const text = composePromptText(value, fileMentionsFor(current, filePathsRef.current));
        if (!text && promptAttachments.length === 0) return;
        try { await deliver(text, promptAttachments); } catch { editorApiRef.current?.setText(value); return; }
        setAttachments([]);
        filePathsRef.current.clear();
        imageRefsRef.current.clear();
        fileUploads.clear();
        editorApiRef.current?.clear();
        // 滚到哪由 store 定(发出即把这一句钉到顶):这里再滚一次到旧的底,会和那一钉抢,视图先滑回上一轮再跳回来。
      } finally {
        sendingRef.current = false;
      }
    },
    [fileUploads, store]
  );

  const handleSubmit = useCallback(
    // The store's one send entry (custody; it toasts a failure); a send that cannot be kept goes back in the draft below.
    (value: string) => sendWhenReady(value, (text, attachments) => store.submitPrompt(text, attachments)),
    [store, sendWhenReady]
  );

  // While a turn runs the host queues the input behind it: the same custody path, nothing page-side.
  const handleSubmitWhileWorking = handleSubmit;

  const handleStop = useCallback(() => {
    onScrollToBottom?.();
    store.stop();
  }, [onScrollToBottom, store]);

  // D-31 The host's ask for this agent (an App install) is the session timeline's, not the runtime's: shown first — read only
  // while the session waits on an approval.
  const hostSession = sessionRegistry.get(store.sessionId)?.sessions.get(store.sessionId);
  const hostBand = useHostAskBand(store.runtimeSessionId, hostSession);
  const resolveHostAsk = hostBand?.resolve;
  const permissionRequest =
    hostBand?.request ?? toComposerPermission(store.permissionQueue[0], translate, (id) => store.hasActiveToolCall(id));
  const permissionRequestId = permissionRequest?.requestId;
  const handleResolvePermission = useCallback(
    (optionId: string | null) => {
      if (resolveHostAsk) {
        resolveHostAsk(optionId);
        return;
      }
      if (!optionId || !permissionRequestId) return;
      store.resolvePermission(permissionRequestId, optionId);
    },
    [store, permissionRequestId, resolveHostAsk]
  );


  /**
   * 权限档 / 思考档 —— 与模型那一维**不同**:它们不需要事前预判。
   *
   * 模型必须在调用**之前**判出「热不了」(活会话对不在清单里的模型当场拒),所以那一维有
   * `planModelSwitch`。这两维的答案是**运行时自己送回来的**(`restart_required`)——
   * ⇒ 不是它们比模型简单,是**它们的信息到得更早**。所以这里没有、也不该有第二套预判。
   *
   * ## ⚠️ 为什么这里**没有**接一条「确认+重启」
   *
   * #5556 那句「必须先重启会话」出在这两维上,而根因不是缺一条重启线 —— 是 pi 的声明写错了:
   * 那两维**本来就能热改**(2026-09-13 裸 ACP 实测:同一条活会话逐档设、下一轮上游载荷里的
   * `reasoning_effort` 跟着变且可逆)。声明改对之后,`restart_required` 在这两维上**到不了**。
   *
   * 而全仓声明 `reload-session` 的只有**模型**那一维(qwen,#6182 实测;pi 那一格已量成热的),
   * 那一维由 `planModelSwitch` 那条确认+重启接好了。⇒ 给这两维再造一套「确认框 + 把目标值带进新会话」的机制,
   * 今天**没有任何触发得到它的路径**,那是拿复杂度换零行为。
   * 判据 `pi/acp.test.ts` 钉住这件事:哪天有人把这两维声明回 `reload-session`,它会红,
   * 并把人指到这里。
   *
   * ⇒ 所以万一它真的到了(声明漂了),这里**响亮报错并说出是哪一维**,
   * ❌ 不再弹那句「必须先重启会话」—— 那句话点不到任何东西,正是 #5556 本身。
   */
  const reportUnwiredRestart = useCallback(
    (dimension: 'permission' | 'effort', requestedValue: string) => {
      showModal('confirmActionModal', {
        title: translate('chat.settingRestartUnwiredTitle'),
        description: translate('chat.settingRestartUnwiredBody', {
          dimension,
          target: requestedValue,
        }),
        confirmLabel: translate('common.close'),
        onSuccess: () => undefined,
      });
    },
    [showModal, translate]
  );

  const handleModeChange = useCallback(
    (modeId: string) => {
      void store.setMode(modeId).then((outcome) => {
        if (outcome?.kind !== 'restart-required') return;
        reportUnwiredRestart('permission', outcome.requestedValue);
      });
    },
    [store, reportUnwiredRestart]
  );

  const handleAttach = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  /**
   * 走「正文里的绝对路径」这条路的附件。非图片文件一直走它(ACP 的附件上传只收图片);
   * 图片在 agent 没声明收图时也降级到这里 —— 那时 chip 的 meta 会写明它是以路径发出去的。
   */
  const attachPathFiles = useCallback(async (files: File[]) => {
    for (const file of files) {
      // ⚠️ ❌ 不要退回 `getPathForFile` 一条路:**粘贴进来的文件在磁盘上没有路径**(拖进来的才有)。
      // 字节一律传一份到会话所在的机器(贴上来就开始传,进度在 chip 上);用户读的名字是 `file.name`,
      // ❌ 不从盘上的路径反推 —— 从前正是这一步把 `gugu-drop-<uuid>-` 漏到了用户脸上。
      const isImage = file.type.toLowerCase().startsWith('image/');
      const chip: ComposerAttachment = {
        id: `path:${crypto.randomUUID()}`,
        name: file.name || 'attachment',
        kind: isImage ? 'image' : 'file',
        mimeType: file.type,
      };
      if (isImage) {
        const previewUrl = await readFileAsDataUrl(file);
        if (previewUrl) chip.previewUrl = previewUrl;
      } else {
        // 文本类附件的内容在入列时读一份,chip 点开看的就是它(#5269)。
        const preview = await readAttachmentPreviewText(file);
        if (preview) {
          chip.previewText = preview.text;
          chip.previewTruncated = preview.truncated;
        }
      }
      void fileUploads.add(chip, fileUploadSource(store, file)).then((ok) => {
        // 图片走这条路是**降级**,得让人看得见为什么 —— ❌ 不要装作和上传一样。
        if (ok && isImage) {
          setAttachments((prev) =>
            prev.map((att) =>
              att.id === chip.id ? { ...att, meta: `${formatBytes(file.size)} · ${translate('composer.attachmentAsPath')}` } : att
            )
          );
        }
      });
    }
  }, [store, translate, fileUploads]);

  /**
   * #6264 拖进来的文件夹。本机会话:落成正文里一条路径 pill(文件夹就在这台电脑上,agent 就地读)。
   * 会话在别的机器上:这条路径那边没有 —— 整个文件夹当一件附件传过去,正文里给那台机器上的路径(照 VS Code)。
   */
  const attachDirectories = useCallback(
    async (files: File[], entries: FileSystemDirectoryEntry[]) => {
      if (!machineRegistry.machineOf(store.projectId)) {
        for (const file of files) {
          const mention = droppedDirectoryMention(file);
          if (mention) editorApiRef.current?.insertMention(mention);
        }
        return;
      }
      for (const entry of entries) {
        const pieces = await entryUploadItems(entry as unknown as DropEntry);
        const chip: ComposerAttachment = {
          id: `path:${crypto.randomUUID()}`,
          name: entry.name,
          kind: 'file',
          mimeType: 'inode/directory',
        };
        void fileUploads.add(chip, { kind: 'folder', name: entry.name, pieces });
      }
    },
    [store, fileUploads]
  );

  const addImageFiles = useCallback(
    async (files: File[]) => {
      // 这家 agent 有没有声明它收图片?没有就别把 image 块发过去 —— 收不下的一端是**静默**
      // 丢掉的(#5269)。降级成一条绝对路径:内容仍到得了 agent,而且降级写在 chip 上。
      if (imageAttachmentRoute(store.acceptsImagePrompts) === 'path') {
        await attachPathFiles(files);
        return;
      }
      const supportedFiles = files.filter((file) => toAttachmentMimeType(file) !== null);
      if (supportedFiles.length < files.length) {
        const unsupportedNames = files
          .filter((file) => toAttachmentMimeType(file) === null)
          .map((file) => file.name || translate('chat.unnamedImage'))
          .join(', ');
        toast({
          title: translate('chat.unsupportedImageTitle'),
          description: translate('chat.unsupportedImageDescription', { names: unsupportedNames }),
          variant: 'destructive',
        });
      }

      // 一枚 chip 的全过程(上条 → 预览图 → 上传 → done/error)在 `composer-image-attachments.ts`
      // 里,那儿有判据;这里只把宿主那几件东西递进去。
      await Promise.all(
        supportedFiles.map(async (file) => {
          const chipId = `image:${crypto.randomUUID()}`;
          const controller = new AbortController();
          imageUploadsRef.current.set(chipId, controller);
          // ⚠️ **每一张图都在我们自己的地盘留一份,并且在正文里留一条指向它的引用** ——
          // 这是消息里看得见它的唯一依据(#5269)。ACP 上传只决定「这一轮 agent 收不收得到
          // 图片块」,❌ 不决定这条消息以后还看不看得见那张图:上传上去的那一份活在 agent 的
          // 会话里,重启之后 replay 不回来,于是缩略图消失(owner 2026-09-10 实撞:第一条消息
          // 的图在、第二条的没了 —— 两条路两种寿命)。
          // 两条路因此产出**同一种表示**:正文里的引用。区别只剩「要不要额外发一个图片块」。
          const persisted = uploadComposerAttachment({
            rpc: rpc.sessionCreate as unknown as AttachmentUploadRpc,
            sessionId: store.sessionId,
            uploadId: crypto.randomUUID(),
            source: fileUploadSource(store, file),
            signal: controller.signal,
          }).then(
            (committed) => {
              if (controller.signal.aborted) return false;
              filePathsRef.current.set(chipId, committed.mentionPath.trim().replace(/\\/g, '/'));
              return true;
            },
            (error: unknown) => {
              log.warn('Failed to persist composer attachment', { name: file.name, error });
              return false;
            }
          );
          const both = Promise.all([
            persisted,
            enqueueImageAttachment(file, toAttachmentMimeType(file) ?? 'image/png', {
              chipId,
              update: (updater) => setAttachments(updater),
              readPreview: readFileAsDataUrl,
              signal: controller.signal,
              fallback: {
                available: persisted,
                meta: `${formatAttachmentSize(file.size)} · ${translate('composer.attachmentAsPath')}`,
              },
              upload: (source, mimeType, options) => uploadImageFile(store, source, mimeType, options),
              onRetry: (error) => log.warn('Retrying stalled ACP attachment upload', { name: file.name, error }),
              onFailure: (error) => log.warn('Failed to prepare ACP attachment upload', { name: file.name, error }),
              rememberRef: (id, ref) => imageRefsRef.current.set(id, ref),
              labels: {
                uploading: translate('composer.attachmentUploading'),
                failed: translate('composer.attachmentUploadFailed'),
                retrying: translate('composer.attachmentRetrying'),
              },
              formatSize: formatAttachmentSize,
            }),
          ]);
          pendingImagesRef.current.add(both);
          try {
            await both;
          } finally {
            pendingImagesRef.current.delete(both);
            imageUploadsRef.current.delete(chipId);
          }
        })
      );
    },
    [store, translate, attachPathFiles]
  );

  const composerShown = useContext(PageShownContext);
  const inputAccount = useSessionInputAccount();
  useEffect(() => {
    if (!composerShown) return;
    const machine = machineRegistry.machineOf(store.runtimeSessionId);
    const kept = readNativeOfflineDraft(machine, store.runtimeSessionId);
    if (kept) { store.setDraftText(appendToDraft(store.draftText, kept)); writeNativeOfflineDraft(machine, store.runtimeSessionId, ''); }
    return registerNativeComposer(store.runtimeSessionId, async draft => {
      const files = draft.files ?? [];
      if (store.acceptsImagePrompts && files.some(file => file.type.startsWith('image/') && !toAttachmentMimeType(file))) throw new Error(translate('chat.unsupportedImageTitle'));
      await addImageFiles(files.filter(file => file.type.startsWith('image/')));
      await attachPathFiles(files.filter(file => !file.type.startsWith('image/')));
      store.setDraftText(appendToDraft(store.draftText, draft.text));
    });
  }, [store, composerShown, inputAccount, addImageFiles, attachPathFiles, translate]);

  const handleAttachmentsChange = useCallback(
    (next: ComposerAttachment[]) => {
      const nextIds = new Set(next.map((attachment) => attachment.id));
      for (const [id, controller] of imageUploadsRef.current) {
        if (!nextIds.has(id)) { controller.abort(); imageUploadsRef.current.delete(id); }
      }
      for (const id of [...filePathsRef.current.keys()]) {
        if (!nextIds.has(id)) filePathsRef.current.delete(id);
      }
      fileUploads.keepOnly(nextIds);
      if (next.every((att) => att.state !== 'error')) setSendHold((hold) => (hold === 'blocked' ? null : hold));
      for (const { chipId, ref } of droppedImageRefs(imageRefsRef.current, nextIds)) {
        imageRefsRef.current.delete(chipId);
        void store.deleteAttachment(ref.id);
      }
      setAttachments(next);
    },
    [store, fileUploads]
  );

  const handleFileInputChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      e.target.value = '';
      if (files.length === 0) return;

      const images = files.filter((f) => f.type.startsWith('image/'));
      if (images.length > 0) {
        await addImageFiles(images);
      }

      // 图片已经由 addImageFiles 分过路(上传或降级),这里只剩其余文件。
      await attachPathFiles(files.filter((f) => !f.type.startsWith('image/')));
    },
    [addImageFiles, attachPathFiles]
  );

  const workspaceId = useObserver(
    () => asProvisioned(getSessionPageStore(store.projectId, store.sessionId))?.workspaceId
  );
  const linkedIssue = useObserver(
    () => getRegisteredSessionData(store.projectId, store.sessionId)?.linkedIssue
  );
  const issueProviderContext = useObserver(() => {
    const mounted = asMounted(getProjectStore(store.projectId));
    return {
      projectPath: mounted?.data.path,
      repositoryUrl:
        mounted?.gitRepository.issueRepositoryUrl ??
        mounted?.gitRepository.canonicalRepositoryUrl ??
        undefined,
      selectedIssueProvider: getProjectViewStore(store.projectId)?.selectedIssueProvider ?? null,
    };
  });
  const { connectedProviders, isProviderUsable } = useConnectedIssueProviders(issueProviderContext);
  const { byEngine: agentCreationToolsByEngine, renderMentionIcon: renderAgentMentionIcon } = useSessionAgentCreationTools();
  const issueProvider = useMemo(() => {
    const selected = issueProviderContext.selectedIssueProvider;
    if (selected && isProviderUsable(selected)) return selected;
    return connectedProviders[0] ?? null;
  }, [connectedProviders, isProviderUsable, issueProviderContext.selectedIssueProvider]);

  const localSessionMentionProvider = useMemo(
    () =>
      createLocalSessionMentionProvider({
        excludeSessionId: store.sessionId,
        mentionUri: store.chatState.uri ?? store.sessionId,
        creationToolsByEngine: agentCreationToolsByEngine,
      }),
    [agentCreationToolsByEngine, store],
  );

  // Transcript parsing is synchronous, so seed the task-scoped mention registry as soon as
  // the panel mounts instead of waiting for the user to open the @ popup.
  useEffect(() => {
    if (!window.electronAPI) return;
    let active = true;
    const mentionUri = store.chatState.uri ?? store.sessionId;
    // Registering is a side effect of the search, so a search that settles AFTER this effect was
    // cleaned up writes an entry nobody clears again. Clear it here instead of skipping the
    // register: by then the only thing that knows the entry is stale is this closure.
    // The provider itself logs and returns [] on failure, so there is no rejection to catch —
    // a second catch here would be dead code that reads like the error handler.
    void localSessionMentionProvider.search('').then(() => {
      if (!active) clearLocalSessionMentions(mentionUri);
    });
    return () => {
      active = false;
      clearLocalSessionMentions(mentionUri);
    };
  }, [localSessionMentionProvider, store]);

  // 侧栏会话行拖进来 = 与 @ 弹层同一枚 pill(behavior session-page「把会话拖成 @」)。
  const { dataDropTypes, onDataDropped } = useSessionMentionDrop({
    provider: localSessionMentionProvider,
    editorApiRef,
    selfSessionId: store.sessionId,
  });

  // 落在这条会话的**正中**(聊天记录那一片)也算落在输入框上(behavior session-page「把会话拖成 @」):一块的上下左右边
  // 先被这一屏收走分出一块(screen-frame 的捕获阶段),剩下的才走到这里。composer 自己那一格由它自己收,这里只兜它
  // 够不到的地方,❌ 两边都收(会插两枚)。owner 2026-10-15「拖到边缘是分屏,中间是 session 信息粘贴」——
  // 取代 10-09 那句「正中什么都不发生」(那次把这一段删了,于是拖进来要么分屏、要么没反应)。
  useEffect(() => {
    const surface = composerSlot.closest('[data-session-chat-surface]');
    if (!(surface instanceof HTMLElement)) return;
    const accepts = (event: DragEvent) => event.dataTransfer && getDraggedScreenContent(event.dataTransfer)?.kind === 'session';
    const onDragOver = (event: DragEvent) => {
      if (accepts(event)) event.preventDefault();
    };
    const onDrop = (event: DragEvent) => {
      if (!accepts(event)) return;
      const target = event.target;
      if (target instanceof Element && target.closest('[data-slot="composer-bar"]')) return;
      event.preventDefault();
      onDataDropped(event.dataTransfer!);
    };
    surface.addEventListener('dragover', onDragOver);
    surface.addEventListener('drop', onDrop);
    return () => {
      surface.removeEventListener('dragover', onDragOver);
      surface.removeEventListener('drop', onDrop);
    };
  }, [composerSlot, onDataDropped]);

  const mentionProvider = useMemo<ContextMentionProvider | undefined>(() => {
    const wsId = workspaceId;
    const resultsChanged = new Set<() => void>();
    return {
      resolve(target, label) {
        const meta = chatMentionProvider.resolve(target, store.chatState.uri ?? store.sessionId);
        return meta ? { id: meta.id, label: target, name: label, kind: meta.kind,
          role: target.startsWith('aid:') ? 'agent' : undefined, engine: meta.engine,
          description: meta.title } : null;
      },
      onResultsChanged(listener: () => void) {
        resultsChanged.add(listener);
        return () => resultsChanged.delete(listener);
      },
      async search(query: string, options?: { requery?: boolean }): Promise<MentionItem[]> {
        // 「@」刚打出来(查询还是空的):让文件索引补一遍 —— 只有一个目录一个 watch 的平台上它才真的去扫
        // (没人盯着的目录里新建的文件靠这一下进索引)。❌ 等它:先用现有索引出结果,扫完再让弹层按当前查询重查一次。
        // 重查(重扫完了编辑器按同一查询再问一次)❌ 再触发:否则停在「@」上会一轮接一轮全量重扫。
        if (query === '' && wsId && !options?.requery) {
          void nudgeWorkspace(store.projectId, wsId, { reindex: true }).then((rescanned) => {
            if (rescanned) for (const listener of [...resultsChanged]) listener();
          });
        }
        const pinnedIssue =
          linkedIssue && issueMatchesQuery(linkedIssue, query)
            ? toIssueMentionItem(linkedIssue)
            : null;
        const issueSearch =
          issueProvider && query.trim().length >= ISSUE_SEARCH_MIN_LENGTH
            ? rpc.issues
                .searchIssues(issueProvider, {
                  limit: ISSUE_SEARCH_LIMIT,
                  searchTerm: query.trim(),
                  projectId: store.projectId,
                  projectPath: issueProviderContext.projectPath,
                  repositoryUrl: issueProviderContext.repositoryUrl ?? undefined,
                })
                .catch((error: unknown) => {
                  log.warn('Failed to search issue mentions', { provider: issueProvider, error });
                  return null;
                })
            : Promise.resolve(null);

        const [files, issueResult, localSessionItems] = await Promise.all([
          wsId
            ? rpc.search.searchWorkspaceFiles({ workspaceId: wsId, query })
            : Promise.resolve([]),
          issueSearch,
          localSessionMentionProvider.search(query),
        ]);

        const pinnedIssueItems: MentionItem[] = [];
        const searchedIssueItems: MentionItem[] = [];
        const seenIssueIds = new Set<string>();
        if (pinnedIssue) {
          pinnedIssueItems.push(pinnedIssue);
          seenIssueIds.add(pinnedIssue.id);
        }
        if (issueResult?.success) {
          for (const issue of issueResult.data) {
            const item = toIssueMentionItem(issue);
            if (seenIssueIds.has(item.id)) continue;
            seenIssueIds.add(item.id);
            searchedIssueItems.push(item);
          }
        } else if (issueResult && !issueResult.success) {
          log.warn('Failed to search issue mentions', {
            provider: issueProvider,
            error: issueResult.error,
          });
        }

        const fileItems = files.map((f) => ({
          id: f.path,
          label: f.path,
          name: f.filename,
          kind: 'file' as const,
          description: f.path,
        }));

        return [...localSessionItems, ...pinnedIssueItems, ...fileItems, ...searchedIssueItems];
      },
    };
  }, [
    workspaceId,
    linkedIssue,
    issueProvider,
    store.projectId,
    issueProviderContext.projectPath,
    issueProviderContext.repositoryUrl,
    agentCreationToolsByEngine,
    localSessionMentionProvider,
  ]);

  const { data: agents } = useAgents();
  // @@@task-fusion (#2802) — 这个面板的选择器是 `agentLocked`(ACP 不允许会话中途换 agent),
  // 只渲染成一个禁用图标按钮、列表根本不展开,所以这里**不**接安装动作 —— 接了也是死代码。
  // 分组口径仍与 initial-session-section 共用,见 `agent-availability-groups`。
  const agentOptions = useMemo<ComposerAgentOption[]>(
    () =>
      sortAgentsByAvailability(agents ?? []).map((a) => ({
        id: a.id,
        name: a.name,
        icon: <AgentIcon id={a.id} size={14} className="rounded-sm" />,
        groupLabel: agentGroupLabel(a.reading, translate),
      })),
    [agents]
  );

  const providerId =
    sessionRegistry.get(store.sessionId)?.sessions.get(store.sessionId)?.data
      .providerId ?? null;

  const providerCapabilities = agents?.find((agent) => agent.id === providerId)?.capabilities;

  // 排队提示的「立即发送」:这家能插话就插进在跑的那一轮,插不了才取消再发(#6574)。
  const sendNowSteers = agentSteersActiveAcpTurn(providerCapabilities);
  const queuedPrompts = useMemo(
    () => store.queuedPrompts.map((prompt) => ({ ...prompt, sendNowSteers })),
    [store.queuedPrompts, sendNowSteers]
  );
  const handleSendQueuedPromptNow = useCallback(
    (id: string) => {
      requestSendQueuedPromptNow({
        cancelsTurn: store.affordances.isWorking && !sendNowSteers,
        send: () => store.sendQueuedPromptNow(id, { steers: sendNowSteers }),
      });
    },
    [store, sendNowSteers]
  );

  // 载入期输入框里那句占位话归谁 —— 判据在 `startup-placeholder.ts`。
  const startupPlaceholder = startupPlaceholderKey({
    historyLoading: store.historyLoading,
    noticeKey: providerCapabilities?.acp.startup?.noticeKey,
  });
  const startupPlaceholderKeyValue = declaredMessageKey(startupPlaceholder);
  // 会话内的「咕咕提供的模型」目录 —— 与新建任务那侧同一个 hook、同一份真值。
  // 档位下拉与「当前选中哪一行」必须读同一张表 —— 两处各查一次,改一处漏一处就会
  // 出现「摆着三档,却哪一档都没选中」。
  const providerPermissionModeMap = agents?.find((agent) => agent.id === providerId)?.capabilities
    ?.autoApprove.modes;

  // ── 会话内的模型 / 强度:能不能改,按会话自己报得出什么来判 ────────────────────
  //
  // @@@session-options-disabled — 口径:**平台目录里有 = 当场交给 ACP; BYOK 活会话报得出来的 =
  // 当场换;报不出但目录里有 = 重开会话换;目录里也没有 = 才置灰**。判据是
  // `planModelSwitch` 那个纯函数,三态。
  //
  // 为什么不是「凡是平台模型就置灰」:咕咕代付的端点和 token 在 **spawn 那一刻**决定,
  // 但模型 option 是 ACP 会话级状态。平台组内切换直接走 `session/set_config_option`;
  // 只有跨到 BYOK 时才把新模型写进会话记录、确认重开、再按记录起进程并 `session/load`。
  //
  // ⚠️ 仍然 ❌ 无条件 `store.setModel`:跨来源时必须先确认重开并换凭据；同来源平台切换
  // 则由 `planModelSwitch` 把裸 alias 交给 ACP。两条路径都不能把带来源前缀的展示 id
  // 直接发给 adapter,否则会产生“高亮变了但实际仍烧旧凭据”的错账。
  const resetEffortId = providerCapabilities?.effort.kind === 'selectable'
    ? providerCapabilities.effort.resetId
    : undefined;
  const declaredEffortOptions = providerCapabilities?.effort.kind === 'selectable'
    ? providerCapabilities.effort.effortOptions
    : null;
  const handleEffortChange = useCallback(
    (effortId: string) => {
      // 还在起的那段,可设的档就是声明的那几档(#6552,同 sessionEffortOptions)。
      const settable = store.effortOptions ?? (store.starting ? declaredEffortOptions : null);
      const value = effortId === '' && resetEffortId && settable?.[resetEffortId]
        ? resetEffortId
        : effortId;
      void store.setEffort(value).then((outcome) => {
        if (outcome?.kind !== 'restart-required') return;
        reportUnwiredRestart('effort', outcome.requestedValue);
      });
    },
    [store, reportUnwiredRestart, resetEffortId, declaredEffortOptions]
  );
  // #7342 停下了:引擎那份档位清单没了,按映射表摆回四档、选中记录那一档(改了记进记录,见 store.setMode)。
  const detachedPermission = detachedPermissionModeOptions(store.detachedPermissionTier, providerPermissionModeMap);
  const sessionPermissionOptions = sessionPermissionModeOptions(
    store.permissionModeOptions ?? detachedPermission?.options ?? null,
    providerCapabilities?.acp.liveSettings?.permission,
    providerCapabilities?.acp.sessionModes,
  );
  const platformCatalog = usePlatformModelCatalog(providerId, 'acp', store.sessionId);

  /**
   * 这条会话的**计费路**,三态 —— 唯一写者是会话自己记下的那个决定
   * (`platform-model-selection`:`{modelId}` = 咕咕代付,`null` = 明确 BYOK,缺席 = 没做过这个决定)。
   *
   * ⚠️ 目录还没回来时 `sessionSelection` 也是 `undefined` ⇒ 那一刻是 `unknown` 而不是 `own`:
   * 并进 `own` 会让菜单在目录到达前(以及目录取不到时的**永远**)照那份被票裁过的活清单画,
   * #5808 原样复发。理由全文在 @@@own-model-tier。
   */
  const route = sessionBillingRoute(platformCatalog.sessionSelection);
  // #6264 会话在别的机器上:这条登录读数也问那台机器(一套工作台)。
  const { auth: authStatus } = useAgentAuthStatus(route === 'own' ? providerId : null, undefined, {
    machine: machineRegistry.machineOf(store.projectId),
  });
  const costSource =
    route === 'platform'
      ? 'platform'
      : route !== 'own'
        ? 'unknown'
        : authStatus?.status.kind === 'authenticated'
          ? authStatus.status.credentialKind ?? 'unknown'
          : 'unknown';

  // 「你的 X 模型」那一档的成员,见 @@@own-model-tier —— 平台会话看不见用户自己那条凭据路,
  // 只有这趟 BYOK 探针看得见。主进程按 provider 缓存,新建页读的是同一份(react-query 同 key)。
  // ⚠️ 只在**需要**时才问:`own` 那条路的成员来自活会话本身,问一趟等于白起一个 harness 进程
  //    (冷缓存时这趟会 spawn,实测数秒)。明确 BYOK 的会话一次都不问。
  // #6552 会话还在起(活会话还没报清单)时 BYOK 那一路也问:那段里探针目录就是唯一看得见这份清单的人。
  // #7342 停下了(宿主停掉进程、起不来)同理 —— 没有活会话就没有活清单,触发器连模型名都对不上。
  //   开销:主进程按 provider 缓存、不等 harness(冷缓存在后台探);远端按会话所在那台机器问(hook 自己选线)。
  const harnessCatalog = useHarnessModelCatalog(
    route === 'own' && store.session ? null : providerId,
    'acp'
  );

  /**
   * 这条会话是不是跑在咕咕代付的模型上 —— 判据是它**自己记录的模型**在目录里,
   * ❌ 不靠前缀猜:会话记录里存的是裸 id(重开那一跳写进去的就是裸的)。
   * 它同时是高亮的取值与 `planModelSwitch` 的 `runningOn`(既有语义,原样保留)。
   */
  const runningPlatformModel = runningPlatformModelId(
    platformCatalog.sessionSelection,
    store.model,
    platformCatalog.models.map((entry) => entry.id),
  );
  const runningOn = runningPlatformModel ? 'platform' : 'own';

  /**
   * #7056 会员中途到期:正在用的咕咕模型这一档用不了了 ⇒ 下一轮之前就停下(发送键不放行),面板那一行说清原因、
   * 给两条去路(换模型 / 开通会员)。❌ 悄悄换模型接着跑;❌ 发出去才被网关拒。
   * 判据是目录对**这条会话正在跑的那个模型**的 `requiresMembership` —— 会员续上、或换到免费档能用的模型,
   * 这一格自然变回 null。主进程续期时发现被收掉,会广播一次,这里刷新目录。
   */
  const membershipLockedModel = runningPlatformModel
    ? (platformCatalog.models.find((entry) => entry.id === runningPlatformModel && entry.requiresMembership) ?? null)
    : null;
  const membershipLockName = membershipLockedModel?.displayName ?? null;
  useEffect(() => {
    onMembershipLockChange(membershipLockName ? { modelName: membershipLockName } : null);
  }, [membershipLockName, onMembershipLockChange]);
  useEffect(() => () => onMembershipLockChange(null), [onMembershipLockChange]);
  // refresh 每次渲染都是新函数;订阅只跟会话走,所以经 ref 取最新的那个。
  const refreshPlatformCatalogRef = useRef(platformCatalog.refresh);
  refreshPlatformCatalogRef.current = platformCatalog.refresh;
  useEffect(() => {
    const api = findSessionHostBridge();
    if (!api) return;
    return api.eventOn('session:platform-membership-changed', (value) => {
      if ((value as { sessionId?: unknown } | null)?.sessionId === store.sessionId) refreshPlatformCatalogRef.current();
    });
  }, [store.sessionId]);
  // 挡着的时候人多半去网页续费了:窗口一回到前台,目录自己会重取(usePlatformModelCatalog),
  // 续上了就当场放开发送键 —— ❌ 干等下一次续期(最长七八分钟)才发现会员已经回来了。

  // 与新建页同一份装配(@@@composer-model-assembly)—— 这里只负责"哪几条现在还切不了"。
  //
  // ⚠️ 两档**同名条目并存**是准确的,不是重复:「你的 Codex 模型 / GPT-5.5」走用户自己的订阅
  //    (点下去重开会话换凭据),「咕咕提供的模型 / GPT-5.5」按积分 —— 组头本来就是用来分这两条路的。
  //    ❌ 别再按 id 相同把它们折成一条(#5808)。
  // ⚠️ 自家那一档要 memo 住:`harnessCatalogToOptions` 每次都现造一个对象,而本组件是 observer,
  //    回合里每个 usage / stream tick 都重渲染 ⇒ 不 memo 会让下面两层 useMemo 全部落空。
  // #6552 会话还在起 / #7342 停下了:没有活会话报清单,这一段用与新建页同一份探针目录(选择会在下一次启动设进去)。
  const detached = store.session === null;
  const startupOwnOptions = useMemo(
    () => (detached ? harnessCatalogToOptions(harnessCatalog.state) : null),
    [detached, harnessCatalog.state]
  );
  const ownTier = useMemo(
    () => ownModelTierOptions({
      route,
      live: store.modelOptions ?? startupOwnOptions,
      catalog: harnessCatalog.state,
    }),
    [route, store.modelOptions, startupOwnOptions, harnessCatalog.state]
  );
  // 「这条会话现在切得动哪些」的清单:活会话报的;还在起的那段是启动那一步会设的那份(同上)。
  const advertisedModels = useMemo(
    () => Object.keys(store.modelOptions ?? startupOwnOptions ?? {}),
    [store.modelOptions, startupOwnOptions]
  );
  const merged = useComposerModelOptions(ownTier, platformCatalog.models, providerId, runningPlatformModel);

  const sessionModelOptions = useMemo(() => {
    // 能力声明还没到 ⇒ 还答不出「哪些能当场换」:❌ 不拿「未声明」去判(那会把整张菜单暂时置灰)。
    if (!merged || !providerCapabilities) return null;
    const catalog = platformCatalog.models;
    const options = Object.fromEntries(
      Object.entries(merged).map(([id, option]) => {
        // 四态见 @@@session-options-disabled。hot / reload 都是"能选",
        // unavailable / unsupported 才置灰 —— ❌ 别按 `platform:` 前缀判,那会把能重开换成的也灰掉。
        const plan = planModelSwitch({
          selection: composerModelSelection(id),
          advertised: advertisedModels,
          catalog,
          runningOn,
          liveSetting: providerCapabilities?.acp.liveSettings?.model,
        });
        if (plan.kind !== 'unavailable' && plan.kind !== 'unsupported') return [id, option];
        return [
          id,
          {
            ...option,
            disabled: true,
            disabledReason: translate(
              plan.kind === 'unsupported'
                ? 'chat.modelSwitchUnsupportedHint'
                : 'composer.modelNotInCatalog'
            ),
          },
        ];
      })
    );
    // 记着的平台模型已不在目录里(下架了):照实摆出来、置灰并说明 —— 触发器才显示得出它的名字(❌ 占位的「Model」)。
    if (runningPlatformModel) {
      const recorded = platformOptionId(runningPlatformModel);
      if (!options[recorded]) options[recorded] = { name: runningPlatformModel, disabled: true, disabledReason: translate('composer.modelNotInCatalog') };
    }
    return options;
  }, [
    merged,
    advertisedModels,
    platformCatalog.models,
    runningOn,
    runningPlatformModel,
    providerCapabilities,
    translate,
  ]);

  // ⚠️ 这一整段必须在 `platformCatalog` / `sessionModelOptions` **之后**:下面的 handler 把
  //    `platformCatalog` 列进 deps,而 deps 是渲染时求值的 —— 放到它前面会当场 TDZ 炸掉
  //    整个渲染进程(白屏,而且第一眼看不出是声明顺序)。
  /**
   * 用户碰到了一个「要重开会话才换得成」的设置,等他在确认框里点确认。
   *
   * **三维共用这一个状态** —— 形状与「维度→请求载荷」的翻译都只在 `pending-setting-restart.ts`
   * 里定义一次。⇒ 加一维不需要在这里加第二个 `useState`、第二个确认框、第二个 confirm 函数。
   */
  const [pendingReload, setPendingReload] = useState<RestartTarget | null>(null);
  const [reloading, setReloading] = useState(false);

  /** 用户在 `/mcp` 面板里改完开关、点了应用,等他在确认框里确认重开。 */
  const [pendingMcp, setPendingMcp] = useState<
    { disabled: string[]; label: string } | null
  >(null);
  const [mcpPanel, setMcpPanel] = useState<{
    servers: McpSessionPanelAdapterServer[];
    skills: McpSessionPanelAdapterSkill[];
    toggleSupported: boolean;
    dialect: string | null;
    granularity: 'per-server' | 'all-or-none';
  } | null>(null);

  /**
   * #7092 从没起来过(首启失败,如会员模型被拒)的会话换模型:没有活会话可热切,也没有这一轮可打断 ⇒
   * 不弹重开确认。宿主只把新选择记进会话记录(`notStarted`),这里接着按正常首启再起一次。
   */
  const switchBeforeFirstStart = useCallback(
    async (target: RestartTarget) => {
      setReloading(true);
      try {
        const result = await requestSessionReload(reloadRequestFor(target, store.sessionId));
        if (!result.ok) {
          showModal('confirmActionModal', {
            title: translate('chat.modelSwitchFailedTitle', { target: target.label }),
            description: result.error ?? '',
            confirmLabel: translate('common.close'),
            onSuccess: () => undefined,
          });
          return;
        }
        platformCatalog.retry();
        if (result.notStarted) store.retry();
      } finally {
        setReloading(false);
      }
    },
    [store, platformCatalog, showModal, translate]
  );

  /**
   * 会话内换模型有三种结局,判据是 `planModelSwitch`(纯函数,判据 = 活会话 ACP 报出来的清单)。
   *
   * ❌ 不再无条件 `store.setModel`:清单里没有的那些,适配器会当场拒(三家实测),
   * 而用户看到的是「点了没反应」。三态分开之后,能换的当场换、要重开的先问一句、
   * 到不了的直接说 —— 每一种都有下一步。
   */
  const handleModelChange = useCallback(
    (optionId: string) => {
      // 与 `sessionModelOptions` 同一个前提:能力声明没到,菜单本来就没摆出来。
      if (!providerCapabilities) return;
      if (
        store.loadError
        && !sessionRegistry.get(store.sessionId)?.sessions.get(store.sessionId)?.data.providerSessionId
      ) {
        const selection = composerModelSelection(optionId);
        const known = selection.source === 'platform'
          ? platformCatalog.models.find((entry) => entry.id === selection.modelId)
          : undefined;
        void switchBeforeFirstStart({
          dimension: 'model',
          value: selection.modelId,
          label: known?.displayName ?? selection.modelId,
          source: selection.source,
        });
        return;
      }
      const plan = planModelSwitch({
        selection: composerModelSelection(optionId),
        advertised: advertisedModels,
        catalog: platformCatalog.models,
        runningOn,
        liveSetting: providerCapabilities?.acp.liveSettings?.model,
      });
      if (plan.kind === 'hot') {
        // ⚠️ 下发 `wireValue`,❌ 不是 `modelId`:平台模型在 opencode 上寻址成
        // `gugu-platform/<id>`,递裸 id 会被它当未知模型拒掉(owner 2026-09-13 实测:
        // 裸 `glm-5` ⇒ `-32602 model not found`,平台限定形式 ⇒ success)。
        // 两个 id 的分工见 `ModelSwitchPlan` 的 `wireValue` 注释。
        //
        // ⚠️ 即使 `planModelSwitch` 判了「热」,运行时仍可能回 `restart_required`
        //    (声明与实际不一致时)。那时**不能只吞掉** —— 走同一个确认+重启动作。
        // `hot` 那一支**没有** displayName / source(它们只在 `reload` 上)—— 这是 typecheck
        // 抓到的:热切根本不需要它们,而这条防线需要。⇒ 从这里现有的两份真值取:
        // 显示名取目录(取不到就用 id,❌ 不猜一个好看的),计费路取用户点中那一条自己的来源。
        const selection = composerModelSelection(optionId);
        const catalogName = platformCatalog.models
          .find((entry) => entry.id === plan.modelId)?.displayName;
        const source = selection.source === 'platform' ? 'platform' : 'own';
        void store.setModel(plan.wireValue).then(async (outcome) => {
          if (outcome?.kind === 'restart-required') {
            setPendingReload({
              dimension: 'model',
              value: plan.modelId,
              label: catalogName ?? plan.modelId,
              source,
            });
            return;
          }
          // 活会话确认生效之后,会话记录跟上(宿主的 `recordLiveModelSwitch`,与 Agent 级改模型同一个写者)。
          // 不跟上:不报当前模型的家(copilot)触发器读的就是旧记录;任何一家冷启动都按旧记录 spawn(#6182)。
          // 运行时分叉视图(`isTransient`)没有会话记录,活会话本身就是它的全部。
          if (outcome?.kind !== 'applied' || store.isTransient) return;
          // 记的是活会话**确认在跑的**那个(`effectiveValue`),不是我们请求的那个 —— provider 可能把别名规范成另一条。
          // 平台模型的生效值是它自己的寻址形式(`gugu-platform/<id>`),翻回规范 id;翻不出就是我们请求的那条(copilot 这类不回读的家)。
          const recorded = source === 'platform'
            ? platformModelIdFromRuntimeOption(
                outcome.effectiveValue,
                platformCatalog.models.map((entry) => entry.id),
              ) ?? plan.modelId
            : outcome.effectiveValue;
          try {
            await rpc.sessions.recordLiveModelSwitch({
              sessionId: store.sessionId,
              modelId: recorded,
              source,
            });
          } catch (error) {
            // 活会话已经换了、记录没跟上 ⇒ 下次启动会回到旧模型。响亮说出来,❌ 不吞。
            showModal('confirmActionModal', {
              title: translate('chat.modelSwitchNotRecordedTitle', { target: catalogName ?? plan.modelId }),
              description: error instanceof Error ? error.message : String(error),
              confirmLabel: translate('common.close'),
              onSuccess: () => undefined,
            });
            return;
          }
          platformCatalog.refresh();
        });
        return;
      }
      if (plan.kind === 'unavailable') {
        // 目录里压根没有 = 界面状态过期。重开一次也换不成,所以直接说,
        // ❌ 不拿用户的一次中断去换一个我们已经知道的答案。
        showModal('confirmActionModal', {
          title: translate('chat.modelUnavailableTitle', { agentName: providerId ?? '' }),
          description: translate('chat.modelUnavailableHint'),
          confirmLabel: translate('common.close'),
          onSuccess: () => undefined,
        });
        return;
      }
      if (plan.kind === 'unsupported') {
        showModal('confirmActionModal', {
          title: translate('chat.modelUnavailableTitle', { agentName: providerId ?? '' }),
          description: translate('chat.modelSwitchUnsupportedHint'),
          confirmLabel: translate('common.close'),
          onSuccess: () => undefined,
        });
        return;
      }
      // `source` 与模型一起送到宿主 —— 少了它重开会带着**旧的**那条计费路重来
      //(spawn 读的是每会话那份平台记录,不是 config.model)。见 session-reload.ts 的 modelSource。
      setPendingReload({
        dimension: 'model',
        value: plan.modelId,
        label: plan.displayName,
        source: plan.source === 'platform' ? 'platform' : 'own',
      });
    },
    [store, advertisedModels, platformCatalog.models, runningOn, providerCapabilities, showModal, translate, providerId, switchBeforeFirstStart]
  );

  /**
   * 用户确认之后才动:先把目标设置落进会话记录,再让主进程按记录重开 —— 顺序反了会重开出旧配置。
   *
   * **三维共用这一个函数。** 它自己不知道任何维度的细节:载荷由 `reloadRequestFor` 翻译。
   */
  const confirmReload = useCallback(async () => {
    const pending = pendingReload;
    if (!pending) return;
    setReloading(true);
    let succeeded = false;
    try {
      // ⚠️ ❌ 不在这里再调一次活会话的 setter —— 那是 **live** `set_config_option`,
      //    而「这个值活会话接不了」正是我们要重开的原因,调它必然失败并弹一句误导的错误
      //    (owner 2026-09-07 真机撞到),而且目标值根本没被持久化 ⇒ 重开之后跑的还是旧值。
      //    ⇒ 目标值交给宿主,由它保证「先写记录、再停、再起」。
      const result = await requestSessionReload(reloadRequestFor(pending, store.sessionId));
      // 宿主停掉又重开之后,聊天面自己重挂(`_onSessionClosedByHost`:副本跟着会话 id 走)。失败时保留确认层，允许用户重试。
      if (result.ok) {
        succeeded = true;
        // The host persists the new platform/own decision before reopening. Refresh the
        // catalog so a platform -> BYOK handoff cannot keep the old source label in the UI.
        platformCatalog.retry();
      }
      if (!result.ok) {
        // 原话直接给用户 —— ❌ 不折成「重开失败」:两种事故的下一步完全不同。
        showModal('confirmActionModal', {
          title: translate('chat.reloadConfirmTitleModel', { target: pending.label }),
          description: result.error ?? '',
          confirmLabel: translate('common.close'),
          onSuccess: () => undefined,
        });
      }
    } finally {
      setReloading(false);
      // Keep the target in the confirmation surface after a failed restart so it can be retried.
      if (succeeded) setPendingReload(null);
    }
  }, [pendingReload, store, platformCatalog, showModal, translate]);

  /**
   * `/mcp` —— **咕咕自己的**命令:拦下来开面板,**一个字都不发给 agent**。
   *
   * 面板要的三样(有哪几台 / 关着哪几台 / 这家能不能关)由主进程**一次给全**,
   * ❌ 渲染层不自己拼:那三样都是主进程的知识,漏一样的症状都是「面板看起来对、行为不对」。
   */
  const openMcpPanel = useCallback(async () => {
    const result = await rpc.mcp.sessionPanel(store.sessionId);
    if (!result.success || !result.data) {
      // 拿不到就说出来 —— ❌ 不开一个空面板让用户以为「这条会话没有 MCP」。
      showModal('confirmActionModal', {
        title: translate('mcpSession.title'),
        description: result.error ?? '',
        confirmLabel: translate('common.close'),
        onSuccess: () => undefined,
      });
      return;
    }
    const { servers, skills, toggleSupported, dialect, granularity } = result.data;
    setMcpPanel({ servers, skills, toggleSupported, dialect, granularity });
  }, [store.sessionId, providerId, showModal, translate]);

  const applyMcpSelection = useCallback(
    (enabled: string[]) => {
      if (!mcpPanel) return;
      const keep = new Set(enabled);
      // 只读的那几台(咕咕自己那台、扩展带的)本来就不在 `enabled` 里 —— ❌ 把它们算成「关掉」
      // (10-07 资源库体检:只关了 1 台,确认框写「关掉 2 台」)。
      const disabled = mcpPanel.servers
        .filter((server) => !server.readOnly && !keep.has(server.name))
        .map((server) => server.name);
      setPendingMcp({
        disabled,
        label: translate('mcpSession.applyTarget', { count: String(disabled.length) }),
      });
    },
    [mcpPanel, translate]
  );

  /** 用户确认之后才动:开关集合交给宿主,由它保证「先写记录、再停、再起」。 */
  const confirmMcpReload = useCallback(async () => {
    const pending = pendingMcp;
    if (!pending) return;
    setReloading(true);
    try {
      const result = await requestSessionReload({
        sessionId: store.sessionId,
        reason: 'mcp-toggle',
        // ⚠️ 原样传,`[]` 也传 —— 它表示「决定过、一台没关」,与「没碰过」不是一回事。
        mcpDisabledServers: pending.disabled,
      });
      if (!result.ok) {
        showModal('confirmActionModal', {
          title: translate('mcpSession.title'),
          description: result.error ?? '',
          confirmLabel: translate('common.close'),
          onSuccess: () => undefined,
        });
      }
    } finally {
      setReloading(false);
      setPendingMcp(null);
    }
  }, [pendingMcp, store.sessionId, showModal, translate]);

  /**
   * Same rule as the creation page (`resolveEffortCatalog`): a platform model offers the levels this
   * live session reports that the model itself accepts (its directory `reasoningEfforts`, #6447);
   * native models keep the live catalog. If no live catalog exists, the result is visible but
   * disabled until a reload supplies it.
   */
  const sessionEffortOptions = useMemo(() => {
    const declaredOptions = declaredEffortOptions;
    const declared = declaredOptions
      ? { options: declaredOptions, defaultId: null }
      : null;
    // #6552 会话还在起:声明的档位就是启动那一步能设的那几档,照样可选(同一步会把选中的设进去)。
    const liveOptions = store.effortOptions ?? (store.starting ? declaredOptions : null);
    const live = liveOptions && Object.keys(liveOptions).length > 0
      ? { options: liveOptions, defaultId: store.effort }
      : null;
    const resolved = resolveEffortCatalog(
      declared,
      live,
      effortSourceFor(Boolean(runningPlatformModel), providerCapabilities?.effort, 'acp'),
      platformEffortFacts(runningPlatformModel, platformCatalog.models)?.reasoningEfforts ?? null,
    );
    if (!resolved) return null;
    if (live || !declared) return resolved.options;
    return Object.fromEntries(
      Object.entries(resolved.options).map(([id, option]) => [
        id,
        { ...option, disabled: true, disabledReason: translate('composer.effortLockedToSession') },
      ])
    );
  }, [store.effort, store.effortOptions, store.starting, declaredEffortOptions, providerCapabilities, runningPlatformModel, platformCatalog.models, translate]);
  // #7342 停下了、记录里也没记档位(= harness 自己那一档默认):用探针目录报的那一档当默认档画(触发器压一档不透明度),
  // 与新建页同一个来源(`harnessCatalogToModelsCapability` 的 defaultEffortId)。活会话报的就是已生效那一档,用不着它。
  const detachedDefaultEffort = detached && !runningPlatformModel && harnessCatalog.state.kind === 'ready'
    ? (harnessCatalog.state.selectedEffort ?? undefined)
    : undefined;
  const renderMentionIcon = useCallback(
    (attrs: Parameters<typeof renderAgentMentionIcon>[0]) => {
      const { id, kind } = attrs;
      if (kind === 'custom') return renderAgentMentionIcon(attrs);
      if (kind !== 'issue') return null;
      const target = parseIssueMentionToken(id);
      if (!target) return null;
      return <IntegrationIcon provider={target.provider} size={12} />;
    },
    [renderAgentMentionIcon]
  );

  const querySlashItems = useCallback(
    async (query: string): Promise<CommandItem[]> => {
      const normalized = query.trim().toLowerCase();
      const commands = filterSlashCommands(store.commands, normalized)
        .map((command) => ({
          ...command,
          section: translate('chat.commands'),
        }));
      const prompts = promptLibrary
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
          section: translate('chat.prompts'),
        }));
      // @@@gugu-client-commands —— `/mcp` 是**咕咕自己的**命令,不是 agent 报上来的:
      // 选中时被 `onCommand` 拦下来开面板,**一个字都不发给 agent**。
      // ⚠️ 它出现在这里的前提是 apply 那条路已经接通(面板 → 记录 → 重开)——
      //    一条点了没反应的命令就是假控件,那是这仓零容忍的。
      const clientCommands: CommandItem[] = commandMatchesClientQuery(normalized)
        ? [
            {
              id: GUGU_CLIENT_COMMAND_MCP,
              name: 'mcp',
              token: '/mcp',
              label: '/mcp',
              description: translate('mcpSession.commandDescription'),
              behavior: 'execute' as const,
              section: translate('chat.commands'),
            },
          ]
        : [];
      return [...clientCommands, ...commands, ...prompts];
    },
    [store, promptLibrary, translate]
  );

  const a = store.affordances;

  // gugu-dev#181 ⑫ 会话里也能派:选了「新任务」,这一框换成新任务的框(卡落项目群;没有项目的落它的私聊)。
  if (verb) {
    return createPortal(<SessionVerbDock sessionId={store.sessionId} projectId={store.projectId} chatId={groupChatId} />, composerSlot);
  }

  return createPortal(
    <>
      <input ref={fileInputRef} type="file" multiple hidden onChange={handleFileInputChange} />
      {/* 换一个「活着换不了」的模型时那道确认 —— 与 MCP 开关那条车道共用同一个组件与同一份措辞
          (#5160 / #5157):代价那三句里最容易被漏掉的是「正在跑的那一轮会被打断」。 */}
      <SessionReloadConfirm
        open={pendingReload !== null}
        onOpenChange={(next) => {
          if (!next && !reloading) setPendingReload(null);
        }}
        reason={pendingReload ? confirmReasonFor(pendingReload) : 'model-switch'}
        target={pendingReload?.label ?? ''}
        // ⚠️ 这里曾经在**跨计费路**时事前断言「历史不会被重放」。那是推出来的,不是量出来的:
        //    计费路换的是端点与凭据,而 rollout 落在 agent home(按 provider 取,**不按计费路取**),
        //    owner 2026-09-07 实测换模型/换 provider 之后 agent 照样记得这条会话。
        // ⇒ 把一个不确定的损失事前说成确定,会让用户躲开一个其实安全的动作 —— 比不提示更坏。
        // ⇒ 历史真的没能续上时，宿主会拒绝重启并保留原 conversation。
        //    那条是事后的,但**是准的**。留准的,删不准的。
        isReloading={reloading}
        onConfirm={confirmReload}
      />
      {/* MCP 开关那条重开确认 —— 与换模型共用同一个组件、同一份代价文案(#5157 / #5160)。 */}
      <SessionReloadConfirm
        open={pendingMcp !== null}
        onOpenChange={(next) => {
          if (!next && !reloading) setPendingMcp(null);
        }}
        reason="mcp-toggle"
        target={pendingMcp?.label ?? ''}
        isReloading={reloading}
        onConfirm={confirmMcpReload}
      />
      <McpSessionPanelAdapter
        open={mcpPanel !== null}
        onOpenChange={(next) => {
          if (!next) setMcpPanel(null);
        }}
        anchor={composerSlot}
        servers={mcpPanel?.servers ?? []}
        skills={mcpPanel?.skills ?? []}
        toggleSupported={mcpPanel?.toggleSupported ?? false}
        // 面板里那几句(关不掉、让给它自己的那台)说的是人认得的名字,❌ provider id。
        harnessName={agents?.find((agent) => agent.id === providerId)?.name ?? providerId ?? ''}
        granularity={mcpPanel?.granularity ?? 'per-server'}
        onApply={applyMcpSelection}
      />
      {schedules.length > 0 ? (
        <div className={sessionComposerTrayClassName} style={sessionComposerTrayStyle}>
          <SessionScheduleChip machine={scheduleMachine} schedules={schedules} />
        </div>
      ) : null}
      <NeedsYouSlot />
      {/* Starting with no message drawn (a drawn one's live line says it): the lifecycle's state, nothing more. */}
      {life && lifeIsStarting(life) && !store.transcriptPendingId ? (
        <div className="flex justify-center px-3 py-1 text-xs text-foreground-muted" data-life-stage={life.stage?.at}>
          <LoadingIndicator ariaLabel={translate('transcript.starting')} label={translate('transcript.starting')} />
        </div>
      ) : null}
      {life?.nativeSession ? (
        <div className="px-3 py-1 text-center text-xs text-foreground-muted" role="status" data-native-session={life.nativeSession}>
          {translate(life.nativeSession === 'preserved' ? 'chat.reloadPreserved' : 'chat.reloadReplaced')}
        </div>
      ) : null}
      {/* Every send of a task page is in custody until the transcript has it, so its bubbles always show here. */}
      <SessionInputQueue sessionId={store.runtimeSessionId} waitingForConnection life={life} inTranscript={store.transcriptPendingId ?? store.stoppedRowId} />
      <SessionHostQuestion sessionId={store.runtimeSessionId} session={hostSession} />
      <ChatComposer
        className={schedules.length > 0 ? sessionComposerFrameLiftClassName : undefined}
        hideLockedAgent
        isWorking={a.isWorking}
        attachmentStatus={sendHold === 'waiting' ? translate('composer.attachmentWaiting') : undefined}
        notice={
          sendHold === 'blocked'
              ? { variant: 'error', message: translate('composer.attachmentBlocked'), onDismiss: () => setSendHold(null) }
              : store.permissionModeChangeNotice
        }
        // Store owns both live sending and pre-session queue admission.
        // 正在用的咕咕模型要会员了(#7056):下一轮之前停下,原因与去路在面板那一行。
        canSubmit={(a.canSubmit || canQueueNativeInput(store)) && (store.draftText.trim().length > 0 || attachments.length > 0)
          && sendHold !== 'waiting' && !membershipLockedModel}
        placeholder={startupPlaceholderKeyValue ? translate(startupPlaceholderKeyValue) : undefined}
        onSubmit={handleSubmit}
        onInputChange={(text) => store.setDraftText(text)}
        onSubmitWhileWorking={handleSubmitWhileWorking}
        onStop={a.isWorking ? handleStop : undefined}
        permissionRequest={permissionRequest}
        permissionQueueCount={store.permissionQueue.length}
        onResolvePermission={handleResolvePermission}
        queuedPrompts={queuedPrompts}
        // 排队条打印的是原文,而 @ 提及在原文里是它的地址 —— 显示成名字,与输入框里的 pill、
        // 聊天记录里的 pill 一致(点进去编辑仍是原文,那才是真要发出去的东西)。
        renderQueuedPromptText={promptEditor.renderQueuedPromptText}
        onEditQueuedPrompt={(id, text) => { void store.editQueuedPrompt(id, text); }}
        queuedPromptEdit={promptEditor.queuedPromptEdit}
        onBeginEditQueuedPrompt={(id) => { void store.beginQueuedPromptEdit(id); }}
        onChangeQueuedPromptEdit={promptEditor.changeQueuedPromptEdit}
        onFinishQueuedPromptEdit={promptEditor.finishQueuedPromptEdit}
        onDeleteQueuedPrompt={(id) => store.deleteQueuedPrompt(id)}
        onReorderQueuedPrompts={(ids) => store.reorderQueuedPrompts(ids)}
        onSendQueuedPromptNow={handleSendQueuedPromptNow}
        getPromptHistory={() => store.promptHistory()}
        editorApiRef={editorApiRef}
        // 与新建任务那个 composer 同一套装配(@@@composer-model-assembly);
        // 「哪几条现在切不了」由 sessionModelOptions 判,见 @@@session-options-disabled。
        modelOptions={sessionModelOptions}
        selectedModel={composerSelectedOptionId({
          platformModel: runningPlatformModel,
          model: store.model,
        })}
        onModelChange={handleModelChange}
        modelMenuOpenRequest={modelMenuRequest}
        // 底部「管理模型 / 升级解锁更多模型」(#7056),三个模型菜单同一份。
        {...composerModelFooter(platformCatalog.models)}
        effortOptions={localizeEffortOptions(sessionEffortOptions, translate)}
        selectedEffort={store.effort ?? undefined}
        defaultEffort={detachedDefaultEffort}
        onEffortChange={handleEffortChange}
        permissionModeOptions={localizePermissionModeOptions(
          sessionPermissionOptions,
          translate,
          providerPermissionModeMap
        )}
        selectedPermissionMode={selectedPermissionModeId(
          store.permissionMode ?? detachedPermission?.selected,
          sessionPermissionOptions,
          providerPermissionModeMap
        )}
        onPermissionModeChange={handleModeChange}
        agentOptions={agentOptions}
        selectedAgent={providerId ?? undefined}
        agentLocked
        onAgentChange={() => {}}
        contextUsage={
          store.usage
            ? {
                used: store.usage.contextUsed,
                size: store.usage.contextSize,
                cost: store.usage.cost,
                costSource,
              }
            : null
        }
        mentionProvider={mentionProvider}
        renderMentionIcon={renderMentionIcon}
        queryCommands={querySlashItems}
        // 客户端自己的命令在这里被拦下 —— agent 报上来的命令**不进这条分支**,
        // 照旧由编辑器插进输入框、原样发出去。
        onCommand={(item) => {
          if (!isGuguClientCommand(item.id)) return;
          if (item.id === GUGU_CLIENT_COMMAND_MCP) void openMcpPanel();
        }}
        attachments={attachments}
        onAttachmentsChange={handleAttachmentsChange}
        onAttach={handleAttach}
        onImageFilesDropped={(files) => void addImageFiles(files)}
        onFilesDropped={(files) => {
          attachPathFiles(files).catch((error: unknown) => {
            log.error('Failed to attach dropped files', { error });
          });
        }}
        onDirectoriesDropped={(files, entries) => {
          attachDirectories(files, entries).catch((error: unknown) => {
            log.error('Failed to attach dropped folders', { error });
          });
        }}
        onRetryAttachment={fileUploads.retry}
        dataDropTypes={dataDropTypes}
        onDataDropped={onDataDropped}
        onViewAttachment={onViewAttachment}
        toolbarExtra={<SessionComposerVerbs sessionId={store.sessionId} draft={store.draftText} onCarried={() => store.setDraftText('')} />}
      />
    </>,
    composerSlot
  );
});

// ── AcpChatPanel ──────────────────────────────────────────────────────────────
//
// One persistent ChatTranscript is mounted for the lifetime of this panel.
// When the active conversation changes, props.state identity changes, which
// triggers ChatTranscript's setModel effect — the Solid view swaps ChatState
// in-place without dispose/recreate, preserving per-conversation scroll.
//
// The composer subtree is keyed by conversationId so draft text, focus, and
// editor state reset on each switch (equivalent to the old remount behavior).
import { electronApi } from '../../../lib/electron-api';


const INTERRUPTED_LABEL = {
  update: 'transcript.condition.turnInterruptedUpdate',
  restart: 'transcript.condition.turnInterruptedRestart',
  unclean: 'transcript.condition.turnInterruptedUnclean',
} as const satisfies Record<InterruptedBy, SessionMessageKey>;

export const AcpChatPanel = observer(function AcpChatPanel({
  tabKind = 'acp-chat',
}: {
  tabKind?: 'acp-chat' | 'side-chat';
}) {
  const { translate } = useSessionMessages();
  const { navigate } = useNavigate();
  const { pane } = usePaneContext();

  const activeTab = pane.resolvedTabs.find((t) => t.isActive && t.kind === tabKind);
  const store = activeTab ? (activeTab.resource as AcpChatTabResource).store : null;

  const visibility = useConversationVisibility(useContext(PageShownContext));
  const rootRef = visibility.ref;
  const reading = useNativeConversationRead(store ? machineRegistry.machineOf(store.runtimeSessionId) : null, store?.runtimeSessionId, visibility.shown, () => {
    const transcript = store?.chatState.transcript.state;
    return transcript ? [...transcript.committedTurns, ...(transcript.activeTurnSnapshot ? [transcript.activeTurnSnapshot] : [])] : [];
  });
  const editorApiRef = useRef<PromptEditorRef | null>(null);
  const viewRef = useRef<ChatView | null>(null);
  const sourceMessage = useSessionSourceMessage(store, viewRef, () => toast({ title: translate('transcript.originalMessageMissing'), variant: 'destructive' }));
  const [composerSlot, setComposerSlot] = useState<HTMLElement | null>(null);
  const [heroSlot, setHeroSlot] = useState<HTMLElement | null>(null);
  const [overlaySlot, setOverlaySlot] = useState<HTMLElement | null>(null);
  // 一个对话框认两种内容:transcript 里的图片走 `src`,输入框里的文本附件走 `text`(#5269)。
  const [viewer, setViewer] = useState<
    { src?: string; alt?: string; text?: string; truncated?: boolean } | null
  >(null);
  const [mermaidViewer, setMermaidViewer] = useState<{ svg: string | null; pending: boolean } | null>(null);
  // Only the latest click may fill the viewer (renders resolve out of order once one has to load mermaid); a newer
  // click or closing the viewer aborts the one before, which also drops it from the render queue.
  const mermaidViewerRender = useRef<AbortController | null>(null);
  const placementSessionRef = useRef<string | null>(null);
  const placementWasEmptyRef = useRef<boolean | null>(null);
  // True while the scroll viewport is at the tail. Defaults to true so the
  // button does not flash on mount before the first frame fires.
  const [atBottom, setAtBottom] = useState(true);
  /** 「这个模型要会员」那一行:由输入框那一格判出来报上来(它手上有目录),面板只负责挂条件行(#7056)。 */
  const [membershipLock, setMembershipLock] = useState<{ modelName: string } | null>(null);
  const [modelMenuRequest, setModelMenuRequest] = useState(0);

  // @@@late-view-binding (#4452) — 晚到的 transcript view 的绑定归 `useBoundChatView`。
  //
  // ⚠️ 它在一个**单独的模块**里，理由只有一个：判据必须能导入**同一份**实现。
  // 这几行原本写在这里，判据自己抄了一份同形的接线去测 —— 于是把产品这段整个回退，
  // 判据照样 2/2 通过（实测）。判据的主语错了，绿灯就是空头支票。
  // ref 保留给回调里按需读取的那几处（键盘命令、滚到底部按钮），它们不依赖渲染时机。
  const {
    view: chatView,
    onReady: bindReadyView,
    onGone: bindGoneView,
  } = useBoundChatView(store);
  const handleReady = useCallback(
    (view: ChatView) => {
      viewRef.current = view;
      bindReadyView(view);
      reading.onReady(view);
      setComposerSlot(view.composerSlot);
      setHeroSlot(view.heroSlot);
      setOverlaySlot(view.contentOverlay);
    },
    [bindReadyView, reading.onReady]
  );
  // transcript 没了时必须把句柄交回去。留着一个已 dispose 的 view 比留 null 更糟：
  // `?.` 不再短路，调用会真的落到一个已释放的 Solid root 上。
  const handleTranscriptGone = useCallback(() => {
    viewRef.current = null;
    bindGoneView();
    setComposerSlot(null);
    setHeroSlot(null);
    setOverlaySlot(null);
  }, [bindGoneView]);
  // A message found by the global search panel is revealed once this task's view is on screen, now or when it opens.
  const sessionId = store?.sessionId;
  const revealSearched = sourceMessage.reveal;
  useEffect(() => {
    if (!chatView || !sessionId) return;
    const take = () => {
      const reference = takeTaskReveal(sessionId);
      if (reference) revealSearched(reference);
    };
    take();
    window.addEventListener(UI_EVENTS.chatAsked, take);
    return () => window.removeEventListener(UI_EVENTS.chatAsked, take);
  }, [chatView, sessionId, revealSearched]);

  /**
   * 滚到顶 ⇒ 往上翻一页(#5381)。
   *
   * 取回来的那一页交给 `view.loadOlder()` —— 它负责 prepend 并把滚动位置钉在原来那一行上,
   * 否则内容一插进去,用户正在看的位置就被顶走了。
   *
   * ⚠️ 到顶会**反复**触发,并发由 store 那侧的 `_loadingOlder` 挡住;翻不动时返回空数组,
   * 这里就什么都不做 —— 到顶是常态,❌ 不是错误,不弹任何东西。
   */
  const handleReachStart = useCallback(() => {
    void sourceMessage.loadOlder();
  }, [sourceMessage.loadOlder]);

  const isSessionEmpty = useObserver(() => store?.isEmpty ?? false);
  const activeSessionId = store?.sessionId ?? null;
  // Keyed on the conversation too: switching conversation re-runs an open query in the new one.
  const findBackend = useMemo<FindBackend | null>(
    () =>
      chatView && activeSessionId
        ? { find: (q) => chatView.find(q), step: (d) => chatView.findStep(d), clear: () => chatView.clearFind() }
        : null,
    [chatView, activeSessionId]
  );
  // A jump opens folds, so searching on every keystroke would open folds for each partial word typed.
  const findBar = useFindBar({ rootRef, backend: findBackend, debounceMs: 150 });
  const chatLayout = useSessionChatLayout();

  // ⚠️ 依赖里是 `chatView` 而不是 `composerSlot`：这条 effect 从不读 composerSlot，它只是
  // 恰好在 view 到达时一起变，所以「句柄晚到时重跑」这件事是**搭便车**来的 ——
  // 一次「清掉没用到的依赖」就会把它变回 #4452 那个形状（对着 null ref 跑一次，然后再不重跑）。
  // 依赖句柄本身，重跑的理由就写在依赖里。
  useEffect(() => {
    if (!store || !chatView) return;
    const sameSession = placementSessionRef.current === store.sessionId;
    const wasEmpty = placementWasEmptyRef.current === true;
    const placement = isSessionEmpty ? 'center' : 'bottom';
    chatView.setComposerPlacement(placement, {
      animate: sameSession && wasEmpty && !isSessionEmpty,
    });
    placementSessionRef.current = store.sessionId;
    placementWasEmptyRef.current = isSessionEmpty;
  }, [store, activeSessionId, isSessionEmpty, chatView]);

  // State-driven notification clearing: mark the active conversation as seen
  // immediately when the panel is showing it. This covers the split-pane case
  // where the same tab stays active and onActivate() does not re-fire.
  const sessionStore = useObserver(() =>
    store
      ? sessionRegistry.get(store.sessionId)?.sessions.get(store.sessionId)
      : undefined
  );
  const { data: agents } = useAgents();
  const providerId = sessionStore?.data.providerId ?? null;
  // 上一轮被宿主的退出打断(开机收残记下的):还是 `error` 时在消息列表末尾说是什么打断的;下一轮开工就不是了。
  const interruptedBy = sessionStore?.status === 'error' ? (sessionStore.data.interruptedBy ?? null) : null;
  const agent = agents?.find((candidate) => candidate.id === providerId) ?? null;
  const startupNotice = agent?.capabilities.acp.startup?.noticeKey;
  const startupNoticeKey = declaredMessageKey(startupNotice);
  // 与 composer、抽屉的「账号」行共用同一份判据(#6100)—— ❌ 不在这里再抄一个 find。
  // 聊天面板跑的是 `acp` 那条腿的程序(#6335):两条腿是两个程序的家,这里登的是聊天面板那个。
  const cliAuthMethod = resolveSignInTarget(agent, 'acp')?.method ?? null;

  // #4900 登录门不是「加载失败」,它只是「还没登录」——一个可推迟的动作。
  // 现在它与其余故障走同一条路:消息列表末尾的一行(spec `session-always-openable`),
  // 所以这里不再需要一个把它从整页覆盖层里摘出来的标志 —— 整页覆盖层本身已经没有了。

  /**
   * 「去登录」= 跳资源库 → 智能体 → 这一家的抽屉,那里有「账号」一行(#6100)。
   *
   * ❌ 不在这里弹登录终端。与隔壁 `harness_not_installed` 那一颗同形(都是把人送到那一页),
   * 也让登录终端只有一个主人 —— 从前 composer、这里、强制登录弹窗各弹一个,而设置页对登录
   * 零表达(B-ui §4.8)。
   *
   * 「我已登录」照旧留在这一行(`store.retry()`):登没登成只有 harness 知道,那一颗是**再问一次**,
   * ❌ 不能被「去登录」顶替(#4900)。
   */
  const openAgentAccount = useCallback(() => {
    if (!providerId || !cliAuthMethod) return;
    navigate('library', { tab: 'agents', agentId: providerId });
  }, [cliAuthMethod, navigate, providerId]);

  /**
   * #6264「登录已失效」:最近一轮因这家的登录不能用了而失败,且这台电脑上它此刻仍标着失效。
   * 两个条件缺一不可 —— 重新登录成功(或别处一次会话成功)撤掉标记的那一刻,这一行自己消失,
   * 而那一轮的失败行照旧留在历史里说「登录已失效」(那是当时的事实)。
   */
  const lastTurnSignIn = useLastTurnSignInRequired(store?.chatState.transcript);
  // #6264 会话在别的机器上:登录读数与重新登录都在那台机器上(与资源库「账号」一行同一条路)。
  const machine = store ? machineRegistry.machineOf(store.projectId) : null;
  const { auth: harnessAuth } = useAgentAuthStatus(providerId, undefined, { probe: false, machine });
  const signInExpired = lastTurnSignIn && isAuthExpired(harnessAuth);
  // 同一个信号(这一轮因凭据不能用而失败),而这家在这台电脑上压根没登录过(MiMo 没 key 时):说「还没登录」。
  const signInMissing = lastTurnSignIn && !signInExpired && harnessAuth?.status?.kind === 'unauthenticated';
  const showSignIn = useShowModal('agentSignInModal');
  const queryClient = useQueryClient();
  /** 「重新登录」直接起这台电脑上那一家的登录窗口(与资源库「账号」一行同一个窗口、同一台发动机)。 */
  const signInAgain = useCallback(() => {
    if (!providerId || !cliAuthMethod) return;
    const refresh = () => {
      void forceRefreshHarnessModelCatalog(queryClient, providerId, 'acp');
      void queryClient.invalidateQueries({ queryKey: harnessModelCredentialKey(providerId) });
    };
    const cliArgs = cliAuthMethod.kind === 'cli-login' ? cliAuthMethod.args : [];
    showSignIn({
      providerId,
      providerName: agent?.name ?? providerId,
      steps: machine
        ? [{ methodId: cliAuthMethod.id }]
        : [
            {
              methodId: cliAuthMethod.id,
              transport: cliAuthMethod.kind === 'acp-authenticate' ? 'acp-authenticate' : 'terminal',
            },
          ],
      ...(machine
        ? {
            remote: {
              deviceId: machine,
              deviceLabel: remoteHostsStore.device(machine)?.label ?? machine,
              headless: cliAuthMethod.kind === 'cli-login' && !!cliAuthMethod.headlessArgs,
              command: [agent?.command?.split(/[\\/]/).filter(Boolean).pop() || providerId, ...cliArgs].join(' '),
            },
          }
        : {}),
      onSuccess: refresh,
      onClose: refresh,
    });
  }, [agent?.name, agent?.command, cliAuthMethod, machine, providerId, queryClient, showSignIn]);

  // #4900 登录 ❌ 不自动发起。owner 2026-09-04:「我不登录也行啊」——自动弹登录终端会
  // 连带跑起厂商的 `<cli> login`,浏览器随即弹出授权页,这就是「强登」本身。
  // 更糟的是它会成环:`retry()` 期间 loadError 短暂为空,任何以「登录门还在不在」为判据的
  // 「只弹一次」都会被重置,于是每点一次「我已登录」就再跑一次 login、浏览器再弹一次。
  // 入口留在下面那条细横幅上,由人点。

  /**
   * 把加载失败翻成消息列表末尾的一行（spec `session-always-openable`）。
   *
   * owner 2026-09-19:「任何 bug 都不应该让会话打不开才对吧,也不应该有任何需要横幅性质的
   * ui 表达,有问题就像消息一样贴消息列表才对吧」。这段就是那条裁决在聊天面板上的落点 ——
   * 此前这里是一张 `inset-0` 的不透明错误页,把已经画好的聊天记录整块盖住。
   *
   * ⚠️ 它 ❌ 不进转录条目:条件消失这一行就该消失(装好引擎之后不许还留着一句「没装」),
   * 所以写的是视图那一格 `session.setCondition`,不是 `transcript`。
   */
  // 会话还在起这件事 ❌ 不进这一格(behavior session-page「打开速度」):首条消息下面那一行自己写「启动中」,计时从发出算;
  // 「正在打开引擎会话」一类的启动步骤对用户不存在。要人做的事(登录、会员)照常在下面说。
  // 「重来」在途:按钮停下,❌ 连点各投一遍首轮。
  const [restarting, setRestarting] = useState(false);
  useEffect(() => {
    if (!store) return;
    // 有没有可重来的首轮,**进这一行之前就知道**(同 ProviderSessionMissingView 的判据)。
    const canRestartSession = Boolean(
      sessionRegistry.get(store.sessionId)?.sessions.get(store.sessionId)?.data
        .firstUtterance
    );
    const setCondition = store.chatState.session.setCondition;
    const error = store.loadError;
    if (!error && membershipLock) {
      // #7056 会员中途到期:说清原因、给两条去路;发送键在输入框那一格已经停下了。
      setCondition({
        code: 'membership-required',
        // 要会员的只有咕咕提供的模型;名字照模型按钮上的叫法(「咕咕 X」),❌ 裸名 —— 用户自己的同名模型不用会员。
        label: guguReasonText('membership-required', translate, membershipLock.modelName),
        detail: 'membership-required',
        // 「我开好了」= 让下拉重取目录:开成了,这一格自然变回 null。
        actions: reasonActions('membership-required', { joinMembership: openMembershipPage, retry: refreshPlatformModelCatalogs }, translate),
      });
      return;
    }
    if (!error && interruptedBy && !signInExpired && !signInMissing) {
      setCondition({
        code: 'turn-interrupted',
        label: translate(INTERRUPTED_LABEL[interruptedBy]),
        detail: `interrupted-by-${interruptedBy}`,
      });
      return;
    }
    if (!error) {
      setCondition(
        signInExpired || signInMissing
          ? {
              code: 'auth-required',
              label: translate(signInExpired ? 'chat.signInExpiredLead' : 'chat.signInMissingLead', {
                agent: agent?.name ?? providerId ?? '',
              }),
              detail: signInExpired ? 'sign-in-expired' : 'sign-in-missing',
              ...(cliAuthMethod
                ? {
                    actions: [{
                      label: translate(signInExpired ? 'chat.signInAgain' : 'transcript.condition.signIn'),
                      run: signInAgain,
                    }],
                  }
                : {}),
            }
          : null
      );
      return;
    }
    const retry = { label: translate('transcript.condition.retry'), run: () => store.retry() };
    const condition = ((): ChatSessionCondition => {
      switch (error.kind) {
        case 'harness_not_installed':
          // 引擎不在盘上 —— 重试修不好它,所以这一行 ❌ 不给「再试一次」,给安装入口。
          return {
            code: 'harness-missing',
            detail: error.message,
            ...(providerId
              ? {
                  actions: [
                    {
                      label: translate('transcript.condition.install'),
                      // 与任务配置页里「去装这个 agent」同一条路(initial-session-section.tsx)。
                      run: () => navigate('library', { tab: 'agents', agentId: providerId }),
                    },
                  ],
                }
              : {}),
          };
        case 'runtime_upgrade':
          // 版本低于下界:说出要几、现在是几(与终端腿 #6341 同一句),给更新入口;升好了点重试。
          return {
            code: 'start-failed',
            label: translate('taskError.runtimeUpgradeRequired', {
              harnessName: agent?.name ?? providerId ?? '',
              supportedFloor: error.supportedFloor,
              installedVersion: error.installedVersion,
            }),
            detail: error.message,
            actions: [
              ...(providerId
                ? [{
                    label: translate('taskError.runtimeUpgradeOpenInstaller', { harnessName: agent?.name ?? providerId }),
                    run: () => navigate('library', { tab: 'agents', agentId: providerId }),
                  }]
                : []),
              retry,
            ],
          };
        case 'harness_updating':
          // 引擎在盘上、正在被换掉,十秒左右自己就好 —— 这一行只说事实,不摆动作。
          return { code: 'harness-updating', detail: error.message };
        case 'auth_required':
          // 两颗都不能少(#4900):「去登录」与「我登好了」是两个动作,后者 ❌ 不能用「重试」顶替。
          return {
            code: 'auth-required',
            detail: error.message,
            actions: [
              ...(cliAuthMethod
                ? [{ label: translate('transcript.condition.signIn'), run: openAgentAccount }]
                : []),
              { label: translate('chat.signInDone'), run: () => store.retry() },
            ],
          };
        case 'provider_session_missing':
          // 上面的聊天记录都还在(库里那份先画出来了);没的是引擎那侧的上下文。
          // ⚠️ 必须给出路:`restartSession` 是全产品唯一一条「照记着的首轮重来」的路
          //    (spec session-resume),此前它只挂在被这次改造拆掉的那张整屏页上。
          //    没有首轮可重来的存量空壳会话不摆这颗 —— ❌ 不摆点下去才发现不行的按钮。
          return {
            code: 'provider-session-missing',
            detail: error.message,
            actions: [
              // The original engine session again (its record may be back): a person's action, never automatic.
              { label: translate('transcript.condition.reconnectOriginal'), run: () => store.retry() },
              ...(canRestartSession
                ? [{
                    label: translate('transcript.condition.startFresh'),
                    pending: restarting,
                    run: () => {
                      if (restarting) return;
                      setRestarting(true);
                      void sessionRegistry
                        .get(store.sessionId)
                        ?.restartSession(store.sessionId)
                        .then(() => store.retry())
                        .catch(() => {})
                        .finally(() => setRestarting(false));
                    },
                  }]
                : []),
            ],
          };
        case 'adapter_lost':
          return {
            code: 'adapter-lost',
            detail: error.message,
            actions: [{ label: translate('transcript.condition.reconnect'), run: () => store.retry() }],
          };
        case 'connection_lost':
          // 断的是到那台机器的线,❌ 引擎:说是哪台、连上后会自己重新打开(store 在线变通时再开);等不及的照样能点。
          return {
            code: 'machine-unreachable',
            label: translate('transcript.condition.machineLinkLost', { device: machineLabel(error.deviceId) }),
            detail: error.message,
            actions: [retry],
          };
        default: {
          // 咕咕这一侧的失败按原因表说、给原因表的按钮(#7103);咕咕以外的(harness / provider)递它的原话(#4657)+ 重试。
          const reason = failureReason(error.message);
          const membership = reason !== null && guguReasonCopy(reason).action === 'join-membership';
          const text = failureText(error.message, translate, membership ? membershipLock?.modelName : null);
          if (!reason) {
            const at = sessionLifeView(store.runtimeSessionId)?.failure?.at;
            const lead = at ? translate('chat.lifeStageFailed', { stage: translate(`chat.lifeStage.${at}`) }) : translate('transcript.condition.startFailed');
            return { code: 'start-failed', label: `${lead}: ${text}`, detail: text, actions: [retry] };
          }
          return {
            code: membership ? 'membership-required' : 'start-failed',
            label: text,
            detail: `gugu-models:${reason}`,
            actions: reasonActions(reason, {
              // 人点的:先让宿主清掉签咕咕额度的退避,真去问一次;会员可能是在别处开的,先重取目录。
              retry: () => {
                refreshPlatformModelCatalogs();
                void askPlatformAgain(store.runtimeSessionId).then(() => store.retry());
              },
              switchModel: () => setModelMenuRequest((value) => value + 1),
              joinMembership: openMembershipPage,
            }, translate),
          };
        }
      }
    })();
    setCondition(condition);
  }, [store, store?.loadError, providerId, cliAuthMethod, openAgentAccount, translate, navigate, signInExpired, signInMissing, signInAgain, agent?.name, membershipLock, interruptedBy, restarting]);

  /**
   * 还在跑的后台命令与子智能体 → 消息列表末尾那一行(owner 2026-10-27:去掉右上角「摘要」卡,后台任务放进主对话)。
   * 收集逻辑与从前那张卡同一套(`background-task-rosters.ts`):每来一条消息、运行时报的在跑集合变了、人按了 ×,重算一次;
   * 内容没变,转录那一格自己会挡住(`sameBackgroundTasks`)。
   */
  useEffect(() => {
    if (!store) return;
    return autorun(() => {
      store.chatState.session.setBackgroundTasks({
        commands: collectBackgroundCommands(store.sessionId, translate('transcript.backgroundCommand')),
        subagents: collectSubagents(store.sessionId, translate('transcript.subagent')),
      });
    });
  }, [store, translate]);

  useMarkSeenWhenShown(sessionStore, visibility.shown && !store?.isTransient);

  useEffect(() => {
    if (!store) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const root = rootRef.current;
      if (!root || !eventComposedPathContains(event, root)) return;

      const commandId = chatViewCommandForShortcut(event);
      if (!commandId) return;
      if (!executeChatViewCommand(viewRef.current, commandId)) return;

      event.preventDefault();
      event.stopPropagation();
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, [store]);

  const handleViewerOpen = useCallback((src?: string, alt?: string) => {
    setViewer({ src, alt });
  }, []);

  /** 输入框里点开一枚 chip:图片进看图查看器,文本给 `text` —— 由 chip 手上有什么决定(#5269)。 */
  const handleAttachmentView = useCallback((att: ComposerAttachment) => {
    if (openComposerImage(att)) return;
    setViewer({
      alt: att.name,
      text: att.previewText,
      truncated: att.previewTruncated,
    });
  }, []);

  // 空态建议芯片的内容来自**用户自己的提示词库** —— 不是编出来的占位文案。
  // 库为空时 `suggestions` 为空数组,ThreadWelcome 直接不渲染建议区。
  const { value: promptLibrary } = usePromptLibrary();
  const welcomeSuggestions = useMemo<ThreadSuggestion[]>(
    () =>
      promptLibrary.slice(0, WELCOME_SUGGESTION_LIMIT).map((prompt) => ({
        id: prompt.id,
        title: prompt.title,
        prompt: prompt.prompt,
      })),
    [promptLibrary]
  );
  const handleSelectSuggestion = useCallback(
    (suggestion: ThreadSuggestion) => {
      // submitPrompt toasts a failure; the suggestion stays on screen to click again.
      void store?.submitPrompt(suggestion.prompt).catch(() => undefined);
    },
    [store]
  );

  // 附件卡右边「侧边栏 ▾」那张打开方式菜单(#7193)。
  const outputMenu = useOpenedOutputMenu({ projectId: store?.projectId ?? '', sessionId: store?.sessionId ?? '' });

  const historyActionsEnabled = store?.canRevertHistory ?? false;
  const messageEdit = store?.messageEdit;
  const messageEditPending = store?.reverting ?? false;
  // The agent speaking in this transcript is this task; its name is the task's one name.
  const conversationAgentName = sessionStore?.data.title ?? null;
  const quotes = useSessionMessageQuotes(store, editorApiRef);
  const transcriptCommands = useMemo<ChatCommands>(
    () => ({
      ...outputMenu.commands,
      onConversationReply: sourceMessage.reveal,
      onMessageTextMount: quotes.onMessageTextMount,
      flashMessageId: sourceMessage.flashMessageId,
      conversationAgentName: () => conversationAgentName,
      conversationAgentSession: () => store?.sessionId ?? null,
      onOpenSender: openMessageSender,
      classifyLink: classifyFileLink,
      onOpenLink: followConversationLink,
      // transcript 自己那颗停止按钮（用户消息卡右下角）一直**没有**接过宿主 ——
      // `commands().onStop?.()` 在 `?.` 上整条短路，按下去一个字节都不发（#3498 查出来的，
      // 与 #3500 同形）。composer 上那颗是另一条路，它一直是通的，于是这颗死按钮
      // 被它掩护着看不出来。⇒ 这里补上；同时 UserMessageCard 改成没接回调就不渲染。
      canRevertMessage: (itemId) => historyActionsEnabled && (store?.canRevertMessage(itemId) ?? false),
      onEditMessage: ({ itemId }) => store?.beginMessageEdit(itemId),
      editingMessage: messageEdit ? {
        ...messageEdit,
        pending: messageEditPending,
        canSubmit: historyActionsEnabled && messageEdit.text.trim().length > 0,
        onChange: (text) => store?.changeMessageEdit(messageEdit.itemId, text),
        onCancel: () => store?.cancelMessageEdit(messageEdit.itemId),
        onSubmit: () => void store?.sendMessageEdit(messageEdit.itemId),
      } : undefined,
      onStop: () => {
        if (!store) return;
        store.stop();
      },
      // ⚠️ 只写草稿，**不发送**。接成 submitPrompt 就把「取回指令」偷换成「重发」——
      // 而重发不是重试（出错的那一轮可能已经写过文件、调过工具），
      // 那正是 #3498 拒绝交付的那个会骗人的按钮。见 ChatCommands.onRestorePrompt。
      onRestorePrompt: quotes.restorePrompt,
      onContinueTurn: () => {
        // A message stopped before it went has nothing to continue from: it just goes now.
        if (store?.stoppedRowId) store.continueStoppedRow();
        else continueSessionTurn(store, translate('transcript.continueTurnPrompt'));
      },
      onDiscardTurn: ({ turnId }) => store?.discardStoppedTurn(turnId),
      canDiscardTurn: (turnId) => store?.canDiscardTurn(turnId) ?? true,
      // 计划审批卡上的选项（#7139）：与输入框上那条审批同一个答法。
      onResolvePermission: ({ requestId, optionId }) => store?.resolvePermission(requestId, optionId),
      // #7103 咕咕拒了这一轮的票:「回合失败」那一行按原因表说那一句、给那个按钮(与起会话失败同一张表)。
      // 这一行没有「重来」:要再发就是「取回指令」那一颗。
      describeRefusal: (guguReason) => {
        const reason = guguReasonOf(guguReason);
        const [action] = reasonActions(reason, {
          switchModel: () => setModelMenuRequest((value) => value + 1),
          joinMembership: openMembershipPage,
        }, translate);
        const modelName = guguReasonCopy(reason).action === 'join-membership' ? membershipLock?.modelName : null;
        return { text: guguReasonText(reason, translate, modelName), ...(action ? { action } : {}) };
      },
      // 图片与文件是同一个回调,宿主按 kind 分岔(#5269)。文件走的是与从前那枚正文 pill
      // **一模一样**的打开路径 —— 它已经会先问一句「这条路径有没有副本」(见
      // `openExternalFilePath`),❌ 别在这儿另写一套解析。
      onViewAttachment: (arg: {
        attachment: { id: string; name: string; kind?: 'image' | 'file'; dataUrl?: string };
        itemId: string;
        source: 'user-message';
        thumb?: HTMLElement;
      }) => {
        if (arg.attachment.kind === 'file') {
          const path = pathAttachmentTarget(arg.attachment.id);
          if (!path || !store) return;
          // ⚠️ 走 `onOpenExternal`,❌ 不是 `onOpenFile`:后者先要一个**工作区**
          // (`workspaceRegistry.get` 空就静默 return),而「未选择项目」建出来的任务根本没有
          // ——附件不是工作区文件,它自己就带着一条绝对路径(#5269)。
          makeFileLinkHandlers(store.projectId, store.sessionId, { beside: true }).onOpenExternal(path);
          return;
        }
        // 字节读不回来时由附件对话框如实说「没有可预览的内容」
        const viewImage = (src: string | null | undefined) =>
          src
            ? openImageViewer([{ url: src, alt: arg.attachment.name, file: { name: arg.attachment.name }, thumb: arg.thumb }])
            : handleViewerOpen(undefined, arg.attachment.name);
        if (arg.attachment.dataUrl || !store) {
          viewImage(arg.attachment.dataUrl);
          return;
        }
        void resolveAttachmentDataUrl(store, arg.attachment.id).then(viewImage);
      },
      // 工具交回来的图:同一个看图器,一次调用的几张图是一组,从被点的那张起。
      onViewImages: (arg) =>
        openImageViewer(
          arg.urls.map((url, index) => ({ url, alt: '', thumb: index === arg.index ? arg.thumb : undefined })),
          arg.index
        ),
      resolveToolImage: (itemId, index) => store?.resolveToolImage(itemId, index) ?? Promise.resolve(null),
      resolveAttachment: (attachment) =>
        store ? resolveAttachmentDataUrl(store, attachment.id) : Promise.resolve(null),
      onViewMermaid: (arg) => {
        if (!store) return;
        mermaidViewerRender.current?.abort();
        const render = new AbortController();
        mermaidViewerRender.current = render;
        const caches = store.chatContext.sharedCaches;
        const theme = readMermaidTheme();
        const cached = caches.peekMermaid(arg.chart, theme);
        setMermaidViewer({ svg: cached, pending: cached === null });
        if (cached !== null) return;
        void caches.renderMermaid(arg.chart, theme, render.signal).then((svg) => {
          if (!render.signal.aborted) setMermaidViewer({ svg, pending: false });
        });
      },
      onOpenFile: (arg) => {
        if (!store) return;
        if (arg.source === 'diff') {
          void openFileBesideConversation(store.projectId, store.sessionId, arg.path);
          return;
        }
        makeFileLinkHandlers(store.projectId, store.sessionId, { beside: true }).onOpenFile(arg.path, arg.at);
      },
      onOpenOutput: ({ output }) => {
        if (!store) return;
        reopenSessionOutput(store.projectId, store.sessionId, output);
      },
      onClickMention: (arg: Parameters<NonNullable<ChatCommands['onClickMention']>>[0]) => {
        if (!store) return;
        if (arg.kind === 'file') {
          makeFileLinkHandlers(store.projectId, store.sessionId, { beside: true }).onOpenFile(arg.id);
          return;
        }
        if (arg.kind === 'issue') {
          const target = parseIssueMentionToken(arg.id);
          if (!target) return;
          void rpc.issues
            .getIssueContext(target.provider, {
              identifier: target.identifier,
              projectId: store.projectId,
            })
            .then((result) => {
              if (result.success && result.data.url) {
                void rpc.app.openExternal(result.data.url);
              }
            });
        }
      },
      // 列表末尾那一行后台任务上的两颗键(原来在右上角「摘要」卡里)。停 = 真停;× = 只收起,它照旧在跑。
      onStopBackgroundTask: ({ stopId }) => store?.stopSubagent(stopId),
      onDismissBackgroundTask: ({ entryId }) => {
        if (store) dismissSubagent(store.sessionId, entryId);
      },
    }),
    [store, quotes.onMessageTextMount, quotes.restorePrompt, sourceMessage.reveal, sourceMessage.flashMessageId, conversationAgentName, historyActionsEnabled, messageEdit, messageEditPending, handleViewerOpen, translate, membershipLock?.modelName, outputMenu.commands]
  );

  // A freshly-created task can publish its tab before the resource manager has finished attaching
  // the conversation store. Keep the task surface mounted during that hand-off; returning a bare
  // null leaves the ACP session page visually blank and gives the user no usable empty/loading state.
  if (!store) {
    return (
      <div
        className="flex h-full w-full items-center justify-center bg-background-secondary-1 text-foreground-muted"
        data-session-chat-surface={tabKind === 'side-chat' ? 'side-chat' : 'source'}
        data-session-chat-loading="true"
      >
        <LoadingIndicator ariaLabel={translate('chat.loading')} label={translate('chat.loading')} />
      </div>
    );
  }

  // ACP bootstrap only owns transcript readiness. Keep the composer mounted while the runtime
  // creates the starting machine and accepts prompts into its queue.
  // 会话永远打得开,输入框就永远在(spec `session-always-openable`)。打进去的话进队列,
  // 引擎一好就发出去 —— ❌ 不再因为 loadError 把整个 composer 从 DOM 里摘掉,
  // 那让「看得见但动不了」变成了另一种打不开。
  //
  // ⚠️ 例外只有侧边对话(`isTransient`):它是运行时视图,**自己没有一份历史**,
  //    分叉失败时那条会话压根不存在 —— 摆一个发不出去的输入框比不摆更坏。
  //    真实会话不适用这条:它们的记录在库里,输入进队列等引擎就绪即可。
  const showComposer = !store.isTransient || store.loadError === null;
  const showHero = showComposer && store.isEmpty;

  return (
    <div
      ref={rootRef}
      data-session-chat-surface={tabKind === 'side-chat' ? 'side-chat' : 'source'}
      data-session-chat-session-id={store.sessionId}
      data-side-chat-runtime-view-id={
        tabKind === 'side-chat' ? store.runtimeView?.id : undefined
      }
      data-session-chat-show-composer={showComposer ? 'true' : 'false'}
      data-session-chat-composer-slot={composerSlot ? 'present' : 'absent'}
      // Focusable (outside the Tab order) so ⌘F pressed after clicking the transcript lands in this panel.
      tabIndex={-1}
      className={`relative h-full overflow-hidden bg-background-secondary-1 outline-none ${nativeChatAppearance}`}
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="relative min-h-0 flex-1">
          <ChatTranscript
            context={store.chatContext}
            state={store.chatState}
            composer="slot"
            composerPlacement={store.isEmpty ? 'center' : 'bottom'}
            contentOverlay
            stickToBottom
            pinUserMessages={tabKind !== 'side-chat'}
            onReady={handleReady}
            onDisposed={handleTranscriptGone}
            commands={transcriptCommands}
            shown={visibility.shown}
            onVisibleItems={reading.onVisibleItems}
            onAtBottomChange={setAtBottom}
            onReachStart={handleReachStart}
            layout={{ ...chatLayout, agentConversation: true }}
            style={{ position: 'absolute', inset: 0 }}
          />
        </div>
      </div>
      {/* Same z-index as the composer layer: placed after the transcript so it paints above it. */}
      <FindBar {...findBar} />
      {outputMenu.menu}

      {/* 加载态。⚠️ **只在没东西可看时**才盖 —— 库里那份历史是先画出来的(#5381),
          已经有内容还盖一层不透明底,等于把用户自己说过的话藏起来
          (spec `session-always-openable`)。
          ❌ 这里不再有任何错误分支:失败一律是消息列表末尾的一行(session-condition),
          见本文件 useEffect「把加载失败翻成列表里的一行」。 */}
      {overlaySlot &&
        store.historyLoading &&
        store.loadError === null &&
        store.isEmpty &&
        createPortal(
          <div
            className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background-secondary-1 text-sm text-foreground-muted"
            aria-live="polite"
          >
            <LoadingIndicator
              ariaLabel={translate('chat.loading')}
              label={
                startupNoticeKey ? translate(startupNoticeKey) : translate('chat.loading')
              }
              data-testid="acp-chat-history-loading"
            />
          </div>,
          overlaySlot
        )}

      {/* #4900 那条贴顶横幅已退役 —— owner 2026-09-19:「不应该有任何需要横幅性质的 ui 表达,
          有问题就像消息一样贴消息列表才对吧」。它的两颗动作(「去登录」与「我登好了」)
          原样搬进了消息列表末尾那一行,见下面把 loadError 翻成 condition 的那段。 */}

      {showHero &&
        heroSlot &&
        createPortal(
          <ThreadWelcome
            title={translate('chat.hero')}
            suggestions={welcomeSuggestions}
            onSelectSuggestion={handleSelectSuggestion}
            suggestionsLabel={translate('chat.suggestions')}
          />,
          heroSlot
        )}

      {showComposer && composerSlot && (
        <ComposerForStore
          key={store.sessionId}
          store={store}
          editorApiRef={editorApiRef}
          composerSlot={composerSlot}
          onViewAttachment={handleAttachmentView}
          onScrollToBottom={() => viewRef.current?.scrollToBottom({ behavior: 'smooth' })}
          modelMenuRequest={modelMenuRequest}
          onMembershipLockChange={setMembershipLock}
        />
      )}

      {/* 贴底状态是**单向**从 transcript 的 onAtBottomChange 流进来的:这里只读 `atBottom`
          并回调 scrollToBottom,不引入 assistant-ui 的 Viewport(那会变成第二个 scrollTop 写者)。 */}
      {showComposer &&
        composerSlot &&
        createPortal(
          <ThreadScrollToBottom
            atBottom={atBottom}
            label={translate('chat.scrollToBottom')}
            onScrollToBottom={() => viewRef.current?.scrollToBottom({ behavior: 'smooth' })}
          />,
          composerSlot
        )}

      <AttachmentViewerDialog
        open={!!viewer}
        onOpenChange={(open) => {
          if (!open) setViewer(null);
        }}
        src={viewer?.src}
        text={viewer?.text}
        truncated={viewer?.truncated}
        name={viewer?.alt}
      />
      <MermaidViewerDialog
        open={!!mermaidViewer}
        onOpenChange={(open) => {
          if (open) return;
          mermaidViewerRender.current?.abort();
          setMermaidViewer(null);
        }}
        svg={mermaidViewer?.svg ?? null}
        pending={mermaidViewer?.pending ?? false}
      />
    </div>
  );
});

function eventComposedPathContains(event: Event, element: HTMLElement): boolean {
  if (event.composedPath().includes(element)) return true;
  return event.target instanceof Node && element.contains(event.target);
}
