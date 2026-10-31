/**
 * chat-transcript.tsx — React adapter for @gugu/session-chat-ui.
 *
 * Renderer-local copy of the @gugu/session-ui ChatTranscript wrapper, importing
 * createChatView and types directly from @gugu/session-chat-ui. This keeps ChatComposer
 * as the only @gugu/session-ui runtime import consumed by the desktop renderer.
 *
 * Uses React.createElement (no JSX) to avoid dual-JSX-runtime conflicts.
 * Creates a ChatView into the container div on mount and disposes on unmount.
 *
 * context + state must be created by the host via createChatContext /
 * createChatState before passing them in. This mirrors the CodeMirror
 * EditorState/EditorView split: the host owns the model (ChatState), this
 * component owns the DOM view.
 *
 * padTop is accepted as a prop and pushed reactively through setContentPadding.
 * padBottom is intentionally omitted: when `composer` is `'slot'`, ChatView's
 * internal ResizeObserver drives padBottom automatically. For non-slot usage,
 * call view.setContentPadding({ bottom: ... }) directly.
 *
 * commands / onReachStart / onAtBottomChange are pushed reactively so inline
 * callbacks do not go stale after React re-renders.
 */

import type {
  ChatCommands,
  ChatContext,
  ChatLayout,
  ChatState,
  ChatView,
  ChatViewOptions,
  TranscriptTurn,
} from '@gugu/session-chat-ui';
import { createElement, Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Hint } from '@/components/ui/Tooltip';
import { ConversationSourcePopover } from './conversation-source-popover';
import { toast } from '@renderer/lib/hooks/use-toast';
import { messageForUser } from '@/lib/userFacingError';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { platform } from '@/platform';

const onCopyError = (error: unknown) => toast({ title: translateSessionMessage('task.copyFailed'), description: messageForUser(error), tier: 'error' });
const writeClipboardText = (text: string) => platform.writeClipboardText(text);

export type ChatTranscriptProps = Pick<
  ChatViewOptions,
  | 'stickToBottom'
  | 'pinUserMessages'
  | 'composer'
  | 'composerPlacement'
  | 'contentOverlay'
  | 'class'
  | 'contentClass'
  | 'onReachStart'
  | 'onAtBottomChange'
  | 'onActiveUserMessageVisibilityChange'
> & {
  /** Global services singleton shared across conversations. */
  context: ChatContext;
  /** Per-conversation state (transcript + parse caches). */
  state: ChatState;
  /** Called once after the Solid root is mounted with the chat view handle. */
  onReady?: (view: ChatView) => void;
  /**
   * 这个 view 已经没了 —— dispose 之后调用一次。
   *
   * ⚠️ 宿主必须能听见这件事：留着一个已 dispose 的句柄比留 null 更糟，
   * `?.` 不再短路，调用会真的落到一个已释放的 Solid root 上（#4452）。
   */
  onDisposed?: () => void;
  style?: React.CSSProperties;
  className?: string;
  /**
   * Top padding (px) reserved inside the canvas for a pinned header. Pushed
   * reactively via setContentPadding so it can change without remounting.
   */
  padTop?: number;
  /** Drawn inside another page (the phone's thinking row / delivery card): no page gutter or page padding. */
  embedded?: boolean;
  /**
   * Command callbacks invoked by user interactions inside the transcript.
   * Pushed reactively so inline callbacks are never stale.
   */
  commands?: ChatCommands;
  /**
   * Transcript layout preset (#4874 「对话视图」). Applied to the shared
   * ChatContext, so every mounted transcript follows the same preference;
   * pushed reactively (no remount) and a no-op when unchanged.
   */
  layout?: ChatLayout;
};

type ChatUi = typeof import('@gugu/session-chat-ui');
let chatUi: ChatUi | null = null;
/**
 * session-chat-ui 只加载一次,之后同步拿。❌ 每挂一次都 `import()`:打包后的动态 import 带着预载包装,
 * 模块早已在内存里也要几百 ms 才回调(WebView 113 实测 350–600 ms)—— 手机思考行每挂一次都先空着、再撑开。
 */
export function loadChatUi(): Promise<ChatUi> {
  return chatUi ? Promise.resolve(chatUi) : import('@gugu/session-chat-ui').then((loaded) => (chatUi = loaded));
}

