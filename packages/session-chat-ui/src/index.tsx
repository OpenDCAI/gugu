/** @jsxImportSource solid-js */
/**
 * @gugu/session-chat-ui public API.
 *
 * Three primitives following the CodeMirror EditorState/EditorView split:
 *
 *   createChatContext(opts) — global services singleton (theme, highlighter,
 *                             shared caches, measureEpoch). Create once per app.
 *   createChatState(ctx)   — per-conversation state (transcript + parse caches).
 *   createChatView(opts)   — per-mount DOM owner (virtualizer, scroll, scheduler).
 *
 * Quick start:
 *   const ctx  = createChatContext({ highlighter });
 *   const st   = createChatState(ctx);
 *   const view = createChatView({ context: ctx, state: st, parent, composer: 'slot' });
 *   st.transcript.history.seed(items);
 *   // After mount:
 *   ReactDOM.createPortal(<ChatComposer />, view.composerSlot!);
 *   // Cleanup:
 *   view.dispose();
 *   st.dispose();
 *   ctx.dispose();
 */

import './styles/global.css';
import '@gugu/session-shared/animation-visibility.css';

// ── Core API ──────────────────────────────────────────────────────────────────

export { createChatContext } from './chat-context';
export type { ChatContext, ChatContextOptions } from './chat-context';
export type { ChatTranslator, ChatTranslationSubscriber, ChatTranslationValues } from './localization';

export { connectSession, createChatState, tailMode, pinTopMode } from './state/chat-state';
export { pendingPromptTurn } from './state/pending-prompt';
export type {
  ChatState,
  ChatStateOptions,
  ScrollMode,
  HeightmapStore,
  ChatSessionState,
  ChatSessionSnapshot,
  PendingPrompt,
  ConnectSessionSource,
  ConnectSessionOptions,
} from './state/chat-state';

export { createChatView } from './chat-view';
export type {
  ChatView,
  ChatViewOptions,
  ComposerPlacement,
  ComposerPlacementOptions,
} from './chat-view';
export type { ChatFindStatus } from './find';

// ── Data types ────────────────────────────────────────────────────────────────

export type {
  SessionCondition,
  SessionConditionCode,
  ChatItem,
  ChatMessage,
  ChatAttachment,
  ChatImageAttachment,
  ChatToolCall,
  ChatThinking,
  ChatFileOpToolCall,
  ChatExecute,
  ChatDiff,
  ChatResourceLink,
  ResourceTarget,
  OpenedOutput,
  OpenedOutputItem,
  ChatPlan,
  ChatPlanEntry,
  PlanEntryStatus,
  PlanEntryPriority,
  ChatRole,
  FileOpKind,
  FileOp,
  ToolStatus,
  TranscriptTurn,
  TranscriptItem,
  ToolNode,
  AcpPermissionRequest,
  PlanState,
} from './model';

// ── Transcript API ────────────────────────────────────────────────────────────

export type { TurnStatus, TranscriptApi, ChatHistory } from './state/transcript';

// ── Theme ─────────────────────────────────────────────────────────────────────

export type {
  ChatConfig,
  ChipConfig,
  ChatTheme,
  FontConfig,
  FontFamilies,
  ResolvedTheme,
  RoleName,
  TypeRole,
} from './core/theme';
export { buildChatTheme, DEFAULT_CONFIG, DEFAULT_LAYOUT, DEFAULT_THEME, isDoubleColumnLayout } from './core/theme';
export type { ChatLayout, ChatLayoutPreset } from './core/theme';

// ── Highlighter ───────────────────────────────────────────────────────────────

export type { ChatHighlighter, HighlightResult, CodeToken } from './core/highlight/highlighter';
export { createDefaultHighlighter } from './core/highlight/highlighter';

// ── Mention provider ─────────────────────────────────────────────────────────

export type {
  MentionProvider,
  ChatMentionMeta,
  ChatMentionKind,
} from './core/markdown/mention-provider';

// ── Command provider ──────────────────────────────────────────────────────────

export type { CommandProvider, ChatCommandMeta } from './core/markdown/command-provider';

// ── Commands + scroll helpers ─────────────────────────────────────────────────

export { CHAT_VIEW_COMMANDS } from './commands';
export type {
  ChatCommands,
  ChatViewCommand,
  ChatViewCommandId,
  ScrollToItemOptions,
} from './commands';

// ── Dev helpers ───────────────────────────────────────────────────────────────

/**
 * 子智能体花名册 —— 宿主在「输出/来源」面板里画上游那个 `elements-subagent-list`
 * (owner 2026-09-05 定的位置)。转录只出 tool call 行,汇总视图在面板。
 */
export { collectSubagentRoster } from './lib/subagent-roster';
export { formatElapsed } from './lib/format-elapsed';
export type { SubagentRosterEntry } from './lib/subagent-roster';

/**
 * 还在跑的后台命令(主智能体自己起的 `run_in_background` Bash)—— 与子智能体分开一节,
 * 因为它不挂住这一轮:轮收口了它还在跑,面板是唯一能停它的地方(#5117)。
 */
export { collectBackgroundCommandRoster, runningBackgroundTaskIds } from './lib/background-command-roster';
export type { BackgroundCommandEntry } from './lib/background-command-roster';

export { shownSender, selfIdentityLabel, isSelfAddress } from './lib/self-identity';
export type { SelfIdentity } from './lib/self-identity';
export { generateMockTranscript, mockMentionProvider } from './mock-transcript';

// ── Cache types (for advanced use) ────────────────────────────────────────────

export type { ChatCaches, SharedCaches, ParseCaches } from './core/caches';
export { createChatCaches } from './core/caches';
export { messageSenderTarget, type MessageSenderTarget } from './lib/sender-target';
