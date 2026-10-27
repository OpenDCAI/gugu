import type { AppFileEntry, AppFileRef, AppPlace } from './app-runtime-protocol';
import { dispatchNeeds, dispatchNeedsGesture } from './app-dispatch-core';
import type { ExtensionCapability } from './manifest';

/**
 * The host↔extension bridge — the whole vocabulary an extension has. Its one version
 * number is `EXTENSION_API_VERSION` below.
 *
 * A tab extension only does two things (product spec):把东西画
 * 出来,把用户的动作转达出去. So these verbs are about **content and
 * presentation**, never about lending an extension the host's authority: it can
 * ask the host to do a bounded thing on its behalf, and the host decides how.
 *
 * ⚠️ Every call here is either free (it only concerns the extension's own tab)
 * or gated by exactly one declared capability — which one may follow from what
 * the call names (`dispatch`: its target), never two at once. There is no "and
 * also" call: one that needed two permissions would make the plain-words consent
 * list ("this extension may…") stop describing what actually happens.
 *
 * ❌ This is not an imperative host API. Menus, toolbars and icons are
 * *declared* in the manifest and drawn by the host — an extension that could
 * mutate host chrome at will is the first step toward「宿主即 VSCode」, which the
 * product红线 refuses. Refs #2374.
 */

export const EXTENSION_BRIDGE_CHANNEL = 'gugu-ext:call';
export const EXTENSION_BRIDGE_EVENT_CHANNEL = 'gugu-ext:event';
/**
 * The theme an App page is drawn in, asked synchronously by its preload before the page's first line runs
 * (`GuguHost.theme`): the first paint is then already in gugu's theme. The context that says it arrives after that paint,
 * and a `<webview>`'s own `prefers-color-scheme` is the OS's, whatever its embedder declares (Electron 44, measured
 * 10-10) — a light gugu on a dark Windows flashed every App page dark.
 */
export const EXTENSION_THEME_CHANNEL = 'gugu-ext:theme';
/**
 * The one contract number: what a manifest declares (`apiVersion`, checked in manifest.ts) and what a page reads
 * (`gugu.apiVersion`, `getContext().apiVersion`). Here, not in manifest.ts, so the runtime and the preload read it
 * without the schema. A manifest for an older one is refused with what to do (manifest.ts).
 * 4 (10-15, App 引用 pill): `compose` / `send` name files with `refs`, `about` is gone. 3 still runs (an App passing
 * `about` is told it is gone); the number is what the market picks by, so a client that knows only 3 is handed an
 * App's last version for 3 (`compatOf`: x.y.z cannot tell one Beta from another).
 * 5: tool Apps may omit HTML; the host supplies their settings/status page and declared configuration.
 * 6 (10-19, #7478): `chat:read` / `gugu.messages`. A manifest declaring `chat:read` must say 6 (manifest.ts), so a
 * client that knows only 5 — the 0.2.57 Betas before #7478, which share its x.y.z — is handed the App's last version
 * for 5 (`compatOf` → needs-newer-app) instead of a manifest its schema refuses.
 * 7 (10-19): a link in a session's chat to a working-copy file carries a place (`path#k=v`, the App's `onLink`). An App
 * whose agents cite such links says 7: a client before it opens nothing for them, and is handed the App's last version for 6.
 * 8 (10-20): a manifest may carry `subtitle` (the market's line under the name, manifest.ts). A schema before it refuses
 * the field, and 0.2.57-beta.113.1 / 115.1 (built from #7541) know 7 but not `subtitle` — so an App that writes one says
 * 8, and a client that knows only 7 is handed the App's last version for 7.
 * 9 (10-20, 论坛): `gugu.forum.*` (app-forum-core.ts). An App that calls it says 9, so a client without it is handed the
 * App's last version for 8 instead of a page whose calls are missing.
 * 10 (10-23): `gugu.compose(text)` may name no place — the host asks the person where (`ComposeTargetPicker`). An App that
 * leaves it to the host says 10: a client before it refuses the call (`Say where`), and is handed the App's last version for 9.
 * 11: gugu.modal opens a sandboxed App page in the host's window-level dialog shell, on desktop and phone.
 * 12: `platforms` declares the human-facing interface's supported devices. Earlier strict schemas refuse the field,
 * so the market must hand those clients their previous App version. Installed older Apps still run on this client.
 * 13: common resource linkTo/openLink on desktop, phone and programs (generation only).
 * 14 (10-24): a tab's `chatFile` names the file it shows when the App is opened in a chat, so that open and the file opened
 * from the folder are one tab. Earlier strict schemas refuse the field: the market hands those clients the App's last version for 13.
 * 15 (10-25, owner「全部统一」): `gugu.dispatch` (app-dispatch-core.ts) is the one way an App hands something to someone;
 * `compose`, `send`, `messageAgent` and `spawnAgent` are gone (a call to one says where it went, `DISPATCH_GONE`). An App
 * that dispatches says 15, so a client before it is handed the App's last version for 14. The oldest supported stays
 * (manifest.ts): an App that never handed anything to anyone runs as it did.
 * 16 (10-26, owner「根据该页面自己的声明」): a tab's `sideWidth` says how wide its page is beside a chat or a task's
 * conversation. Earlier strict schemas refuse the field: the market hands those clients the App's last version for 15.
 * 17: explicit-device App programs, read-only external session history/context, and dispatch spawn.device.
 */
// 18: explicit App-data create/open options, metadata, per-chat folder preferences and the shared host context menu.
export const EXTENSION_API_VERSION = 18;

/**
 * The page `app_check` runs is started with this argument (摩擦单 F5, F69): it says how often it wrote, set presence and
 * opened files — what the check reads to know its opens settled, and how busy it was (`CheckReadings`).
 */
export const CHECK_PAGE_ARG = '--gugu-check-page';

/** What the check's page did to its open files (it says so itself; each rate is the peak over any 1 s). */
export interface PageCounts {
  writes: number;
  writesPerSecond: number;
  presenceSets: number;
  presencePerSecond: number;
  /** `files.open` calls, and how many of them have resolved or rejected (摩擦单 F5: the check waits for those). */
  opens: number;
  opensSettled: number;
}

/** What the check's page did (摩擦单 F69): its counts, and what it handed back to the agent that works it. */
export interface CheckReadings extends PageCounts {
  /** What would have reached the person's screen, in order (`VerbFacts.toAgent`): not done, the agent's to read (owner 10-14). */
  shown: { verb: string; detail: string }[];
}

