/**
 * ChatContext — global services singleton for @gugu/session-chat-ui.
 *
 * Holds everything that is shared across all conversations and views:
 *   - Resolved theme + config (typography constants for measurement)
 *   - Shiki highlighter (expensive one-time init)
 *   - Content-addressed caches (highlight / diff / mermaid / richInline)
 *   - measureEpoch signal (bumped on font load / theme change to invalidate geometry)
 *   - mentionProvider (synchronous @-mention resolver)
 *
 * Lifetime: process-long (singleton). Dispose only when tearing down the app.
 *
 * Usage:
 *   const ctx = createChatContext({ locale, theme, highlighter });
 *   const state = createChatState(ctx);
 *   const view  = createChatView({ context: ctx, state, parent });
 */

import { createRoot, createSignal } from 'solid-js';
import type { SupportedLocale } from '@gugu/session-shared/format';
import type { SharedCaches } from './core/caches';
import { createSharedCaches } from './core/caches';
import type { ChatConfig } from './core/config';
import { DEFAULT_CONFIG, buildChatTheme } from './core/config';
import { DEFAULT_LAYOUT, createThemeSignal, type ChatLayout } from './core/layout/preset';
import type { ChatHighlighter } from './core/highlight/highlighter';
import type { CommandProvider } from './core/markdown/command-provider';
import type { MentionProvider } from './core/markdown/mention-provider';
import { registerFontsReadyClear } from './core/measure/pretext-cache';
import type { ChatTheme } from './core/theme';
import {
  defaultChatTranslator,
  type ChatTranslator,
  type ChatTranslationSubscriber,
} from './localization';
import type { SelfIdentity } from './lib/self-identity';

export type ChatContextOptions = {
  /** Resolved host locale. Changes use the existing translator subscription. */
  locale: () => SupportedLocale;
  /**
   * Full resolved theme. When omitted, `config` is used to derive one.
   * Color changes are free (CSS-variable themed). Typography/font changes must
   * bump measureEpoch — call `ctx.bumpEpoch()` after updating theme.
   */
  theme?: ChatTheme;
  /**
   * Chat configuration (typography, chip geometry). Ignored when `theme` is set.
   * Changing this after creation requires bumping `ctx.bumpEpoch()`.
   */
  config?: ChatConfig;
  /** Initial transcript layout preset (#4874), default `classic`; swap later via `setLayout`. */
  layout?: ChatLayout;
  /**
   * Optional syntax-highlighting adapter.
   * When omitted the bundled default highlighter is used.
   */
  highlighter?: ChatHighlighter;
  /**
   * Optional synchronous @-mention metadata resolver.
   * Threaded into parse caches so @-token spans render as pills.
   */
  mentionProvider?: MentionProvider;
  /**
   * Optional synchronous /-command metadata resolver.
   * Threaded into parse caches so /command spans render as chips.
   */
  commandProvider?: CommandProvider;
  /** Synchronous host translator. It must not depend on a React hook or root. */
  translator?: ChatTranslator;
  /** Optional change source used to refresh mounted Solid transcript labels in place. */
  subscribeTranslator?: ChatTranslationSubscriber;
  /**
   * Who is signed in (#5048): a delivery card names the current user's own messages from this
   * profile instead of the envelope. Synchronous host read; omitted = nobody is declared.
   */
  selfIdentity?: () => SelfIdentity | null;
  /** Optional change source so mounted cards re-read `selfIdentity` when the profile changes. */
  subscribeSelfIdentity?: (listener: () => void) => () => void;
  /**
   * A delivery sender's avatar image URL (#6306), resolved by the host from the same identity cache
   * and projection as the host's own chat. Synchronous; `null` = draw no avatar (no identity, or
   * not known yet). Omitted = no avatars.
   */
  senderAvatar?: (fromId: string | null) => string | null;
  /** Optional change source so mounted cards re-read `senderAvatar` when the host's cache changes. */
  subscribeSenderAvatars?: (listener: () => void) => () => void;
  /**
   * An App's name by its id, as the host names it (its installed Apps, the interface language), for a delivery an App
   * sent. Synchronous; `null` = not known here (the card shows the id). Omitted = ids.
   */
  appName?: (appId: string) => string | null;
  /** Optional change source so mounted cards re-read `appName` when the host's Apps or language change. */
  subscribeAppNames?: (listener: () => void) => () => void;
  /**
   * A group's name by its chat id, as the person reads it, for a delivery that came from a group (the envelope carries
   * the group's number, which agents address; people read names). Synchronous; `null` = not known here (the card says
   * "via a group" without a name). Omitted = never known.
   */
  chatName?: (chatId: string) => string | null;
  /** Optional change source so mounted cards re-read `chatName` when the host's chats change. */
  subscribeChatNames?: (listener: () => void) => () => void;
};

