/**
 * Public types for the PromptEditor component.
 * Keep this file dependency-free (no TipTap imports) so consumers can type-check
 * without pulling the whole editor bundle.
 */

import type { ReactNode } from 'react';

// ── Mention items (@ trigger) ─────────────────────────────────────────────────

export type MentionKind = 'file' | 'issue' | 'symbol' | 'custom';
export type MentionRole = 'human' | 'agent';

export interface MentionItem {
  /** Stable unique identifier (e.g. a file path or issue identifier). */
  id: string;
  /**
   * Serialization label — written as `@label` in clipboard / plain-text output.
   * Typically the full path for files.
   */
  label: string;
  /** Semantic category used for rendering (icon, chip colour, etc.). */
  kind: MentionKind;
  /** Optional role shown for session-peer suggestions. */
  role?: MentionRole;
  /** Harness engine for agent session peers; kept out of mention serialization. */
  engine?: string;
  /**
   * Short display name shown inside the inline pill.
   * Defaults to the basename of `label` when not provided.
   */
  name?: string;
  /**
   * Host-owned icon rendered in the suggestion popup. When absent, the popup
   * uses the identity resolver, `renderMentionIcon`.
   */
  icon?: ReactNode;
  /** Optional secondary description shown in the popup row. For agent peers, this is the sidebar title. */
  description?: string;
  /** Host-owned information in the suggestion row, separate from the serialized name. */
  optionLabel?: ReactNode;
  /** Display-only annotation, e.g. a reference to someone outside this group. */
  annotation?: string;
  /** When provided, selecting this item inserts raw text instead of a mention node. */
  insertText?: string;
  /** Host-controlled resolving state for mention pills. Not included in plain-text serialization. */
  pending?: boolean;
  /** 弹层里的一行说明(例如「还没读到那台机器上的任务」):照样列出,选不了,❌ 插进消息。 */
  disabled?: boolean;
}

export type RenderMentionIcon = (attrs: {
  id: string;
  label: string;
  kind: MentionKind;
  name?: string;
  role?: MentionRole | null;
  engine?: string | null;
}) => ReactNode | null;

// ── Context mention provider ──────────────────────────────────────────────────

/**
 * Injectable provider that the host application wires to supply @ mention
 * suggestions. Prefer this over the lower-level `queryMentions` callback when
 * building a typed feature — it is easier to extend (group metadata, async
 * cancel, etc.) without breaking the component API.
 */
export interface ContextMentionProvider {
  allowSpaces?: boolean;
  emptyLabel?: string;
  isQueryActive?(query: string): boolean;
  /** Restore a serialized reference without treating arbitrary text as a mention. */
  resolve?(target: string, label: string): MentionItem | null;
  /**
   * Return suggestions matching the given partial query string. `requery`:编辑器在 `onResultsChanged` 之后按同一个查询
   * 再查一次(不是用户的新输入)。
   */
  search(query: string, options?: { requery?: boolean }): Promise<MentionItem[]>;
  /**
   * 结果可能变了(例如文件索引刚重扫完):弹层还开着的话,编辑器按当前的查询再查一次、原地换掉列表。
   * 返回退订。
   */
  onResultsChanged?(listener: () => void): () => void;
}

// ── Command items (/ trigger) ─────────────────────────────────────────────────

/**
 * 'insert' → insert a /token node into the doc.
 * 'insert-text' → insert raw text into the doc.
 * 'execute' → run a side-effect and clear the trigger.
 */
export type CommandBehavior = 'insert' | 'insert-text' | 'execute';

export interface CommandItem {
  id: string;
  /** Short display name (no leading slash). */
  name: string;
  /**
   * 选中这一条时**逐字**插进输入框、并原样发给 agent 的文本。
   *
   * 编辑器不认识任何一家的命名规矩:ACP 的 `AvailableCommand.name` 有的是裸词
   * (claude / opencode)、有的自带 sigil(codex 把 skill 报成 `$name`),那条规则属于
   * ACP 领域,住在 `@gugu/session-core/acp/commands` 的 `commandToken`,由宿主算好传进来。
   * ❌ 编辑器不许自己拼前缀 —— 那正是 `/$my-skill` 那个 bug 的形状。
   *
   * 缺席时回落 `/${name}`,只服务不经 ACP 的调用方。
   */
  token?: string;
  /** Text displayed in the popup. Defaults to name if omitted. */
  label?: string;
  description?: string;
  behavior: CommandBehavior;
  /** Raw text inserted for behavior='insert-text'. */
  insertText?: string;
  /**
   * ACP `AvailableCommand.input.hint` —— 这条命令后面要跟什么。
   * 实测 codex 的 `/review-branch` 给 `branch name`、`/review` 给 `optional review instructions`；
   * 不摆出来用户就只能猜。缺席 = 这条命令不吃参数。
   */
  inputHint?: string;
  /** Optional visual grouping label in the slash command popup. */
  section?: string;
}