export function ChatTranscript(props: ChatTranscriptProps): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  const viewRef = useRef<ChatView | null>(null);
  const [tooltips, setTooltips] = useState<Parameters<NonNullable<ChatCommands['onTooltipMount']>>[0][]>([]);
  const onTooltipMount = useCallback<NonNullable<ChatCommands['onTooltipMount']>>(target => {
    setTooltips(current => [...current, target]);
    return () => setTooltips(current => current.filter(entry => entry !== target));
  }, []);

  // 模块已经加载过(`loadChatUi`)就在 layout effect 里同步建视图:**第一次绘制之前**就有正文。❌ passive effect / 每次 import():
  // 先画一帧空容器、过几百 ms 才长出正文 —— 手机把它嵌在思考行里,一进页那一行先 0 高再撑开,
  // 整条线程跟着再跳一次(owner 10-12「进去就颤两下」,WebView 113 实测 +27px)。
  useLayoutEffect(() => {
    if (!ref.current) return;
    let disposed = false;
    let createdView: ChatView | null = null;

    const create = ({ createChatView }: ChatUi) => {
      if (disposed || !ref.current) return;
      // 这一份 props **必须在 import 落地之后才读**。
      //
      // `AcpChatPanel` 整块面板只挂一个 ChatTranscript,换会话只换 `props.state` 的身份
      // (见那边 `// One persistent ChatTranscript` 那段)。把 mount 那一刻的 props 捕获在
      // `import()` 之前的话:用户在 chunk 还没到的这段窗口里切了会话 ⇒ `[props.state]` 那条
      // effect 先跑,而 `viewRef.current` 还是 null(view 还没造出来)⇒ 它什么也没做;
      // chunk 到了之后 view 用**上一条会话**的 ChatState 造出来,而那条 effect 再也不会重跑
      // ⇒ 标题是新会话、正文是旧会话(旧会话空则整片空白),此后一直如此。
      //
      // 真机 A/B(chole/Windows,用 CDP Fetch 把那个 chunk 压 5s 模拟慢盘,切换间隔 ~120ms):
      // dev 上正文渲染的是 ALPHA、而选中的是 BRAVO;读最新 props 后两者都是 BRAVO。
      // 对照:同样压 5s、但等 7s 之后再切,dev 也是对的 —— 坏的是那段窗口,不是压测本身。
      const p = propsRef.current;
      const view = createChatView({
        context: p.context,
        state: p.state,
        parent: ref.current,
        composer: p.composer,
        composerPlacement: p.composerPlacement,
        contentOverlay: p.contentOverlay,
        stickToBottom: p.stickToBottom,
        pinUserMessages: p.pinUserMessages,
        class: p.class,
        contentClass: p.contentClass,
        commands: { onCopyError, onTooltipMount, ...p.commands, writeClipboardText },
        padTop: p.padTop,
        embedded: p.embedded,
        // Thread stable wrappers that read from propsRef at call time — never stale.
        onReachStart: p.onReachStart ? () => propsRef.current.onReachStart?.() : undefined,
        onAtBottomChange: p.onAtBottomChange
          ? (b: boolean) => propsRef.current.onAtBottomChange?.(b)
          : undefined,
        onActiveUserMessageVisibilityChange: p.onActiveUserMessageVisibilityChange
          ? (v: boolean) => propsRef.current.onActiveUserMessageVisibilityChange?.(v)
          : undefined,
        onViewMounted: (v) => propsRef.current.onReady?.(v),
      });
      createdView = view;
      viewRef.current = view;
    };
    if (chatUi) create(chatUi);
    else void loadChatUi().then(create);

    return () => {
      disposed = true;
      const hadView = createdView !== null;
      createdView?.dispose();
      viewRef.current = null;
      if (hadView) propsRef.current.onDisposed?.();
    };
     
  }, []);

  // Swap the underlying ChatState when props.state identity changes (setModel path).
  // The view handle, composer slot, and commands remain stable across swaps.
  useEffect(() => {
    viewRef.current?.setModel(props.state);
  }, [props.state]);

  // Push top padding updates reactively.
  useEffect(() => {
    viewRef.current?.setContentPadding({ top: props.padTop });
  }, [props.padTop]);

  // Push command callbacks reactively so inline functions are never stale.
  useEffect(() => {
    viewRef.current?.setCommands({ onCopyError, onTooltipMount, ...props.commands, writeClipboardText });
  }, [props.commands]);

  // Layout lives on the process-long context (measurement-coupled), not on the
  // view: applying it here rather than at createChatView keeps the preference
  // in effect across model swaps and for transcripts mounted later.
  useEffect(() => {
    if (props.layout !== undefined) {
      props.context.setLayout(props.layout);
    }
  }, [props.context, props.layout]);

  return createElement(Fragment, null, createElement('div', {
    ref,
    style: { height: '100%', ...props.style },
    className: props.className,
  }), tooltips.map((entry, index) => createPortal(entry.onOpenOriginal ? createElement(ConversationSourcePopover,
    { text: entry.text, label: entry.originalLabel ?? entry.text, onOpenOriginal: entry.onOpenOriginal }) : createElement(Hint, { label: entry.text, side: 'top', children:
    createElement('span', { style: { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', width: '100%' } }, entry.text),
  }), entry.root, String(index))));
}

// Re-export imperative types so consumers don't need to import from @gugu/session-chat-ui directly.
export type {
  ChatView,
  ChatCommands,
  ChatViewCommand,
  ChatViewCommandId,
  ScrollToItemOptions,
  ChatHighlighter,
  HighlightResult,
  CodeToken,
  MentionProvider,
  ChatContext,
  ChatState,
  TranscriptTurn,
} from '@gugu/session-chat-ui';
export type LoadOlderFn = (turns: TranscriptTurn[]) => void;