/** The chat a surface is drawn for, as `extensionChatOf` reads it (one read, both hosts). */
export interface ExtensionChat {
  id: string;
  /** The group's or the topic's name; a private chat's is the other one's in it, by the name they gave themselves. */
  name: string;
  kind: 'group' | 'topic' | 'dm';
  /** The group: this chat for a group, the one a topic grew out of; null for a private chat and a topic of one. */
  groupId: string | null;
}

/**
 * Someone in a chat — identities only, never what anyone said (摩擦单 F36). Ids are `user:<uuid>`, as presence and the MCP
 * tools write them. `avatar`: their face as the host draws it — their upload, else their default face from their id —
 * 128px, a `data:` URL an `<img src>` takes as it is. Every member has one (absent only when their upload could not be
 * loaded); no one outside the chat does.
 */
export interface ExtensionMember {
  id: string;
  name: string;
  kind: 'human' | 'agent';
  avatar?: string;
}

/** The session a surface is drawn in, as `getContext().session` gives it. */
export interface ExtensionSession {
  id: string;
  /** Its agent, `user:<uuid>` — the one id an App names an agent by (F35), `listAgents`' `agentId`. Absent: none yet. */
  agentId?: string;
  /** The project it is in; absent for a session in none — a real answer, ❌ "". */
  projectId?: string;
  /**
   * Absolute path of its working copy — present only with `files:read` or `files:write`. Absent means "not
   * granted" (or not open on this computer), never "none": an extension must not read a missing root as permission to guess.
   */
  root?: string;
  /**
   * The machine the session is on when it is not this computer (owner 10-16): what its page shows is that machine's, and
   * its `callProgram` runs there. Absent for a session of this computer. `root` is then absent too — the program finds its
   * working copy stamped on its call (`gugu/workspaceRoot`), on its own machine.
   */
  deviceId?: string;
  deviceLabel?: string;
}

/**
 * Who is working a page (owner 10-14): the person, or one of their agents — an agent's page is the one its `app_check`
 * opened. A page is one copy opened somewhere, and this is one fact about it like where: what the page does in someone's
 * name is done in this one's.
 */
export type ExtensionOperator = { kind: 'person' } | { kind: 'agent'; id: string };

/**
 * Where this surface sits right now (真源原则 13): read-only facts, no permission needed. Where a page is open decides
 * only which of these are present — never which calls it may make, nor what a call means. Every call names its target
 * (a chat, a session, a file) itself, from these facts or anywhere else.
 */
export interface ExtensionHostContext {
  /** Bridge revision, so an extension built against a later host can say so. */
  apiVersion: number;
  /**
   * Which tab this is, when several tabs of the same kind are open. Without it an extension cannot tell its own
   * instances apart. Absent on a page nobody draws — the background page, a program.
   */
  tabId?: string;
  /** A host modal's initial data, under the opener's context and existing grants. */
  modal?: { data?: unknown };
  /**
   * The chat this surface is drawn for (its panel, 「在本群打开」): a group, a topic or a private chat, with who is in
   * it — changes arrive by `onContextChanged`. Absent is a real answer: not in a chat. ❌ No `placement` field: an App
   * decides how to look from which of these facts are present, its capabilities and its layout (L3 评审第 2 条).
   */
  chat?: ExtensionChat & { members: ExtensionMember[] };
  /** The session this surface is drawn in (a session's tab). Absent is a real answer: in no session. */
  session?: ExtensionSession;
  /**
   * The file this surface was opened for — present only when the person opened that file with this App. It names
   * where it lives (`{ chat, id }`, `{ session, id }` or `{ project, id }`), so `gugu.files.open(ctx.file)` opens it, and it is the one
   * file an App that asked for nothing may open. Absent is a real answer: opened for its own sake.
   */
  file?: AppFileRef & { id: string };
  /** Who is working this page (`user:<uuid>` for an agent). Absent on a page nobody draws — the background page, a program. */
  operator?: ExtensionOperator;
  /** BCP-47 tag of the interface language the user is reading. */
  locale: string;
  /** Whether the host is currently painting light or dark. */
  themeMode: 'light' | 'dark';
  /** What this extension may actually do right now, after any revocations, on this host. */
  capabilities: readonly ExtensionCapability[];
  /** How the host is showing this surface at the moment. Absent on a page nobody draws. */
  layout?: ExtensionLayoutState;
}

/**
 * Which page a message or a call came from, as the host knows it — the place facts of that page's `getContext()`, in
 * the same shape (`onViewMessage`'s `from`, a page's `callProgram`). Filled by the host, never by the page.
 */
export type ExtensionPageFrom = Pick<ExtensionHostContext, 'tabId' | 'session' | 'file' | 'operator'> & {
  chat?: ExtensionChat;
};

export interface ExtensionLayoutState {
  visible: boolean;
  fullscreen: boolean;
  width: number;
  height: number;
}

/**
 * The half of the layout only the renderer can know: the surface's own box and
 * whether it is on screen at all.
 *
 * Split from `fullscreen` on purpose — that one is a window fact main reads
 * directly. Letting the renderer report it too would mean two sources for one
 * truth, and the stale one wins whichever way you order them.
 */
export interface ExtensionSurfaceMetrics {
  visible: boolean;
  width: number;
  height: number;
}

/**
 * What the app itself is showing right now.
 *
 * Separate from `ExtensionHostContext` on purpose. Context answers「我这块 surface
 * 坐在哪」—— low-frequency, stable for most of a tab's life. This answers「用户此刻
 * 在干什么」, which moves every time they click a tab. Folding them together would
 * make every theme change re-push「用户是不是切会话了」and every pane switch re-push
 * the locale, so every surface would have to diff a payload to find out which of
 * two unrelated things actually moved.
 *
 * Read-only, and deliberately so: this is a *state* surface. Asking the app to
 * switch to some agent is a control verb and does not live here.
 */
