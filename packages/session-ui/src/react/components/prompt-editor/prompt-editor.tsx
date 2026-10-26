/**
 * PromptEditor
 *
 * A TipTap (ProseMirror) based prompt input that supports:
 *  - Inline @ mention chips (inserted as atomic nodes, serialized as @label).
 *  - Inline / command chips (insert) or executed side-effects (execute).
 *  - Auto-growing height up to a CSS max-height with scroll overflow.
 *  - Copyable as plain text (mentions/commands flatten to @label / /name).
 *  - Enter to submit (when no suggestion open); Shift+Enter for hard break.
 *
 * Data sources are injected as async callbacks so the component is agnostic
 * to where mentions and commands come from. Prefer `mentionProvider` over
 * `queryMentions` for new integrations.
 */

import { useUiPortalContainerOrBody } from '@session-ui/react/lib/portal-container';
import { cx } from '@session-ui/styles/utilities/cx';
import { EditorContent, useEditor } from '@tiptap/react';
import { Slice } from '@tiptap/pm/model';
import { StarterKit } from '@tiptap/starter-kit';
import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion';
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  useMemo,
} from 'react';
import type React from 'react';
import { createPortal } from 'react-dom';
import {
  ComboboxPopup,
  type ComboboxPopupHandle,
  type ComboboxPopupItem,
} from '../../primitives/combobox/combobox-popup';
import { fallbackToken } from './command-token';
import { buildMentionExtension } from './extensions/mention';
import { buildSlashCommandExtension } from './extensions/slash-command';
import { buildSubmitKeymap } from './extensions/submit-keymap';
import { buildPromptHistoryKeymap } from './extensions/prompt-history-keymap';
import { compactMentionPath } from './mention-pill-helpers';
import { mentionInsertContent, plainTextDoc, serializeDoc, serializeNode } from './serialize';
import type {
  CommandItem,
  MentionItem,
  PromptEditorProps,
  PromptEditorRef,
  RenderMentionIcon,
} from './types';
import * as styles from './prompt-editor.css';

function mentionToPopupItem(item: MentionItem, renderMentionIcon?: RenderMentionIcon): ComboboxPopupItem {
  if (item.disabled) return { id: item.id, label: item.name ?? item.label, disabled: true };
  const name = item.name ?? item.label;
  const icon = item.icon ?? renderMentionIcon?.({ id: item.id, label: item.label, name, kind: item.kind, role: item.role, engine: item.engine });
  const agentTitle = item.role === 'agent' ? item.description?.trim() ?? '' : '';
  const isStackedAgent = item.role === 'agent' && agentTitle.length > 0;
  const isFile = item.kind === 'file';
  const filePath = isFile ? compactMentionPath(item.label) : undefined;
  return {
    id: item.id,
    label: isStackedAgent ? agentTitle : name,
    labelContent: item.optionLabel,
    // File rows already show a stable path tail; an initial avatar adds no
    // information and makes same-name files look like duplicates.
    avatarLabel: icon || isFile ? undefined : firstInitial(name),
    icon,
    description: isFile
      ? filePath
      : item.role === 'agent'
      ? isStackedAgent
        ? `${name} · agent`
        : undefined
      : item.role ?? item.description ?? (item.name && item.label !== item.name ? item.label : undefined),
    stacked: isStackedAgent || isFile,
    descriptionMono: isStackedAgent || isFile,
  };
}

function firstInitial(value: string): string {
  const initial = Array.from(value.trim()).find((character) => /\p{L}|\p{N}/u.test(character));
  return initial ? initial.toLocaleUpperCase() : '?';
}

function commandToPopupItem(item: CommandItem): ComboboxPopupItem {
  // Command entries show the token the agent will actually receive; raw prompt
  // entries keep their title.
  const token = item.token ?? fallbackToken(item.name);
  const label =
    item.behavior === 'insert-text'
      ? (item.label ?? item.name)
      : item.inputHint
        ? `${token} ${item.inputHint}`
        : token;
  return {
    id: item.id,
    label,
    description: item.description,
    section: item.section,
  };
}

// ── Internal state tracked by each suggestion render lifecycle ────────────────

interface SuggestionState<T> {
  items: T[];
  rect: DOMRect | null;
  onSelect: (item: T) => void;
  /** 这批结果是同一个查询重查回来的(不是用户又打了字):弹层按 id 留住原来的高亮。 */
  refreshed?: boolean;
}

