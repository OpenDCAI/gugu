import type { GuguLinkTarget, LinkPlace } from '@gugu/core/shared/ui/guguLink';
import type { AppComposeDetail, AppForumConsentDetail, AppOpenWithDetail, AppShowMessageDetail, PeekTarget } from './app-runtime-protocol';
import type { GroupAvatarMember } from '@gugu/core/shared/types/chat';
import type { ExtensionManifest } from './manifest';
import type { MarketCodeSource } from './market';
import type { AppModalPage } from './app-modal';

/**
 * What the bridge asks the renderer to do on an extension's behalf.
 *
 * The split is deliberate: **main decides whether it is allowed** (identity can
 * only be read from the session, and grants only main holds), **the renderer
 * decides how it looks** (it owns the tab strip and the conversation). Neither
 * half can do the other's job, so neither half can be bypassed.
 *
 * Every action carries the extension it came from. The renderer needs that to
 * attribute what it draws —「扩展只负责喊一声…消息由 gugu 组装并投进对话」means
 * the delivered message must be identifiable as the extension's, not the user's.
 * Refs #2374.
 */

/**
 * 摩擦单 F52 An install that happened, whose window has not taken it in yet: said first in the answer's `next`, never
 * an error. One sentence for main (which installs) and the MCP host (which rewrites `next` for a group App); an
 * answer carrying it is marked `window: 'not-confirmed'`.
 */
export const INSTALLED_NOT_SHOWN_NOTE =
  'It is installed; the gugu window has not confirmed it yet (it may be busy), so the App shows there in a moment or after a reload.';

export interface ExtensionHostActionOrigin {
  extensionId: string;
  /** null: a slot in no session (a group's side panel) — only what a page says about itself comes from one. */
  sessionId: string | null;
  tabId: string;
}

export type ExtensionHostAction =
  | { kind: 'openAppModal'; page: AppModalPage }
  | { kind: 'closeAppModal'; id: string }
  | { kind: 'focusAppModalClose'; id: string }
  | { kind: 'setTabTitle'; title: string }
  | { kind: 'setTabBadge'; badge: number | string | null }
  | { kind: 'openBrowserTab'; url: string }
  | { kind: 'reportError'; message: string }
  /** The page loaded another document (a reload, another of the App's pages): what the old one said about itself goes. */
  | { kind: 'newDocument' }
  /** `gugu.compose`: into the composer of the chat the call named (the window brings it up), or of that session's. */
  | { kind: 'compose'; detail: AppComposeDetail }
  | { kind: 'compose'; sessionId: string; text: string }
  /** `gugu.showMessage` / `files.openWith`: the window that shows chats does it, bringing the chat up. */
  | { kind: 'showMessage'; detail: AppShowMessageDetail }
  | { kind: 'openWith'; detail: AppOpenWithDetail }
  /** G1 Beside the page that asked, in its own slot (the origin's): the page stays as it is. */
  | { kind: 'peek'; target: PeekTarget }
  /** A link's or a banner's click (no page asked): the App in a chat's panel, or — naming no chat — on its own page. */
  | { kind: 'openApp'; extensionId: string; tab?: string; chatId?: string }
  | { kind: 'openLinkTarget'; target: GuguLinkTarget }
  /** A banner's click naming a chat's file: opened in its chat, as a link to it is. */
  | { kind: 'openChatFile'; chatId: string; itemId: string }
  /** 论坛 (9): the window draws the points sheet (posting a bounty, settling one) and does it if the person confirms. */
  | { kind: 'forumConsent'; detail: AppForumConsentDetail };

export interface ExtensionHostActionCommand {
  /** The page that asked; null for a link's or a banner's click, which no page made. */
  origin: ExtensionHostActionOrigin | null;
  action: ExtensionHostAction;
}

/** The renderer-command method name these arrive under. */
export const EXTENSION_HOST_ACTION_METHOD = 'extensions.hostAction';

/**
 * 装完一个扩展之后,宿主用它告诉渲染端「已装的集合变了,重新登记 tab」。
 *
 * 需要它是因为登记只发生在会话页**挂载**时、从设置里装时、以及 open_in_tab 撞到未知 tab 时 ——
 * agent 自己装完之后一处都不经过,于是新 tab 要整页刷新才出现(owner 实测 #4135)。
 */