// ── Props ─────────────────────────────────────────────────────────────────────

export interface PromptEditorRef {
  /** Focus the editor, optionally moving the caret to a document boundary. */
  focus(position?: 'start' | 'end'): void;
  /** Clear all content. */
  clear(): void;
  /** Read the current serialized plain text. */
  getText(): string;
  /** Replace the editor contents with serialized plain text. */
  setText(text: string): void;
  /** Insert serialized paragraphs at a document boundary without replacing existing content. */
  insertText(text: string, position: 'start' | 'end'): void;
  /** Imperatively insert a mention node at the current cursor position. */
  insertMention(item: MentionItem): void;
  /** Ensure a mention node exists at the start of the editor, replacing duplicates. */
  prependMention(item: MentionItem): void;
  /** Remove all mention nodes with the given id. */
  removeMention(id: string): void;
  /** Update the pending state for mention nodes with the given id. */
  setMentionPending(id: string, pending: boolean): void;
}

export interface PromptEditorProps {
  inputTestId?: string;
  inputRef?: (element: HTMLElement | null) => void;
  enterBehavior?: 'submit' | 'newline';
  /** Controlled placeholder text when the editor is empty. */
  placeholder?: string;
  /** Whether the editor is disabled (read-only, no input). */
  disabled?: boolean;
  /** Called with the serialized plain-text value on every change. */
  onChange?: (text: string) => void;
  /**
   * 粘贴纯文本时先问一句宿主要不要它。返回 `true` = 宿主收走了，编辑器**不**插入。
   *
   * ⚠️ 这个钩子必须长在编辑器里面，❌ 不能由外层容器的 `onPaste` 代劳:ProseMirror 在
   * 事件到达目标节点时就把文本插进去了，外层(React 挂在根容器上)拿到事件已是插入之后 ——
   * 那时再 `preventDefault()` 只会得到一个「已经插进去了、但 defaultPrevented 是 true」的
   * 假象。#5269 第一版正是这么写的，被真 DOM 判据当场判红。
   */
  onPasteText?: (text: string) => boolean;
  /**
   * 宿主自己处理的拖放载荷类型(`DataTransfer.types` 里的 MIME)。
   *
   * 列在这里的一次拖放,编辑器**什么都不做**,只把 ProseMirror 拦下来:不拦的话它会按自己那套
   * 规矩把 `text/plain` / `text/html` 插进正文,于是同一次拖放既落下宿主要的东西、又多出一段
   * 裸文字。事件照旧冒泡,所以挂在外层的宿主 `onDrop` 仍然收得到,且只收到这一次。
   */
  hostDropTypes?: readonly string[];
  /** Called when the user submits (Enter with no open suggestion). */
  onSubmit?: (text: string) => void;
  /** Transactional edits retain their document until the host acknowledges the save. */
  clearOnSubmit?: boolean;
  /** Called after a mention node is inserted. Raw insertText entries do not trigger this. */
  onMentionInsert?: (item: MentionItem) => void;
  /**
   * Preferred: typed provider for @ mention suggestions.
   * When both `mentionProvider` and `queryMentions` are provided,
   * `mentionProvider` takes precedence.
   */
  mentionProvider?: ContextMentionProvider;
  /**
   * Optional host renderer for mention suggestion icons. Used when the host owns
   * provider-specific assets that this package cannot import directly.
   */
  renderMentionIcon?: RenderMentionIcon;
  /**
   * Legacy: async callback that returns @ mention suggestions.
   * Kept for back-compat; prefer `mentionProvider` for new integrations.
   */
  queryMentions?: (query: string) => Promise<MentionItem[]>;
  /**
   * Async callback that returns / command suggestions for the given query.
   * Return an empty array if no commands are available.
   */
  queryCommands?: (query: string) => Promise<CommandItem[]>;
  /**
   * Called when a / command with behavior='execute' is selected.
   * The trigger range is deleted; text is NOT inserted.
   */
  onCommand?: (item: CommandItem) => void;
  /**
   * This session's already-sent prompts, oldest first, for ↑↓ recall (behavior session-page
   * 「键盘导航」). A getter rather than an array: it is read on the keypress, so the host can
   * derive it from the live transcript without re-rendering the editor. Omit to leave ↑↓ as plain
   * caret movement.
   */
  getPromptHistory?: () => readonly string[];
  className?: string;
}