export interface ExtensionAppState {
  /**
   * Whether gugu's own window is in the foreground.
   *
   * Read by main from the window itself, never reported by the renderer — the
   * same rule `ExtensionSurfaceMetrics` states for `fullscreen`: one truth, one
   * source, or the stale writer wins whichever way you order them.
   */
  windowFocused: boolean;
  /**
   * The session whose view the user is currently looking at, or `null` when no session
   * view is on screen.
   *
   * An App whose own `context.session.id` differs from this is being told, in
   * so many words,「用户现在看的不是我这条会话」—— which is a fact it can act on
   * (stop animating, stop polling), not an error.
   */
  activeSessionId: string | null;
  /**
   * The project that session belongs to, or `null` when no session view is on screen.
   *
   * Sits beside `activeSessionId` rather than being derivable: without it the only
   * way to answer「我在哪个项目」was to take a pane's `agentId`, look it up in
   * `listAgents()`, and read that agent's `projectId` — which needs
   * `agents:read`, needs that pane to be showing an agent at all (a file tab has
   * none), and costs a second call. 「我在哪个项目」and「我在哪条会话」are the
   * same kind of fact and belong at the same level.
   *
   * Ungated, exactly like `activeSessionId`: both are opaque ids naming where the
   * user is, and gating one while handing over the other would be incoherent.
   */
  activeProjectId: string | null;
  /**
   * The panes of that session view, in on-screen order.
   *
   * A list, not a single field: the workspace panel splits, and each pane keeps
   * its own active tab. 「当前打开的那个 agent」is genuinely plural here, so a
   * lone `activeAgentId` would start lying the moment anyone splits the view.
   */
  panes: readonly ExtensionPaneView[];
}

/** One pane of the workspace panel, and what it is showing. */
export interface ExtensionPaneView {
  paneId: string;
  /** The pane the user's keyboard is in. Exactly one, whenever any pane exists. */
  focused: boolean;
  /** What that pane currently shows, or `null` when the pane holds nothing. */
  activeTab: ExtensionPaneTab | null;
}

/**
 * The tab a pane is showing.
 *
 * `kind` is handed over verbatim as the host's own word, and is NOT a closed
 * union: the tab-provider registry is open and extensions register kinds of
 * their own, so any union written here would be wrong as soon as someone
 * installs anything. A surface that does not recognise a kind should ignore it,
 * not treat it as a bug.
 */
export interface ExtensionPaneTab {
  tabId: string;
  kind: string;
  /**
   * The agent this tab is showing — present only when the tab *is* an agent AND
   * this surface holds `agents:read`.
   *
   * Absent means「没给我看」, never「不是 agent」: `kind` already answers the
   * second question. Same shape as `workspaceRoot` in the context, for the same
   * reason — being told which agent the user is looking at is an agent fact, and
   * consent for it is the consent the user gave for agent facts.
   */
  agentId?: string;
  /**
   * The file this tab is showing, workspace-relative — present only when the tab
   * *is* a file AND this surface holds `files:read`.
   *
   * Gated, unlike `context.file`: that one is the file this page was opened
   * for, because this extension claimed the type. Which files the user has open
   * *elsewhere* is a fact about the working copy, and that is what
   * `files:read` covers.
   */
  filePath?: string;
}

/**
 * One agent, as an extension sees it.
 *
 * Named in the extension's vocabulary, not the host's: inside gugu this row is a
 * *conversation*, but an extension author is looking at「一个 agent」. Leaking the
 * internal word would make the API teach the wrong model, and would tie a public
 * surface to a table name.
 *
 * Every uncertain field is `null` rather than a stand-in value —「问不出来」and
 *「确实是零」must stay distinguishable (behavior tab-extensions:「如实给空,
 * ❌ 凑一个数字冒充」).
 */
export interface ExtensionAgentView {
  /** `user:<uuid>`: the agent's gugu identity, the one id an App names an agent by (F35). */
  agentId: string;
  sessionId: string;
  /** Which of the person's machines it runs on (`null` = this one; others only with `agents:read:all-machines`, their live fields `null`). */
  deviceId: string | null;
  deviceLabel: string | null;
  projectId: string;
  title: string;
  /** Which engine is behind it, or `null` when the host never recorded one. */
  providerId: string | null;
  /**
   * Its model, as `dispatch` to a new agent (and `session_spawn`) take one back: a Gugu model's `platform:<id>`, else the engine's
   * own; `null` when the session never chose one (its engine's default).
   */
  model: string | null;
  /** Where it runs: `'acp'` a chat panel, `'pty'` a terminal — the words `dispatch`'s `spawn` and `session_spawn` take. */
  transport: 'acp' | 'pty';
  /** The agent this one is listed under (its parent in the session list); null for a root. Not who spawned it. */
  parentAgentId: string | null;
  /**
   * This extension started it (`dispatch` to `{ new: true }`). Such an agent lives in a session of
   * its own, and is in this extension's own scope anyway. Only「是不是我」—
   * ❌ 不给别的扩展的 id。
   */
  spawnedByThisExtension: boolean;
  /**
   * 基础态(spec agent-status-vocabulary):`idle` | `working` | `needs_user` | `error`;`null` = 这条会话没有状态源
   * (不发 hook 的终端会话)。
   */
  status: string | null;
  /**
   * 细分(spec agent-status-vocabulary),与 `status` 同一次落库:`working` 是 `running` | `parked`,`needs_user` 是
   * `approval` | `question` | `plan` | `dialog`(在等人做哪件事),`idle` 是 `done`(这一轮跑完了)| `plain`(被打断、
   * 退出或还没跑过)。`error` 没有细分,为 `null`;没有状态源的会话也是 `null`。
   */
  detail: string | null;
  /** Panel sessions only; `null` for a terminal, which cannot be asked. */
  isGenerating: boolean | null;
  lastStopReason: string | null;
  /**
   * Why its engine is gone, when it went away on its own: `adapter-exit` (the engine's process exited — `exitCode` /
   * `signal`) or `start-failed` (it never started), with the runtime's `message`. `null` while it is fine or was
   * stopped on purpose. Panel sessions only — a terminal's exit is not kept; a lost session keeps it until it starts again.
   */
  failure: { kind: 'adapter-exit' | 'start-failed'; message: string; exitCode: number | null; signal: string | null } | null;
  /**
   * Its newest tool call (ISO-8601), however long ago — compare it with the time yourself. A lost session keeps the last
   * one before its engine died. `null` for terminals and panel sessions not open, like the counters.
   */
  lastActionAt: string | null;
  /** Waiting on a human to approve something. Panel sessions only. */
  pendingPermissionCount: number | null;
  /** Turns typed but not yet sent. Panel sessions only. */
  queuedPromptCount: number | null;
  /**
   * How much context its engine last reported in use, in tokens — what the next turn reads back. Panel sessions only,
   * and only while open, like the counters: `null` is "cannot be asked", ❌ zero.
   */
  contextTokens: number | null;
  /**
   * The account's limit as its engine last reported it (G3): `allowed`, `allowed_warning` (near it) or `rejected` until
   * `resetsAt` (ISO-8601); `window` is the engine's name for the limit (`five_hour`, `seven_day`, …), `utilization` how
   * much of it is used, as the engine says it. Panel sessions only, and only while open; an engine that never reported
   * one (a terminal, an API key, gugu's models) is `null`.
   */
  rateLimit: {
    status: 'allowed' | 'allowed_warning' | 'rejected';
    resetsAt: string | null;
    window: string | null;
    utilization: number | null;
  } | null;
  /**
   * When it was last interacted with, as the host stores it (ISO-8601 text).
   *
   * ❌ 不转成毫秒数:库里存的就是文本,转一道等于在公开面上引入一个时区/解析的
   * 猜测,而调用方拿 `Date` 一样解得动。
   */
  updatedAt: string | null;
}