export type ChatContext = {
  /** Reactive host locale, sharing the translation epoch. */
  readonly locale: () => SupportedLocale;
  /** Resolved theme (typography drives measurement geometry). Reactive under `setLayout`. */
  readonly theme: ChatTheme;
  /** Chat configuration that produced the theme. */
  readonly config: ChatConfig;
  /** Optional mention provider threaded into parse caches. */
  readonly mentionProvider: MentionProvider | undefined;
  /** Optional command provider threaded into parse caches. */
  readonly commandProvider: CommandProvider | undefined;
  /** Translate transcript chrome using the process-long host capability. */
  readonly translate: ChatTranslator;
  /** Reactive accessor for the signed-in user's display identity; `null` when nobody is declared. */
  readonly selfIdentity: () => SelfIdentity | null;
  /** Reactive accessor for a delivery sender's avatar URL; `null` = draw no avatar. */
  readonly senderAvatar: (fromId: string | null) => string | null;
  /** Reactive accessor for an App's name by id; `null` = not known here. */
  readonly appName: (appId: string) => string | null;
  /** Reactive accessor for a group's name by chat id; `null` = not known here. */
  readonly chatName: (chatId: string) => string | null;
  /** Shared content-addressed caches (highlight / diff / mermaid / richInline). */
  readonly sharedCaches: SharedCaches;
  /**
   * Reactive accessor for the measurement epoch.
   * Read inside Solid reactive contexts (createMemo, JSX) to re-measure
   * when fonts load or theme typography changes.
   */
  readonly measureEpoch: () => number;
  /**
   * Bump the measurement epoch, invalidating all per-block geometry caches.
   * Call after fonts load (handled automatically) or after a typography change.
   */
  bumpEpoch(): void;
  /** Swap the layout preset for every view sharing this context (bumps measureEpoch on change). */
  setLayout(layout: ChatLayout): void;
  /** Dispose the context's reactive root. Safe to call after all views are disposed. */
  dispose(): void;
};

/**
 * Create a ChatContext singleton.
 *
 * `registerFontsReadyClear` is called once: when the named fonts load,
 * `clearTextMeasure()` flushes pretext's glyph cache and `bumpEpoch()`
 * invalidates all block geometry caches.
 */
export function createChatContext(opts: ChatContextOptions): ChatContext {
  const config = opts.config ?? DEFAULT_CONFIG;
  const initialTheme = opts.theme ?? buildChatTheme(config, opts.layout ?? DEFAULT_LAYOUT);
  let themeSignal!: ReturnType<typeof createThemeSignal>;
  const sharedCaches = createSharedCaches(opts.highlighter);

  let measureEpoch!: () => number;
  let bumpEpoch!: () => void;
  let translate!: ChatTranslator;
  let locale!: () => SupportedLocale;
  let selfIdentity!: () => SelfIdentity | null;
  let senderAvatar!: (fromId: string | null) => string | null;
  let appName!: (appId: string) => string | null;
  let chatName!: (chatId: string) => string | null;
  let disposeRoot!: () => void;
  let bumpTranslation!: () => void;
  let bumpSelfIdentity!: () => void;
  let bumpSenderAvatars!: () => void;
  let bumpAppNames!: () => void;
  let bumpChatNames!: () => void;

  createRoot((dispose) => {
    disposeRoot = dispose;
    const [epoch, setEpoch] = createSignal(0);
    const [translationEpoch, setTranslationEpoch] = createSignal(0);
    themeSignal = createThemeSignal(initialTheme);
    measureEpoch = epoch;
    bumpEpoch = () => setEpoch((e) => e + 1);
    bumpTranslation = () => setTranslationEpoch((value) => value + 1);
    locale = () => {
      translationEpoch();
      return opts.locale();
    };
    const translator = opts.translator ?? defaultChatTranslator;
    translate = (key, values) => {
      translationEpoch();
      return translator(key, values);
    };
    const [selfEpoch, setSelfEpoch] = createSignal(0);
    bumpSelfIdentity = () => setSelfEpoch((value) => value + 1);
    const readSelf = opts.selfIdentity ?? (() => null);
    selfIdentity = () => {
      selfEpoch();
      return readSelf();
    };
    const [avatarEpoch, setAvatarEpoch] = createSignal(0);
    bumpSenderAvatars = () => setAvatarEpoch((value) => value + 1);
    const readAvatar = opts.senderAvatar ?? (() => null);
    senderAvatar = (fromId) => {
      avatarEpoch();
      return readAvatar(fromId);
    };
    const [appNameEpoch, setAppNameEpoch] = createSignal(0);
    bumpAppNames = () => setAppNameEpoch((value) => value + 1);
    const readAppName = opts.appName ?? (() => null);
    appName = (appId) => {
      appNameEpoch();
      return readAppName(appId);
    };
    const [chatNameEpoch, setChatNameEpoch] = createSignal(0);
    bumpChatNames = () => setChatNameEpoch((value) => value + 1);
    const readChatName = opts.chatName ?? (() => null);
    chatName = (chatId) => {
      chatNameEpoch();
      return readChatName(chatId);
    };
  });

  let disposed = false;
  const unsubscribeTranslator = opts.subscribeTranslator?.(() => {
    if (!disposed) bumpTranslation();
  });
  const unsubscribeSelfIdentity = opts.subscribeSelfIdentity?.(() => {
    if (!disposed) bumpSelfIdentity();
  });
  const unsubscribeSenderAvatars = opts.subscribeSenderAvatars?.(() => {
    if (!disposed) bumpSenderAvatars();
  });
  const unsubscribeAppNames = opts.subscribeAppNames?.(() => {
    if (!disposed) bumpAppNames();
  });
  const unsubscribeChatNames = opts.subscribeChatNames?.(() => {
    if (!disposed) bumpChatNames();
  });

  registerFontsReadyClear(initialTheme.fonts, () => {
    if (disposed) return;
    sharedCaches.clearTextMeasure();
    bumpEpoch();
  });

  return {
    get theme() {
      return themeSignal.theme();
    },
    config,
    mentionProvider: opts.mentionProvider,
    commandProvider: opts.commandProvider,
    translate,
    locale,
    selfIdentity,
    senderAvatar,
    appName,
    chatName,
    sharedCaches,
    measureEpoch,
    bumpEpoch,
    setLayout(layout) {
      if (themeSignal.setLayout(layout)) bumpEpoch();
    },
    dispose() {
      disposed = true;
      unsubscribeTranslator?.();
      unsubscribeSelfIdentity?.();
      unsubscribeSenderAvatars?.();
      unsubscribeAppNames?.();
      unsubscribeChatNames?.();
      disposeRoot();
    },
  };
}