export const EXTENSION_INSTALLED_CHANGED_METHOD = 'extensions.installedChanged';

/** Main asks the window for members' faces (`lib/memberFaces.ts`): `{ people: { id, avatar }[] }` → the faces by id. */
export const EXTENSION_MEMBER_FACES_METHOD = 'extensions.memberFaces';

/** #7158 Main asks the window which project its task list has a session under: `{ sessionId }` → the project id, or null. */
export const EXTENSION_LISTED_SESSION_METHOD = 'extensions.listedSession';

/**
 * `gugu.compose(text)` naming no place: main asks the window that draws the page to let the person pick one
 * (`ComposeTargetPicker`): `ComposePickAsk` → a `ComposePlace`, or null when they cancel. It waits on a person, so it
 * closes by itself after `INSTALL_CONSENT_HUMAN_WINDOW_MS`, as an install's consent does (ipc-bridge's clock is longer).
 */
export const EXTENSION_PICK_COMPOSE_TARGET_METHOD = 'extensions.pickComposeTarget';

/**
 * 留给**人**读完权限再决定的时间,谁发起的安装都是这一个。
 *
 * 产品决定:owner 定约 5 分钟(原先 30 秒,「30 秒太短了」)。取 280 秒是要比 harness 自己的工具调用上限
 * (300 秒)短:agent 发起的安装总在它放弃之前有确定结果。它同时是渲染端那口钟,主进程的 IPC 截止线按它推算
 * 并严格更长,见 ipc-bridge 的 HUMAN_DECISION_TIMEOUT_MS。
 */
export const INSTALL_CONSENT_HUMAN_WINDOW_MS = 280_000;

export type ExtensionInstallConsentOutcome =
  | 'confirmed'
  | 'declined'
  | 'dismissed'
  | 'timeout';

/**
 * D-30 (主人 10-06「肯定是能选的啊」, on 主人 10-02's 「在哪些地方启用」): one place an App's agent tools can reach, as the
 * person picks it — never anything an App's own verbs read (125 10-05):
 * - `here`: this computer's agents, every one (`here:all`; an App nobody chose for reaches them, 125 10-06), kept with the
 *   install;
 * - `agent`: one of the person's agents — what the database keeps is the private chat with it (`id`);
 * - `group`: one of the person's groups, a project's marked (`project`).
 */
export interface EnablePlace {
  id: string;
  kind: 'here' | 'agent' | 'group';
  name?: string;
  /** An agent's: who it is (its face's seed when it has no picture of its own). */
  agentId?: string;
  project?: boolean;
  enabled: boolean;
  /** Drawn as the chat list draws it: an agent's face, a group's picture or its members' faces. */
  avatar?: string | null;
  members?: GroupAvatarMember[];
  memberCount?: number;
  /** When it last spoke: the ones recently talked in first. */
  lastAt?: string | null;
  /** The names of a group's topics: a topic's name finds its group. */
  topics?: string[];
  /** An install from a card: the chat the card is in (marked 「卡片所在」, 方案 A). */
  card?: boolean;
}
export const HERE_ALL = 'here:all';

export interface ExtensionInstallConsentRequest {
  sourceDir: string;
  manifest: ExtensionManifest;
  manifestDigest: string;
  installed?: ExtensionManifest;
  revokedPermissions: string[];
  /**
   * A package from a chat: who sent it. `replaces` (摩擦单 F66): the one installed came from someone else — their name
   * (null when not known) — so this is another publisher's App under the same id, asked about in full.
   */
  attachment?: { from: string; replaces?: string | null };
  /** From the market (installExtensionFromMarket): where this version's code is, as the market recorded it, and what it changed. */
  market?: { source: MarketCodeSource; releaseNotes?: string };
  /** D-30: an App giving agents tools asks which agents get them — these places, the ones ticked at first marked. */
  places?: EnablePlace[];
  /** D-31 The one ask, wherever it is drawn: its approval in the agent's session and this window's sheet share it. */
  requestId?: string;
  /** D-31 An agent asked for it: the sheet says 「〈agent〉要装 X」, with its face. */
  requester?: ExtensionConsentRequester;
  /** D-31 The computer it installs on, when that is not the one asking (`app_install { device }`): its agents are that one's. */
  machine?: string;
}