/**
 * One thing that was said in an agent's conversation.
 *
 * Deliberately flat text: what an extension gets is what was said, not gugu's
 * internal event shape. A richer structure would tie every extension to an
 * internal format that changes for reasons that have nothing to do with them —
 * so thinking blocks and tool calls are not in here at all.
 */
export interface ExtensionAgentMessage {
  messageId: string;
  /** `user` or `assistant`. */
  sender: string;
  text: string;
  /** Which turn it belongs to, for callers that want to regroup. */
  turnId: string;
  /**
   * Position in the conversation. Pass the page's `nextCursor` back as `before`
   * to walk further back.
   */
  seq: number;
  /**
   * When that turn began (ISO-8601), or `null` when the engine did not say —
   * ❌ 不拿当下时间冒充。
   */
  startedAt: string | null;
}

/**
 * One page of an agent's conversation, oldest turn first (newest last).
 *
 * `nextCursor` is `null` when the page reached the beginning. Anything else is
 * a `seq` to pass back as `before`. ❌ 别只给一个截断标志:一个说「还有」却不说
 * 「从哪继续」的分页,等于让调用方自己去猜内部序号。
 */
export interface ExtensionAgentHistoryPage {
  messages: ExtensionAgentMessage[];
  nextCursor: number | null;
}

/*
 * 「看这里」(behavior tab-extensions:「至多可以请 tab 定位到某处」)不在这里,
 * 而且是有意不在:那条 behavior 是一条 ❌ 项的**上限**——「❌ 给 agent 一套操作
 * tab 的工具,它至多可以请 tab 定位到某处」——不是一条要交付的能力。少做不越线,
 * 多做才越线。
 *
 * 之前这里有过一整套(请求类型 + 事件分支 + `window.gugu.onLocate` + 主进程的
 * 发送函数),唯独没有任何一个地方调用它。真要做,缺的不是这几行,是「agent 怎么
 * 指名一个 tab」:工具侧今天连 tab 地址都没有(extension-agent-actions.ts 只有
 * create/install/list)。那是一件独立的活,连同它的权限故事一起做,而不是先把
 * 一条谁也够不着的线埋在协议里。
 */

/** Events the host pushes to a surface. Each is a fact, never a command. */
export type ExtensionHostEvent =
  | { type: 'context'; context: ExtensionHostContext }
  | { type: 'modalFocus'; edge: 'first' | 'last' }
  /**
   * The user picked something the extension declared in its manifest.
   *
   * Declarative on purpose: the extension says *what* it offers, the host draws
   * it in host chrome and decides when it is reachable. An imperative
   *「给我一个菜单对象」API would put the extension in charge of the host's own
   * furniture, which is the line this design does not cross.
   *
   * Carries no permission of its own: being told a user clicked inside your own
   * tab is not an ability, and what the extension does next still goes through
   * the same capability checks as anything else.
   */
  | { type: 'command'; commandId: string }
  /**
   * 后台实例发给视图的一条消息。
   *
   * 「跨会话共享的活实例」的另一半:后台持有活状态,视图靠这条把它画出来。
   * 广播给这个扩展**所有**活着的视图 —— 后台不选收件人,因为它本来就只有一份状态,
   * 「这条只给某一格看」是视图自己按上下文判断的事。
   */
  | { type: 'from-background'; message: unknown }
  /**
   * 某个视图发给后台的一条消息,附带那个视图的上下文。
   *
   * `from` 是**宿主填的**,不是视图自报:后台据此判断「这条是从哪个对话、哪条会话、哪个文件来的」,
   * 而一个能自报上下文的视图等于能冒充别的会话。形状就是那一页 `getContext()` 里的那几项(真源原则 13)。
   */
  | {
      type: 'from-view'
      message: unknown
      from: ExtensionPageFrom
    }
  /**
   * Files changed where a page asked to hear about them (`gugu.files.onChanged(place, fn)`): a session's working copy on
   * disk, or a chat's workspace.
   *
   * This is the channel behavior tab-extensions asks for —「tab 自己感知到文件变化并重画」—— and it is deliberately the
   * ONLY one an agent's work reaches a surface through. The host does not tell a tab what an agent did, or ask it to
   * redraw: it states that files moved, and the tab decides whether that concerns it. Anything stronger would make
   * extensions part of the agent loop.
   *
   * Working-copy paths are relative and POSIX-separated, the ids `gugu.files.list` gives. A chat says which files (#7257):
   * the account's revisions name them, and the host reads those rows once for the batch — `entries` as `gugu.files.list`
   * gives them, `gone` the ids no longer there for whoever reads. Rides on `files:read`, re-read at every batch.
   *
   * `resync` (a working copy only) means "re-read what you care about": the watcher lost its place. It carries no paths
   * on purpose — a guessed set would be worse.
   */
  | { type: 'filesChanged'; watchId: string; place: AppPlace; change: ExtensionFileChangeBatch }
  /**
   * What the app is showing moved — a pane switched tabs, the view split, the
   * user changed session, or the window gained or lost the foreground.
   *
   * Carries the whole state rather than a delta: it is small, it is pushed only
   * when something actually differs, and a delta would force every surface to
   * keep a replica of the host's layout just to apply it. The scoping is already
   * baked into the payload (`agentId` present only with `agents:read`), so this
   * event needs no capability of its own — a surface without the consent simply
   * gets a state with those fields absent.
   */
  | { type: 'appState'; state: ExtensionAppState }
  /**
   * These agents changed — someone started, stopped, began generating, finished,
   * or is now waiting on a human.
   *
   * Ids only, on purpose. It states that something moved and lets the surface
   * decide whether that concerns it, exactly as `filesChanged` does for the
   * working copy; a surface that cares calls `listAgents` for the details. The
   * alternative — pushing full agent views — would put a second copy of that
   * shape on a hot path, and the two would drift.
   *
   * Rides on `agents:read`, the same way `filesChanged` rides on
   * `files:read`: a surface without it is never subscribed. Ids are filtered
   * to the declared scope, so `agents:read` alone never hears about an agent in
   * another session.
   */
  | { type: 'agentsChanged'; agentIds: readonly string[] }
  /**
   * Something changed in a forum post (`target`: its id) or in the forum's list (`'feed'`) this page subscribed to
   * (`gugu.forum.onChanged`). It says what kind of thing moved, never the thing: the page reads it again. The first one after
   * subscribing is `{ kind: 'subscribed' }` — read now, whatever happened before it.
   */
  | { type: 'forumChanged'; target: string; change: { kind: string; seq?: number; entityId?: string } }
  /**
   * The person clicked a banner this extension posted. Delivered to the background
   * page and to this extension's tabs in the session the banner opened; `tag` and
   * `data` are the extension's own, handed back verbatim.
   */
  | { type: 'notificationClicked'; tag?: string; data?: unknown }
  /**
   * The person opened a link into this extension (`gugu://ext/<id>/<tab>/<path>?<query>`),
   * from a browser, a document, anywhere outside gugu. The host opened `tab` in the
   * session on screen; this says what the link pointed at inside it. A pill to a chat's file (App 引用) is one too:
   * `query` its place, `file` the file's id (#7257) — null for a gugu link, which names no file.
   */
  | { type: 'link'; tab: string; path: string; query: Record<string, string>; file: string | null }
  /**
   * One of this extension's MCP programs sent a notification — e.g. after an agent used its
   * tool. Handed over verbatim to the background page and every live view of the extension.
   */
  | { type: 'programNotification'; server: string; method: string; params?: unknown };