function emptySuggestion<T>(): SuggestionState<T> {
  return { items: [], rect: null, onSelect: () => {} };
}

/**
 * Build the `render` factory required by @tiptap/suggestion.
 * We rely on SuggestionProps' default generics because the popup only needs
 * `items`, `clientRect`, and the `command` callback — all of which
 * are invariant regardless of whether we're rendering mentions or commands.
 */
/** 开着的那个弹层:最近一次的 props,以及把一组新结果写进它的那个函数(供「结果变了,再查一次」用)。 */
interface OpenSuggestion {
  props: SuggestionProps | null;
  apply: ((props: SuggestionProps, refreshed?: boolean) => void) | null;
}

function makeSuggestionRender<T>(
  setSuggestion: React.Dispatch<React.SetStateAction<SuggestionState<T>>>,
  popupRef: React.RefObject<ComboboxPopupHandle | null>,
  open?: OpenSuggestion
): () => {
  onStart?: (props: SuggestionProps) => void;
  onUpdate?: (props: SuggestionProps) => void;
  onExit?: () => void;
  onKeyDown?: (props: SuggestionKeyDownProps) => boolean;
} {
  return () => {
    // @@@suggestion-empty-is-not-an-answer —— 每敲一个字符,tiptap 的 suggestion 会调**两次**
    // `onUpdate`:先同步一次 `items: []`(异步的 `items()` 还没 resolve),约 3–5ms 后再一次带
    // 真结果。把第一次原样写进 state,弹层就会「空 ⇒ 卸载 ⇒ 又挂上」——**这就是用户看到的闪烁**。
    //
    // 实测(mac1,真 Electron,opencode 会话,敲 `/`+4 个字符):
    //   回调序列 update(n=0) → update(n=3) → update(n=0) → update(n=3) …(每键一对,间隔 2.5–5ms)
    //   弹层节点 adds=5 removes=5 —— 每一键都真的卸载重挂,remove→add 相隔 2–3ms(≈ 一帧空白)
    //
    // ⇒ 空列表**不是一个答案**,它只是「还没算完」。所以:非空立刻生效;空的**延后**一拍,
    //    在延后期内等到非空就取消 —— 真的没有匹配项时那一拍照常落地,菜单该关还是关。
    // ❌ 不能干脆忽略空:`/zzz` 真的匹配不到时,菜单必须关,否则就是一个骗人的菜单。
    // ⚠️ `CLEAR_DELAY_MS` 不是随手挑的:实测那对回调间隔 2.5–5ms,60ms ≈ 4 帧,
    //    比它宽一个数量级,而对「关闭」来说人眼看不出延迟。
    const CLEAR_DELAY_MS = 60;
    let clearTimer: ReturnType<typeof setTimeout> | null = null;
    const cancelPendingClear = () => {
      if (clearTimer === null) return;
      clearTimeout(clearTimer);
      clearTimer = null;
    };
    const apply = (props: SuggestionProps, refreshed = false) => {
      const next: SuggestionState<T> = {
        items: props.items as T[],
        rect: props.clientRect?.() ?? null,
        onSelect: (item) => props.command(item),
        refreshed,
      };
      if (next.items.length > 0) {
        cancelPendingClear();
        setSuggestion(next);
        return;
      }
      // 空 —— 先别信。等一拍;这期间来了非空就当无事发生。
      cancelPendingClear();
      clearTimer = setTimeout(() => {
        clearTimer = null;
        setSuggestion(next);
      }, CLEAR_DELAY_MS);
    };
    const track = (props: SuggestionProps) => {
      if (open) {
        open.props = props;
        open.apply = apply;
      }
      apply(props);
    };
    return {
      onStart: track,
      onUpdate: track,
      onExit() {
        if (open) {
          open.props = null;
          open.apply = null;
        }
        // 真退出是确定的,不用等 —— 而且必须取消在飞的那一拍,否则它会在退出之后
        // 再写一次 state,把一个已经关掉的菜单重新写成「空但 rect 还在」。
        cancelPendingClear();
        setSuggestion(emptySuggestion());
      },
      onKeyDown({ event }: SuggestionKeyDownProps) {
        if (event.key === 'Escape') {
          cancelPendingClear();
          setSuggestion(emptySuggestion());
          return true;
        }
        return popupRef.current?.onKeyDown(event) ?? false;
      },
    };
  };
}

// ── Component ─────────────────────────────────────────────────────────────────