/** The agent an install was asked for by: its name, and its id for its face (each surface draws it as its chat list does). */
export interface ExtensionConsentRequester {
  name: string;
  agentUserId: string | null;
}

/**
 * D-31 An App install asked as an approval in the agent's session (`HostAsk` kind `app-install`): what a phone, another desktop
 * or this one needs to draw its own sheet for it, and to answer it back through the session (`enableIn` with the option).
 */
export interface AppInstallAsk {
  request: ExtensionInstallConsentRequest;
}
export const APP_INSTALL_OPTION = 'install';
export const APP_INSTALL_DECLINE_OPTION = 'decline';

/** The App install a session's approval asks about, when it is one (read on every surface from `Settlement.host`). */
export function appInstallAskOf(host: { kind: string; payload: unknown } | undefined): AppInstallAsk | null {
  if (host?.kind !== 'app-install') return null;
  const payload = host.payload as Partial<AppInstallAsk> | null;
  return payload && typeof payload.request === 'object' && payload.request ? (payload as AppInstallAsk) : null;
}

export interface ExtensionInstallConsentResult {
  outcome: ExtensionInstallConsentOutcome;
  /** D-30: the places switched on when the person confirmed (only when the sheet asked). */
  enableIn?: string[];
  /** owner 10-16: the person's other computers it also goes on, ticked in the same sheet (only when the sheet listed them). */
  alsoOn?: string[];
}

/** owner 10-16 One of the person's other computers an install may also go on, as the sheet names it. */
export interface InstallAlsoOnMachine {
  id: string;
  label: string;
  /** Listed but not to be ticked, and why (owner 09-25「完整能力披露」): a folder's App goes on this computer only. */
  disabledReason?: string;
}

export const EXTENSION_INSTALL_CONSENT_METHOD = 'extensions.requestInstallConsent';
/** D-31 The ask was answered elsewhere (or ran out): this window's sheet for it goes. */
export const EXTENSION_INSTALL_CONSENT_CLOSE_METHOD = 'extensions.closeInstallConsent';

/**
 * The consent is asked where the person is (摩擦单 F6): the group chat, its side panel, the session page —
 * never by switching the view. The session page's own dialogs live inside its (possibly hidden) mount,
 * so the ask goes to the window's shell as a window event; the shell's consent sheet, drawn over
 * whatever is on screen, marks it `shown` at once and answers with EXTENSION_CONSENT_ANSWER_EVENT.
 */
export const EXTENSION_CONSENT_EVENT = 'gugu:extension-consent';
export const EXTENSION_CONSENT_ANSWER_EVENT = 'gugu:extension-consent-answer';
/** What an install runs, word for word, folded under the plain sentence (「详情」): the programs' command lines. */
export interface ExtensionConsentDetails {
  label: string;
  caption: string;
  lines: string[];
}

export type ExtensionConsentEventDetail =
  | {
      type: 'ask';
      requestId: string;
      title: string;
      description: string;
      details?: ExtensionConsentDetails;
      /** D-30: which agents get its tools — the places to list, the ones ticked at first marked. Absent: not asked. */
      places?: EnablePlace[];
      /** D-31: the agent that asked, drawn above the title with its face. */
      requester?: ExtensionConsentRequester;
      /** D-31: the computer it installs on, when that is not the one showing the sheet — its agents are that computer's. */
      machine?: string;
      /** owner 10-16: the person's other computers it may also go on with this one yes, each by name. Absent: not asked. */
      alsoOn?: InstallAlsoOnMachine[];
      confirmLabel: string;
      /** What the button that says no says, when 「取消」 would mislead (first run: 「不装」 is never asked again). */
      cancelLabel?: string;
      /** Set to true by the shell's sheet when it takes the ask. */
      shown: boolean;
    }
  /** The ask ran out (INSTALL_CONSENT_HUMAN_WINDOW_MS), or was answered on another surface (D-31): the sheet goes. */
  | { type: 'close'; requestId: string };
export interface ExtensionConsentAnswerDetail {
  requestId: string;
  outcome: Exclude<ExtensionInstallConsentOutcome, 'timeout'>;
  /** D-30: the places on when the person answered, when the sheet asked. */
  enableIn?: string[];
  /** owner 10-16: the other computers ticked, when the sheet listed them. */
  alsoOn?: string[];
}

export type ExtensionHostActionResult = LinkPlace | 'own' | void;