/** What `notify` takes. Title and body are shown under the extension's name. */
export interface ExtensionNotificationRequest {
  title: string;
  body?: string;
  /** A later banner with the same tag replaces this one instead of stacking. */
  tag?: string;
  /** Handed back verbatim on click. JSON-serialisable. */
  data?: unknown;
  /**
   * What a click opens, as the call names it (真源原则 13 — never where the page that posts it is): one of this App's
   * tabs in a session (`tab` defaults to its first), the App in a chat's panel, or a file where it lives. None: the
   * App's own page, as a link naming none.
   */
  open?: { session: string; tab?: string } | { chat: string } | { file: unknown };
}

/** The background page's own preload argument: its `gugu` has the background's members, not a page's (`VerbFacts.only`). */
export const BACKGROUND_PAGE_ARG = '--gugu-app-background';

export type ExtensionFileChangeKind = 'create' | 'update' | 'delete';

export interface ExtensionFileChange {
  kind: ExtensionFileChangeKind;
  /** Workspace-relative, POSIX separators — a session file's id in `gugu.files`. */
  path: string;
}

export type ExtensionFileChangeBatch =
  | { kind: 'changes'; changes: ExtensionFileChange[] }
  | { kind: 'resync' }
  /** A chat's files (#7257): these as they are now; `gone` ids are no longer there. */
  | { kind: 'entries'; entries: AppFileEntry[]; gone: string[] };

/** Everything the host knows about one verb — one row each in `BRIDGE_VERBS`. */
export interface VerbFacts {
  /** The capability it needs, or null when it needs none — or which one, from what the call names (`dispatch`'s target). */
  needs: ExtensionCapability | null | ((args: Record<string, unknown>) => ExtensionCapability | null);
  /**
   * Which caller has it, when not every one does (真源原则 13: where a page is only fills its context, so a verb answers
   * the same for a page, the background page and a program). Absent: all of them.
   * - `page`: it is about a page itself — its tab's title, the person's gesture on it, its message to the background;
   * - `background`: the background page's word to the App's pages.
   * A host leaves out the members it has not (`typeof gugu.x`), so none of them stands there refusing.
   */
  only?: 'page' | 'background';
  /**
   * Only inside the person's gesture (a click, a key), checked where a page script can neither fake nor extend it:
   * `true` always; a function, for the calls that need one — when the host is to show its picker (`filesUpload` with no
   * bytes, `dispatch` with no target) or fill a composer. Only a page has a gesture: from anyone else such a call is refused.
   */
  gesture?: true | ((args: Record<string, unknown>) => boolean);
  /**
   * It reaches the person's screen (a browser tab, a banner, the clipboard, a picker …). On a page an agent works (owner
   * 10-14) it is not done but handed back to that agent (`CheckReadings.shown`), and answered with `answer`; a verb whose
   * gesture is a function, only for the calls that need one (the others reach no screen).
   */
  toAgent?: { answer: unknown };
  /**
   * It follows the machine of the page's session (owner 10-16「程序跟着数据」): a page in a session on another of the
   * person's machines has it done THERE (`agentSession.app_call`), and that machine does it only for a verb with this.
   */
  machine?: true;
}

/**
 * Every call an extension can make, one row each: the capability it needs, whether a background page may call it, whether
 * it needs the person's gesture (L11 B4), what an agent working the page gets instead of the person's screen.
 *
 * One table rather than spread across handlers so that "what needs consent" — and every other fact of a verb — is
 * answerable by reading a single screen; the enforcement indexes it, so a verb cannot quietly ship without its row,
 * and a row without any of its facts does not build.
 */