export const PromptEditor = forwardRef<PromptEditorRef, PromptEditorProps>(function PromptEditor(
  {
    placeholder = 'Message…',
    inputTestId = 'prompt-editor',
    inputRef,
    enterBehavior = 'submit',
    disabled = false,
    onChange,
    onPasteText,
    hostDropTypes,
    onSubmit,
    clearOnSubmit = true,
    onMentionInsert,
    mentionProvider,
    renderMentionIcon,
    queryMentions,
    queryCommands,
    onCommand,
    getPromptHistory,
    className,
  },
  ref
) {
  // Stable refs so callbacks inside TipTap extensions always see current values.
  const enterBehaviorRef = useRef(enterBehavior);
  enterBehaviorRef.current = enterBehavior;
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const clearOnSubmitRef = useRef(clearOnSubmit);
  clearOnSubmitRef.current = clearOnSubmit;
  const onPasteTextRef = useRef(onPasteText);
  onPasteTextRef.current = onPasteText;
  const hostDropTypesRef = useRef(hostDropTypes);
  hostDropTypesRef.current = hostDropTypes;
  const onMentionInsertRef = useRef(onMentionInsert);
  onMentionInsertRef.current = onMentionInsert;
  const onCommandRef = useRef(onCommand);
  onCommandRef.current = onCommand;
  const mentionProviderRef = useRef(mentionProvider);
  mentionProviderRef.current = mentionProvider;
  const openMention = useRef<OpenSuggestion>({ props: null, apply: null });
  // 提供方说「结果变了」:弹层还开着就按当前查询再查一次,原地换掉列表(查询期间没换过才写回)。
  useEffect(() => {
    if (!mentionProvider) return;
    const refresh = () => {
      const { props, apply } = openMention.current;
      if (!props || !apply) return;
      void mentionProvider.search(props.query, { requery: true }).then((items) => {
        if (openMention.current.props === props) apply({ ...props, items }, true);
      });
    };
    refresh();
    return mentionProvider.onResultsChanged?.(refresh);
  }, [mentionProvider]);
  const queryMentionsRef = useRef(queryMentions);
  queryMentionsRef.current = queryMentions;
  const queryCommandsRef = useRef(queryCommands);
  queryCommandsRef.current = queryCommands;

  // Separate suggestion state for @ and / so they don't conflict.
  const [isEmpty, setIsEmpty] = useState(true);
  const [editorDom, setEditorDom] = useState<HTMLElement | null>(null);
  const [mentionSuggestion, setMentionSuggestion] =
    useState<SuggestionState<MentionItem>>(emptySuggestion());
  const [commandSuggestion, setCommandSuggestion] =
    useState<SuggestionState<CommandItem>>(emptySuggestion());
  const mentionPopupRef = useRef<ComboboxPopupHandle | null>(null);
  const commandPopupRef = useRef<ComboboxPopupHandle | null>(null);
  // @@@aui-combobox-aria —— WAI-ARIA editable combobox 的**输入框那一半**(#4981)。
  // 弹层那一半已经就位(role=listbox + 每条 role=option + 稳定 id);这里补的是把它们
  // 接到编辑器上的四个属性。id 由这一侧持有,理由见 ComboboxPopup 的 `id` prop 注释。
  const mentionListboxId = useId();
  const commandListboxId = useId();
  // 两个弹层各报各的活动项,❌ 不共用一个 state:共用的话,两边任意一次「我关了 ⇒ null」
  // 都会把另一边正开着的活动项擦掉,读屏器当场丢焦点,而且不会有任何报错。
  const [mentionActiveOptionId, setMentionActiveOptionId] = useState<string | null>(null);
  const [commandActiveOptionId, setCommandActiveOptionId] = useState<string | null>(null);
  const portalContainer = useUiPortalContainerOrBody();

  // We capture the editor in a stable ref so the submit handler can read the doc.
  const editorRef = useRef<ReturnType<typeof useEditor> | null>(null);

  // Stable submit callback that reads the doc from the current editor.
  const handleSubmitFromKeymap = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const text = serializeDoc(ed.state.doc);
    if (!onSubmitRef.current) return;
    if (clearOnSubmitRef.current) ed.commands.clearContent(true);
    onSubmitRef.current(text);
  }, []);

  const mentionExtension = buildMentionExtension(
    {
      items: async ({ query }: { query: string }) => {
        // Prefer mentionProvider over the legacy queryMentions callback.
        const provider = mentionProviderRef.current;
        if (provider) return provider.search(query);
        return (await queryMentionsRef.current?.(query)) ?? [];
      },
      allowSpaces: mentionProvider?.allowSpaces ?? false,
      allow: ({ state, range }) => mentionProviderRef.current?.isQueryActive?.(state.doc.textBetween(range.from + 1, range.to, '\n')) ?? true,
      ...(mentionProvider?.allowSpaces ? { allowedPrefixes: null } : {}),
      render: makeSuggestionRender<MentionItem>(setMentionSuggestion, mentionPopupRef, openMention.current),
      command({ editor, range, props }) {
        const item = props as unknown as MentionItem;
        if (item.insertText !== undefined) {
          editor
            .chain()
            .focus()
            .deleteRange(range)
            .insertContentAt(range.from, item.insertText)
            .insertContent(' ')
            .run();
          return;
        }
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertContentAt(range.from, mentionInsertContent(item))
          .run();
        onMentionInsertRef.current?.(item);
      },
    }
  );

  const slashExtension = buildSlashCommandExtension(
    {
      items: async ({ query }: { query: string }) =>
        (await queryCommandsRef.current?.(query)) ?? [],
      render: makeSuggestionRender<CommandItem>(setCommandSuggestion, commandPopupRef),
    },
    (item: CommandItem) => {
      onCommandRef.current?.(item);
    }
  );

  const submitKeymap = buildSubmitKeymap(handleSubmitFromKeymap, () => enterBehaviorRef.current);

  // Read through a ref so a host that rebuilds the getter each render does not rebuild the editor.
  const getPromptHistoryRef = useRef(getPromptHistory);
  getPromptHistoryRef.current = getPromptHistory;
  // useMemo with an empty dep list: `useEditor` reads `extensions` once, so the closure holding
  // the walk state has to be the first render's — rebuilding it per render would allocate a fresh
  // (and unused) one each time and hide where that state actually lives.
  const historyKeymap = useMemo(
    () => buildPromptHistoryKeymap({ getHistory: () => getPromptHistoryRef.current?.() ?? [], restoreText: (text) => plainTextDoc(text, mentionProviderRef.current?.resolve) }),
    []
  );

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // Disable block-level nodes we don't need for a chat input.
        heading: false,
        blockquote: false,
        codeBlock: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        horizontalRule: false,
        // Strike is off for a different reason than the block nodes above: nobody was using it, and
        // nobody could — `serializeDoc` sends plain text, so every mark is dropped on the way out
        // (#5803). Turning it off also hands ⌘⇧S back to the app, where the left-sidebar toggle now
        // lives (#5802); keep those two off the same chord. Owner's call, 2026-09-18 —
        // bold / italic / underline / inline code stay for now, and still carry the same send-time
        // defect.
        strike: false,
      }),
      mentionExtension,
      slashExtension,
      submitKeymap,
      // The mention/slash popups must keep ↑↓ while they are open. That does NOT follow from the
      // position in this array — TipTap sorts by priority and, at equal priority, the *last* entry
      // wins. It holds because @tiptap/extension-mention ships priority 101 against this one's
      // default 100. `priority: 90` below makes that explicit instead of inherited from a
      // third-party default that could change under us.
      historyKeymap,
    ],
    editorProps: {
      // Leave composition keys to the IME's native default action and skip submit keymaps.
      handleDOMEvents: { keydown: (_view, event) => event.isComposing || event.keyCode === 229 },
      attributes: {
        class: cx('prompt-editor-content', styles.promptEditorContentClass),
        'data-testid': inputTestId,
        'aria-disabled': String(disabled),
        'aria-label': placeholder,
        'data-placeholder': placeholder,
        enterkeyhint: enterBehavior === 'newline' ? 'enter' : 'send',
      },
      // Let the host claim long text first; otherwise restore canonical mentions at the selection.
      // Open paragraph edges preserve inline placement, just like ProseMirror's normal text paste.
      // File clipboard entries keep using the outer attachment handler.
      handlePaste: (view, event) => {
        if (event.clipboardData?.files.length) return false;
        const text = event.clipboardData?.getData('text/plain') ?? '';
        if (!text) return false;
        if (onPasteTextRef.current?.(text) === true) return true;
        const doc = plainTextDoc(text, mentionProviderRef.current?.resolve);
        if (!doc.content.some((block) => block.content?.some((node) => node.type === 'mention'))) return false;
        const slice = Slice.maxOpen(view.state.schema.nodeFromJSON(doc).content);
        view.dispatch(view.state.tr.replaceSelection(slice).setMeta('paste', true).setMeta('uiEvent', 'paste'));
        return true;
      },
      // 宿主认领的拖放(见 `hostDropTypes`)在这里止步:返回 true = ProseMirror 不再插入任何东西。
      // 它只 preventDefault、不阻断冒泡,所以外层宿主的 onDrop 照旧收到这一次,且只收到一次。
      handleDrop: (_view, event) => {
        const types = hostDropTypesRef.current;
        if (!types?.length) return false;
        const dataTransfer = (event as DragEvent).dataTransfer;
        if (!dataTransfer) return false;
        return types.some((type) => dataTransfer.types.includes(type));
      },
      clipboardTextSerializer: (slice) => {
        // Use serializeNode so mentions/commands within paragraphs are included
        // as @label / /name even when the React NodeView renders them as complex DOM.
        const parts: string[] = [];
        slice.content.forEach((node) => parts.push(serializeNode(node)));
        return parts.join('\n').replace(/\n+$/, '');
      },
    },
    onCreate({ editor: e }) { setEditorDom(e.view.dom); },
    onUnmount() { setEditorDom(null); },
    onUpdate({ editor: e }) {
      setIsEmpty(e.isEmpty);
      const text = serializeDoc(e.state.doc);
      onChange?.(text);
    },
    editable: !disabled,
  });

  useEffect(() => {
    inputRef?.(editorDom);
    return () => inputRef?.(null);
  }, [editorDom, inputRef]);

  // Keep stable ref to editor.
  editorRef.current = editor;

  useImperativeHandle(ref, () => ({
    focus(position) {
      editor?.commands.focus(position);
    },
    clear() {
      editor?.commands.clearContent(true);
    },
    getText() {
      if (!editor) return '';
      return serializeDoc(editor.state.doc);
    },
    setText(text) {
      editor?.commands.setContent(plainTextDoc(text, mentionProviderRef.current?.resolve), { emitUpdate: true });
    },
    insertText(text, position) {
      if (!editor) return;
      editor.commands.insertContentAt(position === 'start' ? 0 : editor.state.doc.content.size,
        plainTextDoc(text, mentionProviderRef.current?.resolve).content);
    },
    insertMention(item) {
      if (item.insertText !== undefined) {
        editor?.chain().focus().insertContent(item.insertText).insertContent(' ').run();
        return;
      }
      editor?.chain().focus().insertContent(mentionInsertContent(item)).run();
      onMentionInsertRef.current?.(item);
    },
    prependMention(item) {
      if (!editor || item.insertText !== undefined) return;
      const tr = editor.state.tr;
      const ranges: Array<{ from: number; to: number }> = [];
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name !== 'mention' || node.attrs.id !== item.id) return;
        ranges.push({ from: pos, to: pos + node.nodeSize });
      });
      for (const range of [...ranges].reverse()) {
        tr.delete(range.from, range.to);
      }
      if (ranges.length > 0) editor.view.dispatch(tr);
      editor.commands.insertContentAt(1, mentionInsertContent(item));
    },
    removeMention(id) {
      if (!editor) return;
      const tr = editor.state.tr;
      const ranges: Array<{ from: number; to: number }> = [];
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name !== 'mention' || node.attrs.id !== id) return;
        ranges.push({ from: pos, to: pos + node.nodeSize });
      });
      if (ranges.length === 0) return;
      for (const range of [...ranges].reverse()) {
        tr.delete(range.from, range.to);
      }
      editor.view.dispatch(tr);
    },
    setMentionPending(id, pending) {
      if (!editor) return;
      let changed = false;
      const tr = editor.state.tr;
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name !== 'mention' || node.attrs.id !== id) return;
        if (node.attrs.pending === pending) return;
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, pending });
        changed = true;
      });
      if (changed) editor.view.dispatch(tr);
    },
  }), [editor]);

  // Convert suggestion items to ComboboxPopupItem shape.
  const mentionPopupItems = mentionSuggestion.items.map((item) => mentionToPopupItem(item, renderMentionIcon));
  const commandPopupItems = commandSuggestion.items.map(commandToPopupItem);

  const mentionActive = mentionSuggestion.items.length > 0 || Boolean(mentionProvider?.emptyLabel && mentionSuggestion.rect);
  const commandActive = commandSuggestion.items.length > 0;

  /**
   * @@@aui-combobox-aria —— 菜单开着的时候,把编辑器接成一个 editable combobox。
   *
   * ⚠️ **只在开着的时候接,关了就摘干净**,不是一直挂着:
   * 这个编辑器 99% 的时间是在写一条普通消息。常驻 `role="combobox"` 等于告诉读屏器
   * 「这是个组合框」——那是**假的**,而假的语义比缺语义更糟。菜单开着时它才真的是。
   *
   * ⚠️ 属性直接写在 ProseMirror 的 DOM 节点上,❌ 不走 `editor.setOptions({editorProps})`:
   * 那个入口是**整体替换** editorProps,会顺手把 `clipboardTextSerializer` 一起换掉
   * (粘贴时 @提及 / 斜杠命令的序列化就没了)—— 一个为了加四个属性而丢掉的功能。
   *
   * ⚠️ `role` 改了会不会碰到别处:仓里三处键盘导航护栏按
   * `input, textarea, [contenteditable], [role="textbox"]` 判「焦点在输入里」
   * (ChatListPanel / session-keyboard-nav-listener / use-arrow-key-navigation)——
   * 它们同时匹配 `[contenteditable]`,而这个节点始终是 contenteditable,所以照旧命中。
   * e2e 那边没有任何一条按 `getByRole('textbox')` 找这个编辑器(找的都是项目名/URL 那类具名输入)。
   */
  const comboboxOpen = mentionActive || commandActive;
  // 同时开着两个在今天的触发规则下不会发生,但一旦发生,`aria-controls` 与
  // `aria-activedescendant` 必须指向**同一个**列表 —— 所以两者从同一个三元式派生。
  const activeListboxId = commandActive ? commandListboxId : mentionActive ? mentionListboxId : null;
  const activeOptionId = commandActive
    ? commandActiveOptionId
    : mentionActive
      ? mentionActiveOptionId
      : null;
  useEffect(() => {
    const dom = editorDom;
    if (!dom) return;
    if (!comboboxOpen || !activeListboxId) {
      for (const name of [
        'role',
        'aria-expanded',
        'aria-controls',
        'aria-haspopup',
        'aria-activedescendant',
      ]) {
        dom.removeAttribute(name);
      }
      return;
    }
    dom.setAttribute('role', 'combobox');
    dom.setAttribute('aria-expanded', 'true');
    dom.setAttribute('aria-haspopup', 'listbox');
    dom.setAttribute('aria-controls', activeListboxId);
    if (activeOptionId) dom.setAttribute('aria-activedescendant', activeOptionId);
    else dom.removeAttribute('aria-activedescendant');
  }, [editorDom, comboboxOpen, activeListboxId, activeOptionId]);

  return (
    <>
      <div className={cx(styles.editorWrapper, className)}>
        <EditorContent editor={editor} className={styles.editorContent} aria-disabled={disabled} />
        {isEmpty && (
          <span aria-hidden className={styles.editorPlaceholder}>
            {placeholder}
          </span>
        )}
      </div>
      {mentionActive &&
        createPortal(
          <ComboboxPopup
            ref={mentionPopupRef}
            // 上游 `elements-composer` 的 @提及 / 斜杠命令共用同一个 `composer-menu`
            // 解剖（#4981 A4）。名字由这一面给，弹层本身是通用原语。
            slot="composer-menu"
            id={mentionListboxId}
            onActiveOptionChange={setMentionActiveOptionId}
            items={mentionPopupItems}
            emptyLabel={mentionProvider?.emptyLabel}
            keepActiveOnChange={mentionSuggestion.refreshed}
            anchorRect={mentionSuggestion.rect}
            onSelect={(popupItem) => {
              const original = mentionSuggestion.items.find((m) => m.id === popupItem.id);
              if (original) mentionSuggestion.onSelect(original);
            }}
          />,
          portalContainer
        )}
      {commandActive &&
        createPortal(
          <ComboboxPopup
            ref={commandPopupRef}
            slot="composer-menu"
            id={commandListboxId}
            onActiveOptionChange={setCommandActiveOptionId}
            items={commandPopupItems}
            autoSelectFirst={false}
            anchorRect={commandSuggestion.rect}
            stacked
            onSelect={(popupItem) => {
              const original = commandSuggestion.items.find((c) => c.id === popupItem.id);
              if (original) commandSuggestion.onSelect(original);
            }}
          />,
          portalContainer
        )}
    </>
  );
});
