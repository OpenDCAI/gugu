import { createChatContext, DEFAULT_CONFIG, type ChatConfig, type ChatContext } from '@gugu/session-chat-ui';
import { reaction } from 'mobx';
import { installedExtensionsStore } from '@renderer/features/extensions/installed-extensions-store';
import { readSelfIdentityBridge } from '@/lib/selfIdentityBridge';
import { rpc } from '@renderer/lib/ipc';
import { advertisedCommandProvider } from './advertised-command-provider';
import { senderAvatarUrl, subscribeSenderAvatars } from './sender-avatar';
import { SESSION_CHAT_FONT_STACK } from './font-stack';
import { chatMentionProvider, registerIssueMentionIcons } from './chat-mention-provider';
import { subscribeSessionLocale, translateSessionMessage } from '../../localization/locale-store';
import { subscribeChatSummaries } from '@/lib/chatSummariesBridge';
import { chatDisplayName } from './chat-name';

let shared: ChatContext | null = null;
let didPreloadIssueMentionIcons = false;

export const SESSION_CHAT_CONFIG: ChatConfig = {
  ...DEFAULT_CONFIG,
  fonts: {
    sans: [...SESSION_CHAT_FONT_STACK.sans],
    mono: [...SESSION_CHAT_FONT_STACK.mono],
  },
};

/**
 * Create the process-long ChatContext. Call once from the renderer bootstrap
 * (main.tsx) so the context's font-load hook fires at startup rather than on
 * first conversation open.
 *
 * ChatContext is a global singleton (theme, shared caches, measureEpoch).
 * Per-conversation state lives in ChatState, which is created separately.
 */
export function initSharedChatContext(): ChatContext {
  if (!shared) {
    preloadIssueMentionIcons();
    shared = createSessionChatContext();
  }
  return shared;
}

/**
 * A fresh ChatContext with the same services as the shared one. For a transcript that needs a layout of its
 * own: layout lives on the context (`ChatTranscript`'s `layout` prop sets it), so setting it on the shared one
 * would restyle every other transcript in the window (the phone's delivery cards, thinking rows).
 */
export function createSessionChatContext(): ChatContext {
  return createChatContext({
    config: SESSION_CHAT_CONFIG,
    mentionProvider: chatMentionProvider,
    commandProvider: advertisedCommandProvider,
    translator: translateSessionMessage,
    subscribeTranslator: subscribeSessionLocale,
    // #5048 「我是谁」经 window.__GUGU_SELF_IDENTITY__ 从咕咕壳送进来;桥缺席(独立打开的会话页)= 没人,
    // 投递卡退回信封事实。懒读:桥由 gugu 的 App 在登录态变化时装/更新。
    selfIdentity: () => readSelfIdentityBridge()?.getSnapshot() ?? null,
    subscribeSelfIdentity: (listener) => readSelfIdentityBridge()?.subscribe(listener) ?? (() => {}),
    // #6306 投递卡头像:读咕咕壳的本地身份缓存(与聊天页同一份、同一个投影),桥由咕咕壳在会话页 bundle 之前装上。
    // session:<id> 画这条会话的属主 agent(宿主花名册回答会话 → agent),所以两张表变了都要重读。
    senderAvatar: (fromId) => senderAvatarUrl(fromId),
    subscribeSenderAvatars,
    // App 代发的投递卡写 App 的名字:这台装着的 App、界面语言(store 的 appName);没装就是 null,卡上写 id。
    appName: (appId) => installedExtensionsStore.appName(appId) ?? null,
    subscribeAppNames: (listener) => reaction(() => [installedExtensionsStore.manifests, installedExtensionsStore.locale], listener),
    // 群里来的投递写群名(项目群就是项目名,见 chat-name.ts);认不出来是 null,卡上只说「来自群聊」。
    chatName: chatDisplayName,
    subscribeChatNames: subscribeChatSummaries,
  });
}

/**
 * Access the process-long ChatContext. Lazily initializes as a defensive
 * fallback if a consumer runs before bootstrap completes.
 */
export function getSharedChatContext(): ChatContext {
  return shared ?? initSharedChatContext();
}

function preloadIssueMentionIcons(): void {
  if (didPreloadIssueMentionIcons) return;
  didPreloadIssueMentionIcons = true;
  // 调用本身放进 then 里:没有会话页宿主桥时(手机壳)`rpc` 的桩是**同步抛**的,写成 `rpc.integrations.list().then(…)`
  // 那一抛越过下面的 catch,把 initSharedChatContext 整个抛掉 —— 手机上第一次展开的思考行因此一直空白,
  // 第二次才好(第二次 didPreload 已为真,跳过了这一步;2026-10-02 真机)。
  void Promise.resolve()
    .then(() => rpc.integrations.list())
    .then(registerIssueMentionIcons)
    .catch(() => {
      // IntegrationsProvider also refreshes the registry after React mounts.
    });
}