export const BRIDGE_VERBS = {
  /** The App's own sandboxed page, in the host's dialog shell. No new authority or per-call consent. */
  modalOpen: { needs: null, only: 'page', toAgent: { answer: null } },
  modalClose: { needs: null, only: 'page' },
  /** Runtime keyboard traversal at the edge of a modal guest; not an App-facing member. */
  modalKey: { needs: null, only: 'page' },
  /** Facts about where this surface sits. */
  getContext: { needs: null },
  showContextMenu: { needs: null, only: 'page' },
  /**
   * What the app is showing right now.
   *
   * No capability of its own: the answer is already scoped field by field
   * (`agentId` needs `agents:read`, `filePath` needs `files:read`), so
   * requiring one at the door would put「窗口在不在前台」behind a consent that has
   * nothing to do with it — and a surface that only wants to stop animating when
   * the user looks away would have to ask for agent access to find out.
   */
  getAppState: { needs: null },
  /** Rename this tab (its own tab only). */
  setTabTitle: { needs: null, only: 'page' },
  /** Mark this tab as having something new (its own tab only). */
  setTabBadge: { needs: null, only: 'page' },
  /** Ask the host to open a URL: a browser tab in the page's session, else the person's browser. */
  openBrowserTab: { needs: null, toAgent: { answer: undefined } },
  /** Say something went wrong, loudly, where the user can see it. */
  reportError: { needs: null },
  /** The check's page's counts (`CHECK_PAGE_ARG`, 摩擦单 F69); main ignores it from any other page. */
  checkCounts: { needs: null, only: 'page' },
  /**
   * 视图 → 自己的后台实例。
   *
   * 不要能力:这是扩展**跟自己说话**,两端都在同一个扩展的沙箱里,信道不跨扩展边界
   * (宿主按 session 认身份并路由,❌ 不接受调用方自报是谁)。一条消息能做成什么,
   * 仍然由它落到的那一头各自的能力决定 —— 后台想读文件照样要 `files:read`。
   */
  // 演练里也照常:App 跟自己的后台页说话,是 App 自己的事(owner 10-13)。
  sendToBackground: { needs: null, only: 'page' },
  /** 后台 → 自己所有活着的视图。同上,不要能力。 */
  broadcastToViews: { needs: null, only: 'background' },
  /**
   * Hand something to someone (15, app-dispatch-core.ts): a member of a chat (a whisper, or `visible`), one of the person's
   * agents, a new agent — or only a draft into a chat's or an agent's composer. No target: the person picks in the host's
   * sheet, seeing all that will go, and their press is the consent; a named target needs what its delivery always needed.
   * An agent working the page is handed back what would have reached the person's screen, answered as cancelled.
   */
  dispatch: { needs: dispatchNeeds, gesture: dispatchNeedsGesture, toAgent: { answer: { cancelled: true } } },
  /**
   * A chat's messages, as whoever reads sees them (`app-messages-core.ts`): a stretch of its timeline or one thread, and the
   * ones holding a piece of text or naming a file — the doors an agent's `message_history` / `message_search` take.
   */
  messagesHistory: { needs: 'chat:read' },
  messagesSearch: { needs: 'chat:read' },
  /**
   * The chats whoever reads is in, and who is in one — what an agent's `message_conversations` / `message_members` read
   * (`app-files-core.ts`): an App's own page anywhere can offer a chat, and its people, without being drawn in one.
   */
  chatsList: { needs: 'chat:read' },
  chatsMembers: { needs: 'chat:read' },
  /**
   * This computer's projects, `[{ id, name }]`: each one's root folder is a place for `gugu.files` (`{ project: id }`), read
   * and written as a session's working copy is. The hidden home folder sessions start in when no project is chosen is not one.
   */
  projectsList: { needs: 'files:read' },
  /**
   * 论坛 (9): a page's, public to every signed-in person, read and written as the person (app-forum-core.ts); the database judges who may
   * see and do what. Writing is a page's, in the person's gesture. A bounty's points move only behind a sheet the host draws:
   * `forumPost` with a bounty and `forumAward` answer `{ confirming: true }` once it is up, and the page hears the outcome from
   * `forumSubscribe`. `forumAssign` opens the host's 「交给谁」 sheet on the person's own agents (no capability: the App never
   * lists them; an `agentId` only preselects one) and answers `{ assigned: { agent } }` once the forum took it, or `{ cancelled: true }`.
   */
  forumList: { needs: null, only: 'page' },
  forumRead: { needs: null, only: 'page' },
  forumPost: { needs: null, gesture: true, only: 'page' },
  forumReply: { needs: null, gesture: true, only: 'page' },
  forumReact: { needs: null, gesture: true, only: 'page' },
  forumRemove: { needs: null, gesture: true, only: 'page' },
  forumBlock: { needs: null, gesture: true, only: 'page' },
  forumAssign: { needs: null, gesture: true, only: 'page' },
  forumAward: { needs: null, gesture: true, only: 'page' },
  forumSubscribe: { needs: null, only: 'page' },
  forumUnsubscribe: { needs: null, only: 'page' },
  /**
   * The agents at work, and how each one is doing.
   *
   * The capability named here is the NARROW one; `agents:read:all` satisfies it
   * too and widens the answer instead of unlocking a different verb — same
   * question, bigger room. Enforced in `hasCapability`, so a surface declaring
   * only the wide word is not refused at the door.
   */
  listAgents: { needs: 'agents:read' },
  /**
   * What one agent has been saying.
   *
   * A capability of its own, never folded into `agents:read`:「看看 agent 在忙
   * 什么」and「读我所有对话」are different sentences to the person deciding, and
   * merging them would make the narrower one unobtainable — you would have to
   * hand over the conversation to get a status light.
   */
  readAgentHistory: { needs: 'agents:history' },
  /** External CLI history is every session, never only the agents this App started. */
  sessionsIndex: { needs: 'agents:history:all', machine: true },
  sessionsRead: { needs: 'agents:history:all', machine: true },
  /**
   * Stopping one of the agents this App reaches (starting one, telling one: `dispatch`).
   *
   * ❌ 没有第二道闸。谨慎发生在安装那一刻,不在调用那一刻(behavior tab-extensions)。
   * 起会话和投轮次确实会消耗额度,但那是使用这个产品的后果,不是一个需要独立守卫
   * 的类别 —— agent 早就能递归起 agent,中间也没有预算闸。
   */
  stopAgent: { needs: 'agents:control' },
  /**
   * The extension's own data folder, shared with the MCP programs it runs
   * (`GUGU_EXTENSION_DATA_DIR`). No capability: it is the extension's own storage,
   * reachable by nothing else, and removed with it. Storage only: a program that wants
   * pages to notice what it wrote sends a notification.
   */
  readData: { needs: null, machine: true },
  writeData: { needs: null, machine: true },
  listData: { needs: null, machine: true },
  /**
   * A tool of this extension's own MCP program whose visibility includes `app` (MCP Apps).
   * No capability of its own, like `sendToBackground`: the extension is talking to itself.
   * The program still runs only while `agents:tools` is granted.
   */
  callProgram: { needs: null, machine: true },
  /** Post a system banner under this extension's name. */
  notify: { needs: 'notifications', toAgent: { answer: { shown: true } } },
  /**
   * A link that opens one of this extension's tabs from outside gugu — for a README,
   * an email, an OAuth redirect. No capability: a link does nothing until a person
   * clicks it, and what it opens is this extension's own tab.
   */
  linkTo: { needs: null },
  /*
   * `gugu.files` (L3, 真源原则 9 / 13). Every call names where the file is (`AppPlace`, `AppFileRef`): a chat's
   * workspace or a session's working copy — never the page's own place behind its back. Open/reopen/close/download/
   * openWith decide their own gate: the file the host handed this page (`ctx.file`) needs nothing, any other needs
   * `files:read` (read-only) or `files:write` — so they are listed free here and checked in `app-files.ts`,
   * which is the only place that knows which case it is.
   */
  filesOpen: { needs: null },
  filesReopen: { needs: null },
  filesClose: { needs: null },
  filesList: { needs: 'files:read' },
  /**
   * Files across every chat the reader is in (gugu-supabase 20261017002319): found by a piece of their path, and the ones
   * this person opened last. `files:read` already reads any chat they are in, so it is the same consent.
   */
  filesSearch: { needs: 'files:read' },
  filesRecent: { needs: 'files:read' },
  filesCreate: { needs: 'files:write' },
  filesViewPreferences: { needs: 'files:read', only: 'page' },
  filesRemove: { needs: 'files:write' },
  filesRename: { needs: 'files:write' },
  /** 子文件夹: a folder made (all the way down; one already there is answered), and a file or folder moved into another. */
  filesMkdir: { needs: 'files:write' },
  filesMove: { needs: 'files:write' },
  /**
   * A stored file's content replaced: the same file, its next version (G1), the one it had kept as history. Gated like
   * open read-write: the file the host handed this page needs nothing, any other `files:write` (checked in `app-files.ts`).
   */
  filesReplace: { needs: null },
  /** A chat file's kept versions, and one version's content (G2). Gated like open read-only, in `app-files.ts`. */
  filesVersions: { needs: null },
  filesReadVersion: { needs: null },
  /** Hear (or stop hearing) that files changed in one place: `files.onChanged(place, fn)`, the `filesChanged` event. */
  filesWatch: { needs: 'files:read' },
  /**
   * Upload bytes the caller has — a page, a background page, an App's program (G5) — or files the person picks in the
   * host's picker (a page's, only inside a gesture, checked in the preload). The credential stays in main (真源 §2.4).
   */
  filesUpload: { needs: 'files:write', toAgent: { answer: [] }, gesture: (args) => args.pick === true },
  /** Save a file to disk through the host's save dialog, inside a gesture. Gated like open. */
  filesDownload: { needs: null, toAgent: { answer: true }, gesture: true, only: 'page' },
  /**
   * 「用 X 打开」: open a file with the App the person uses for it where it lives (the claims in `opensFiles.chat` or
   * `opensFiles.session`, 「用哪个打开」 when several). Inside a gesture; gated like download. `peek` (G1): beside the
   * page that asked, in its slot, the page left as it is — a chat file nobody opens in the host's preview there.
   */
  filesOpenWith: { needs: null, toAgent: { answer: undefined }, gesture: true, only: 'page' },
  /**
   * Bring a message into view: its chat opens, scrolled to it (the files' source messages, 真源 §2.4) — any chat the
   * person is in, wherever the page is. Inside a gesture; the page learns nothing about the message.
   */
  showMessage: { needs: null, toAgent: { answer: undefined }, gesture: true, only: 'page' },
  /**
   * Bring a session into view, as a click on its row in the task list does — one of this computer's, or one of another
   * computer's the list shows (#6264) — wherever the page is. Its id as `ctx.session.id`, `listAgents`' `sessionId` and a
   * tool call's `call.session` give it. Inside a gesture; the page learns nothing about the session. `peek` (G1): its own
   * session page beside the page that asked, instead.
   */
  showSession: { needs: null, toAgent: { answer: undefined }, gesture: true, only: 'page' },
  /**
   * The person clicked a link of gugu's own in the page (what `linkTo` makes): it opens through the one opener a link
   * from outside gugu takes. Public on `window.gugu`; the runtime also sends a real click on an
   * `<a>`; a page script that moves `location` is still stopped at `will-navigate`, and any other link is still refused.
   */
  openLink: { needs: null, toAgent: { answer: undefined }, gesture: true, only: 'page' },
  /**
   * Put text on the system clipboard (`gugu.clipboard.writeText`). No capability, as on the
   * web: it needs the person's gesture — checked in the preload's world, where a page script
   * cannot fake it — and it only ever writes. It exists because a sandboxed frame on
   * WebView 133 offers no copy menu at all (真源 §4, L1 T3).
   */
  clipboardWriteText: { needs: null, toAgent: { answer: undefined }, gesture: true, only: 'page' },
} as const satisfies Record<string, VerbFacts>;

export type ExtensionBridgeMethod = keyof typeof BRIDGE_VERBS;

/** The verbs whose row says `machine`: read off the table, so a row is the one place that makes a verb follow the session's machine. */
export type MachineVerb = { [K in ExtensionBridgeMethod]: (typeof BRIDGE_VERBS)[K] extends { machine: true } ? K : never }[ExtensionBridgeMethod];

export function isMachineVerb(method: string): method is MachineVerb {
  return verbFacts(method)?.machine === true;
}

/** A verb's row, or undefined for a name that is not one. */
export function verbFacts(method: string): VerbFacts | undefined {
  return Object.hasOwn(BRIDGE_VERBS, method) ? BRIDGE_VERBS[method as ExtensionBridgeMethod] : undefined;
}

/**
 * Whether this call has to come inside the person's gesture (`VerbFacts.gesture`). Each host asks once, where a call
 * arrives, with the activation it read there — before anything is awaited: the activation lapses.
 */
export function needsGesture(method: string, args: unknown): boolean {
  const gesture = verbFacts(method)?.gesture;
  return gesture === true || (typeof gesture === 'function' && gesture((args ?? {}) as Record<string, unknown>));
}

/** The capability this call needs, by its verb's row (for `dispatch`, by the target it names). */
export function capabilityNeeded(facts: VerbFacts, args: unknown): ExtensionCapability | null {
  return typeof facts.needs === 'function' ? facts.needs((args ?? {}) as Record<string, unknown>) : facts.needs;
}

/** A call made outside the gesture it needs, refused — in these words on every host. */
export function gestureRefusal(method: string): { code: 'denied'; message: string } {
  return { code: 'denied', message: `${method} needs a gesture from the person: call it from a click or key handler` };
}

export const CALLER_WORDS = { page: 'a page', background: 'the background page', program: 'a program' } as const;

/**
 * Whether this caller may make this call at all, by the verb's row — said in the same words on every host (the desktop's
 * main, the phone's host): a verb that is no verb, one that is another caller's (`only`), one whose capability this App
 * has not (`needs`), and — where the host reads the gesture itself (`gesture` given) — one outside the gesture it needs.
 * Null: it may.
 */
export function callRefusal(
  method: string,
  args: unknown,
  caller: { kind: keyof typeof CALLER_WORDS; has: (capability: ExtensionCapability) => boolean; gesture?: boolean },
): { code: 'invalid' | 'denied'; message: string } | null {
  const facts = verbFacts(method);
  if (!facts) return { code: 'invalid', message: `Unknown method: ${method}` };
  // Not on its `gugu` at all (`typeof gugu.x`): only a caller that went around its host gets here.
  if (facts.only && facts.only !== caller.kind) return { code: 'invalid', message: `${method} is ${CALLER_WORDS[facts.only]}'s; ${CALLER_WORDS[caller.kind]} has none` };
  // Named so the author can see which declaration is missing (or was taken back) instead of guessing why a call stopped working.
  const needs = capabilityNeeded(facts, args);
  if (needs !== null && !caller.has(needs)) return { code: 'denied', message: `Not permitted: this App does not have "${needs}"` };
  // Only a page has a gesture: the background page and a program never make a call that needs one.
  if ((caller.gesture === false || caller.kind !== 'page') && needsGesture(method, args)) return gestureRefusal(method);
  return null;
}

/**
 * Every code a verb's failure carries out to the App (`gugu.files` and `dispatch` say which failure it was, and an App
 * branches on that) — one list, which the answer's type and the runtime's `GuguErrorCode` are made of.
 * - `denied` is the only one that means the user said no.
 * - `not-found` / `ambiguous`: `gugu.files` naming a file that is not there, or not only once.
 * - `too-large`: an upload over the workspace's per-file limit.
 * - `rate-limited`: `dispatch` to a member of a chat over the server's limit (30 a minute per person and App); later ones go through.
 * - `content-changed`: `files.replace(…, { expectedVersion })` on a file replaced since that version was read.
 * - `unavailable`: `readAgentHistory` on an agent that is there, whose conversation gugu has no way to read now (not open,
 *   and its engine keeps no record gugu reads) — apart from `not-found`, an agent you cannot see (#7126); and a `machine`
 *   verb (`callProgram`, the data folder) for a session on another machine that is offline, too old or did not answer.
 * - `not-installed` / `version-mismatch`: a `machine` verb for a session on another machine, where this App is not
 *   installed, or another version of it is.
 * - `name-taken` (子文件夹): a rename or a move to a name another file of that folder already has (case not counted).
 */
export const BRIDGE_ERROR_CODES = [
  'denied', 'invalid', 'failed', 'not-found', 'ambiguous', 'too-large', 'rate-limited', 'content-changed', 'unavailable',
  'name-taken', 'not-installed', 'version-mismatch',
] as const;
export type BridgeErrorCode = (typeof BRIDGE_ERROR_CODES)[number];

/**
 * What a failure says beyond its code, for an App to branch on without reading the sentence: `reason` names which refusal
 * of that code it was (`invalid` → `folder`, `live-text-file`, `expected-version`; `content-changed` → `replaced-since`
 * with the file's `name`, `now` and `expected`, `old-not-found`; `ambiguous` → `old-matches-many`), plus the numbers it is about.
 */
export type ErrorDetail = { reason: string } & Record<string, string | number>;

/**
 * A thrown error as it is carried out to the App: its code — any other is `failed` — its message, and its `detail` when it
 * has one. Pages, background pages and programs answer through this.
 */
export function bridgeFailure(error: unknown): { code: BridgeErrorCode; message: string; detail?: ErrorDetail } {
  const { code, detail } = (error ?? {}) as { code?: unknown; detail?: unknown };
  return {
    code: BRIDGE_ERROR_CODES.includes(code as BridgeErrorCode) ? (code as BridgeErrorCode) : 'failed',
    message: error instanceof Error ? error.message : String(error),
    ...(detail && typeof detail === 'object' && typeof (detail as ErrorDetail).reason === 'string' ? { detail: { ...(detail as ErrorDetail) } } : {}),
  };
}

/** `gugu.clipboard.writeText`: a copy of a whole large file still fits; a runaway loop does not. */
const CLIPBOARD_MAX_CHARS = 8 * 1024 * 1024;

type BoundedVerb = 'setTabTitle' | 'setTabBadge' | 'clipboardWriteText';

/**
 * What the host takes of a page's argument for the verbs it bounds itself — one rule for the desktop's bridge and the
 * phone's host (L11 B3): a title is at most 48 characters (a longer one pushes the tab strip apart — a way to draw over
 * the host's own chrome), a badge 8 (a number stays a number; nothing clears it), the clipboard's text a string of at
 * most CLIPBOARD_MAX_CHARS. What cannot be taken is refused `invalid`, in the words the page is told.
 */
export function pageArgument(method: 'setTabTitle' | 'clipboardWriteText', args: Record<string, unknown>): string;
export function pageArgument(method: 'setTabBadge', args: Record<string, unknown>): string | number | null;
export function pageArgument(method: BoundedVerb, args: Record<string, unknown>): string | number | null {
  const invalid = (message: string) => Object.assign(new Error(message), { code: 'invalid' as const });
  switch (method) {
    case 'setTabTitle': {
      const title = String(args.title ?? '').trim();
      if (!title) throw invalid('Title is required');
      return title.slice(0, 48);
    }
    case 'setTabBadge': {
      const raw = args.badge;
      return raw === null || raw === undefined ? null : typeof raw === 'number' ? raw : String(raw).slice(0, 8);
    }
    case 'clipboardWriteText': {
      const text = args.text;
      if (typeof text !== 'string' || text.length > CLIPBOARD_MAX_CHARS) {
        throw invalid(`clipboard.writeText takes a string of at most ${CLIPBOARD_MAX_CHARS} characters`);
      }
      return text;
    }
  }
}


export interface ExtensionBridgeRequest {
  method: string;
  args?: unknown;
}

/**
 * Failures are values, not thrown strings: an extension has to be able to tell
 * "you did not ask for this" apart from "that file is not there", and act
 * differently. `denied` is the only one that means the user said no.
 */
export type ExtensionBridgeResponse =
  | { ok: true; value: unknown }
  | {
      ok: false;
      code: BridgeErrorCode;
      message: string;
      detail?: ErrorDetail;
    };
