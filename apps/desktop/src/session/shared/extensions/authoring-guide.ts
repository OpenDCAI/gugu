import { EXTENSION_API_VERSION } from './bridge-protocol';

/**
 * 交给 agent 的「怎么写一个 tab 扩展」简报。
 *
 * 为什么要有这东西:`gugu_session` 里 app_* 那几行索引很短,一个 agent 读完并不知道
 * `window.gugu` 存在,更不知道 manifest 能声明什么。它于是只会写出一张静态 HTML ——
 * 而验收要的是「高定制化能体现我们的简单可扩展」。缺的从来不是能力,是知识。
 *
 * ⚠️ 这份是**手写的散文**,不是从常量生成的:生成出来的清单能保证不漂,却讲不清
 * 「这个动词什么时候该用、代价是什么」,而那正是 agent 需要的部分。
 * ⇒ window.gugu 的每个动词、每条能力、app_* 每个工具都得在这里、写在对的「Needs」下 ——
 * 由 tests/unit/desktop/mcp/guguGuide6614.test.ts 对着源码判。
 *
 * 分成几篇,每篇不超过 GUIDE_TOPIC_BYTE_BUDGET(gugu-guide-tool.ts):Codex 把超长的工具输出按字节截掉
 * 中段,一整篇写在一起时 Codex 会话读到的是掐头去尾的两半(#6615 W-22)。
 *
 * 用英文:同目录的工具描述都是英文,而这份是同一个面上的东西。它不进任何人眼里的
 * 界面,所以不走 i18n。Refs #2374
 *
 * 集体记忆对账(L11 复核 61)第 6、7 条:
 * - App 进群只有一条路:`app_install` 带 `chat_id` 和 data —— 只有它顺带建数据文件、先检查再发卡(F15 / F40,
 *   acp-engine-utils 的 chat_id 那段)。`app_pack` 只在「只分享、不装」时出场(owner-no-compat-multi-paths、真源原则 12)。
 * - 从文件夹装过的重装、新版没多声明什么就直接替换不问(D-17,`installPlan` 的 asks);❌ 只写「声明了就等人点头」——
 *   迭代时 agent 会每次重装都去请人点同意。
 *   `apps` 这篇贴着字节上限(guguGuide6614):补的这半句,由第 5 步删掉的「Installing and testing your own App never
 *   needs it」抵掉 —— 开头那段已经说清装和进群各走哪条。
 * 第 4 条:`listAgents` 的 transport 和 `dispatch` 的 `spawn` / `session_spawn` 同一套词 `acp` / `pty`(真源原则 12),
 *   所以「照着一个 agent 起一个」能把 transport 原样传回去。
 */
export const EXTENSION_GUIDE_START = `# Making a gugu App — start here

An App is something people open and use at once — in a chat's side panel or in a session: a
vote, labeling, a form, a board, a small game. When people have many things to act on or work on
together, an App beats asking them one by one in chat. In a session its data can be a file of
the working copy: claim it by name (\`TODO.md\`); opening it gives you that file.
Installing puts it on your owner's computer; given a chat's \`chat_id\` and data, it also goes in as a
card — the others install it from that card, or when they open one of its files.

It is a folder: \`manifest.json\` plus its files. HTML tabs open in tasks or, with \`opensFiles.chat\`,
in chats. Tools-only Apps need no HTML: \`apps-settings\` explains their host settings page.

More \`guide_read\` topics:
- \`apps-page\` — the \`window.gugu\` API your page calls: the same wherever it is, and what each host has.
- \`apps-agents\` — what the app is showing, and seeing and driving the person's agents.
- \`apps-programs\` — your own tools for agents (MCP programs, skills), called from your page too.
- \`apps-files\` — \`gugu.files\`: a chat's files and a session's working copy, edited live together.
- \`apps-editors\` — an editor (a textarea, CodeMirror), keeping others' letters.
- \`apps-together\` — several people in one App at once: presence, a game loop, secrets.
- \`apps-messages\` — your chats, who is in them, their messages.

## manifest.json

\`\`\`json
{
  "id": "csv-lens",              // [a-z0-9-]+; no dots
  "name": "CSV Lens",
  "version": "1.0.0",            // x.y.z, digits only
  "apiVersion": ${EXTENSION_API_VERSION},
  "platforms": ["desktop"],       // desktop, phone, or both
  "entry": "main.html",          // bundle-relative, no "..", no leading "/"
  "background": { "entry": "background.html" },  // optional, see below
  "permissions": {
    "capabilities": ["files:read"],
    "network": ["api.example.com"]
  },
  "contributes": {
    "tabs": [
      {
        "name": "main",          // stable machine name, lowercase
        "title": "CSV",          // <= 48 chars
        "opensFiles": { "session": [".csv"] },  // claim: a session's .csv opens THIS tab
        "fileIcons": { ".csv": "csv.png" },  // icon per claim (else generic)
        "menu":    [{ "id": "reload",  "title": "Reload" }],   // <= 8
        "toolbar": [{ "id": "export",  "title": "Export" }]    // <= 6
      }
    ],
    "mcpServers": [              // optional, 1-4; needs "agents:tools"
      { "name": "rows", "command": "node", "args": ["mcp/server.js"] }
    ],
    "skills": "skills"            // optional folder of <skill>/SKILL.md; needs "agents:tools"
  }
}
\`\`\`

1-8 tabs. \`menu\` and \`toolbar\` are DECLARED, drawn by the host; picking one fires
\`onCommand\` with your id. No menu API.

\`opensFiles\` is a claim, not a takeover: the person's own choice always wins. It names the place:
\`"opensFiles": { "session": [".csv"], "chat": [".md", ".json"] }\` — you are offered only where you declared. A claim is a suffix (\`.csv\`) or a file name (\`TODO.md\`,
\`todo-*.md\`), which beats any suffix. When several Apps claim the same file, the person picks one.

A tab that claims no files is in every session page (removable) and in a chat's
side panel (its ⋯); a tab that claims files opens only for a file. A page belongs
to one place for its whole life — one session or one chat: its \`session\` / \`chat\` never change,
and another place gets a page of its own. Within its place the host keeps it alive and
moves it along — switching sessions never reloads it; \`onContextChanged\` brings what changed
there (\`chat.members\`, \`layout\` …), so repaint from that. A page no one is looking
at is hidden, still alive (an App keeps its 3 most recent).
It is made when something first opens your App there, not at install.
Opened FOR A FILE (a session file you claimed, a chat file opened with your App), it is a new page
bound to that file before your first call is answered — its context's \`file\` is that file for good
— and gone when the person leaves it.

\`background\` is for work that must go on even with your page hidden or when the user
never opens it: a hidden page the host starts when the App is enabled. There is
exactly one per App; the tab page talks to it (\`sendToBackground\` /
\`broadcastToViews\` in \`apps-page\`). It lives in the same sandbox with the same permissions.

## Permissions: you may write them, you may not approve them

Capabilities are consented to and revoked one at a time. The full set:
\`files:read[:all-machines]\`, \`files:write\`, \`chat:relay\`, \`chat:read\`, the three agent tiers
(\`apps-agents\`) — \`agents:read\`, \`agents:history\`, \`agents:control\`, each with optional
widenings — plus \`agents:tools\` (your MCP programs and skills are given to the
agents on this computer) and \`notifications\` (system banners).
\`files:write\` does NOT imply \`files:read\` — ask for both if you need both.
\`network\` is a list of bare hostnames (a leading \`*.\` is allowed).

You can AUTHOR a bundle that declares any of these, and \`app_install\` it. A bundle
that declares nothing installs immediately, and so does your own reinstalled declaring nothing
new. Otherwise it is shown to the person you are working with, and nothing is installed until
they confirm — they are the one who bears the consequence. Declining or letting it time out
leaves it uninstalled.

So: if the tab genuinely needs to read the working copy, declare it and tell the person
why. Do not contort the design to avoid asking.

## The sandbox — these are not guidelines, they are walls

Your page runs on its own origin (\`gugu-ext://<id>/\`) with no Node, no \`require\`, no Electron
IPC, no nested webview, no new windows, no File System Access API, and no reach into the host's
DOM or any other tab.

- \`script-src 'self'\`: NO CDN, NO remote fonts, NO remote images — ship everything inside the
  bundle. Inline \`<script>\` is blocked too: put scripts in .js files beside the page
  (\`<script src="main.js">\`).
- No \`unsafe-eval\`: \`eval\`, \`new Function\` and string-to-code paths do not run.
- Network is https/wss ONLY, and only to hosts you declared. \`http:\` is refused even for a
  declared host. localhost, \`*.local\`, \`*.internal\` and any IP literal are refused outright.
- A restart, an upgrade of your App or a revoked permission loads your entry URL from the top
  again. Keep real data in files, not in the page.

## Look — \`guide_read apps-ui\`

Every page has gugu's look, light and dark:
1. Semantic HTML (\`ul.list\` rows) is styled already.
2. No fonts, sizes, colours or radii of your own; drawing, only \`--em-*\`.
3. Icons \`<gugu-icon>\`, people \`<gugu-avatar>\`.
4. \`gugu.getContext()\` first: default to the chat it is open in.

## Workflow

When one of these tools is not in your tool list, it is in \`catalog_list\`.

1. \`app_create\` — writes the bundle outside your working copy (\`target_dir\` to choose a folder):
   \`manifest\` is manifest.json above minus id, name and version (its own parameters); \`files\` is
   every other file, path → text — a tab's page is \`<name>.html\` unless its \`entry\` says otherwise.
   A chat App for several people: \`template: "group-json"\` and your app.js; \`manifest\` adds to it. One
   person's, with a save: no template — a page of its own and \`readData\` (guide apps-programs).
2. \`app_install\` — installs it. If the bundle declares anything the person decides, so tell
   them what it asks for and why. Its tools are in \`catalog_list\` at once, in this session too.
3. \`app_check\` — runs a tab (\`tab_kind\`; a chat App: on a file, \`item_id\`) as a hidden page and
   reads back whether it loaded, its errors (a \`hint\` is advice), console, a snapshot and
   pictures. After every install: fix, reinstall and check until \`ok\` and it looks right; only then
   tell the person it is done.
4. \`app_search\` — what is installed now.
5. \`app_pack\` — only to share it without installing it: with \`chat_id\` it goes into that chat as a
   card the others install from.
`;

export const EXTENSION_GUIDE_PAGE = `# window.gugu — the API your page calls

## Where your page runs

Location fills context, never changes authority: a task has \`session\`, a chat panel has \`chat\`, a file page has \`file\`;
the dock/background have neither chat nor session. Read context before drawing.
- \`gugu.files\`: open, list, create, rename, remove — the one way to open and edit a session's file. Name its target (\`apps-files\`).
- \`setTabTitle\` / \`setTabBadge\`: your tab/panel. \`reportError\`: there and in the App error log, read by \`app_check\`.
- \`openBrowserTab\`: a browser tab in a session; the system browser elsewhere (a phone: a new window).
- What a host cannot do is not on its \`gugu\` (\`typeof gugu.x\`): the background page and a program have no tab
  or gesture (no \`setTabTitle\`, \`dispatch\` without \`to\`, \`clipboard\`, picker); a phone has no background page, \`notify\`,
  programs (a session's tab calls its computer's), agents or working copies — no cookies: \`localStorage\` / IndexedDB or \`writeData\`.
- \`gugu.clipboard.writeText\`: click/key only, including your \`menu\` / \`toolbar\` entries (\`onCommand\`), drawn on the tab/panel header.
- Chat panels open at 520 px: design narrow first, widen with a media/container query.
- No \`alert\` / \`confirm\` / \`prompt\`: use \`gugu.modal\` below.

## Custom modals (apiVersion 11)

\`await gugu.modal.open({ entry: 'new.html', title: 'New card', size: 'md', data })\` opens your bundle's HTML in
gugu's window-level dialog (phone: fullscreen). Sizes: xs/sm/md/lg/xl. No new consent.
The page stays sandboxed with the opener's context/grants; \`(await gugu.getContext()).modal.data\` holds \`data\`.
Save, then \`gugu.modal.close(result)\`: the opener receives the result; cancellation returns null.
The host handles Escape, Tab traversal, Back and focus restoration.

Free:

- \`getContext()\` → \`{ apiVersion, tabId?, chat?, session?, file?, modal?, operator, locale, themeMode, capabilities, layout? }\`.
  \`chat\`: \`{ id, name, kind: 'group' | 'dm', groupId, members }\` (\`groupId\`: the group; null in a private
  chat). Topics open Apps in their source chat's shared panel. \`members\`: \`{ id: 'user:<uuid>', name, kind: 'human' | 'agent', avatar? }\`, current through
  \`onContextChanged\`; \`avatar\`: their face, a \`data:\` image for \`<img src>\`. Pick people and agents from it;
  never copy it into a file. \`session\`: \`{ id, agentId?, projectId?, root?, deviceId?, deviceLabel? }\` — its agent
  (\`user:<uuid>\`), project, working copy's path (with \`files:*\`); \`deviceId\`: on another computer (no \`root\`). \`file\`: what this page was opened for — \`files.open(ctx.file)\`.
  \`operator\`: who works the page — \`{ kind: 'person' }\` or \`{ kind: 'agent', id }\`.
  \`capabilities\` is what you may do RIGHT NOW, after any revocation — not what you asked for.
- \`onContextChanged(fn)\` → theme, language, visibility, size and members changes. Returns an unsubscribe.
- \`onCommand(fn)\` → the person picked one of your declared menu/toolbar entries; you get your own id back.
- What the whole app shows (panes, which session): \`apps-agents\`.
- \`setTabTitle(title)\` → page title (max 48). File tabs show the file name; this title is a hint/tooltip. Host Back closes the file tab; in-page Back keeps it.
- \`setTabBadge(badge)\` → a count (99+ at most, <=0 none), a string (a dot), or \`null\` (none).
- \`openBrowserTab(url)\` → http(s) only.
- \`reportError(message)\` → shown to the person. Never fail silently.
- \`sendToBackground(message)\` → your background page (none: rejects); host stamps \`from\`.
- \`onBackgroundMessage(fn)\` → paint the background's broadcasts.
- \`broadcastToViews(message)\` → background → live views, resolves \`{ delivered }\` (0 is normal).
- \`onViewMessage(fn)\` → background hears \`(message, from)\`; \`from\`: host-stamped sender context.

Handing something to someone (\`apiVersion\` 15):

- \`dispatch(text, { to?, draft?, refs?, images?, visible?, delivery?, key?, spawn?, offer? })\` → \`{ to, id?, deferred? }\` |
  \`{ cancelled: true }\`. \`to\`: \`{ chat, member }\` (a whisper as the operator; \`visible: true\`: the chat sees it),
  \`{ agent }\` (as \`session_message\`; \`delivery: 'queue' | 'defer'\`, \`key\` replaces your waiting one), \`{ new: true }\`
  (\`spawn\`: \`session_spawn\`'s words; answers \`{ to: { agent } }\`). \`draft: true\`: only into \`{ chat }\`'s / \`{ agent }\`'s
  composer (or \`refs\`' chat; \`images: [blob]\` a chat's) — they send it, or not.
- No \`to\` (a click or key): gugu's sheet shows the text (theirs to edit), the pills and whom — the chat's agents and people,
  their own agents, a new agent (\`offer\`: \`chat\` \`agent-in-chat\` \`person-in-chat\` \`my-agent\` \`new-agent\`); their press is the
  consent, no capability. Never a picker of your own.
- Naming \`to\` sends at once: \`{ chat, member }\` needs \`chat:relay\`, \`{ agent }\` / \`{ new }\` \`agents:control\`
  (\`apps-agents\`); a program or background page must name it. Tell only whom it concerns; keep state in the file.
  Phones reach computers' agents too (see \`apps-agents\`).
  Refused: \`not-found\` (left, yourself, absent), \`failed\` (computer unread), \`denied\`, \`rate-limited\`
  (30/minute to a chat), \`invalid\`. Agents following changes: a tool (\`apps-programs\`), gugu stamps its caller.

Free, from a click or key (they read and write no data):

- \`showMessage(id)\` → its chat comes up, scrolled to it (a file's \`sourceMessageIds\`). \`not-found\`: not in its chat.
- \`showSession(id)\` → that session comes up, as a click on it in the task list (\`ctx.session.id\`, a tool's
  \`call.session\`). \`not-found\`: not in that list. \`{ peek: true }\`: beside your page, left as it is.
- \`refs: [{ file, at?, label?, version? }]\`: pills to places in one chat's files, "file · \`label\`": \`file\` its
  entry or \`ctx.file\`; \`at\` where (\`{ slide: 3, shape: 12 }\`), back as the \`onLink\` \`query\`
  of the App a click opens it in; \`version\` picked on (else the entry's). Only with refs may \`text\` be empty.

Needs \`notifications\`:

- \`notify({ title, body?, tag?, data?, open? })\` → a system banner, shown under your
  App's name. Obeys the person's notification settings: when those are off this
  REJECTS rather than pretending. At most 10 a minute — reuse a \`tag\` to update one banner.
  \`open\` is what a click opens: \`{ session, tab? }\` (your tab there), \`{ chat }\` (you, in its panel), \`{ file }\`
  (where it lives); none, your own page. Back to the tab that posted: \`open: { session: ctx.session.id, tab: 'main' }\`.
- \`onNotificationClicked(fn)\` → \`{ tag?, data? }\`, your own values back. Delivered to the
  background page and to the page the click opened — even when that click is what opened it.

Free:

- \`linkTo(target)\` (API 13), desktop/phone/programs → a resource link: \`{ kind: 'chat', chat, message? }\`;
  \`{ kind: 'file', file, at?, version? }\` (file id or entry); \`{ kind: 'session', session }\`;
  \`{ kind: 'project', project }\`; \`{ kind: 'app', app?, tab?, path?, query?, chat?, session? }\`.
  App defaults: yourself, your first tab; at most one chat/session. Stored chat/file links are build-independent;
  \`external: true\` uses the build scheme for OS invocation (email/browser), as App/session/project links do. Never spell schemes.
- \`openLink(url)\` (API 13), desktop/phone → opens the resource, no capability. Page click/key required (including native \`<a>\` and \`gugu.markdown\`);
  programs/background pages only generate links.
- \`onLink(fn)\` → \`{ tab, path, query, file }\`: that link, a pill to your file (\`refs\`; \`file\`: id) or (API 7)
  a task chat's \`path#k=v\` link (\`file\`: path), also if it opens your page; phones too.

## Every one of these can reject — let it show

Show rejections inline, disable the control with its reason, or call \`reportError\`.
❌ Bare \`.catch(() => {})\` hides failures as empty states; intentional ignores need a comment explaining why.

❌ Top-level \`const gugu = window.gugu\` redeclares the host's global: SyntaxError, no script or error UI runs.
Use \`window.gugu.x\` or another name.
`;

export const EXTENSION_GUIDE_AGENTS = `# Seeing and driving agents from your page

These \`window.gugu\` verbs reach this computer's agents; \`:all-machines\` read and control also reach the person's
other computers (history never leaves this one). Each tier is its own capability,
consented to on its own; the rest of the API is in \`apps-page\`. Phones have getAppState, its change event, listAgents, onAgentsChanged and dispatch (below). Where your page is
plays no part: the plain words reach the agents you started, \`:all\` every one here. Work that watches agents
with no page open — a clock — goes in the background page.

Free — what the app is showing:

- \`getAppState()\` → what the APP is showing, as opposed to where you sit:
  \`{ windowFocused, activeSessionId, activeProjectId, panes: [{ paneId, focused, activeTab: { tabId, kind, agentId?, filePath? } | null }] }\`.
  \`activeProjectId\`: the project, ungated — ❌ not fished out of \`listAgents\` (that needs \`agents:read\`, an agent in the pane and a second call).
  **\`panes\` is a list because the workspace panel splits** — ❌ never \`panes[0]\`; walk them, \`focused\` holds the
  keyboard. \`kind\` is the host's own word, NOT a closed set (Apps register kinds too) — ignore unknown ones.
  \`agentId\` needs \`agents:read\`, \`filePath\` needs \`files:read\`; absent means "not granted", not "not that sort of tab".
  \`panes\` says what is OPEN, not painted: a zero-width pane or a collapsed panel still lists its tab. For whether YOUR OWN
  surface is on screen read \`getContext().layout.visible\`; per-pane visibility is not exposed.
  The same answer wherever your page is: when \`activeSessionId\` is not your \`context.session\`'s id the
  person is elsewhere — your cue to stop animating and stop polling.
- \`onAppStateChanged(fn)\` → that state moved: a pane switched tabs, the view split, the person
  changed session, the window gained or lost the foreground. Identical states are not re-pushed,
  so this is not a poll in disguise.

Needs \`agents:read\` (or \`agents:read:all\` / \`agents:read:all-machines\`, which cover it):

- \`listAgents()\` → every agent you may see, as \`{ agentId (user:<uuid>), sessionId, deviceId, deviceLabel, projectId, title,
  providerId, model, transport, parentAgentId, spawnedByThisExtension, status, detail, isGenerating,
  lastStopReason, failure, lastActionAt, pendingPermissionCount, queuedPromptCount, contextTokens, rateLimit,
  updatedAt }\`.
  \`detail\` refines \`status\`: \`running\` | \`parked\` (only background work); \`approval\` | \`question\` |
  \`plan\` | \`dialog\`; \`done\` (turn finished) | \`plain\` (stopped, exited); \`null\` for \`error\` or no status.
  \`failure\`: why a panel agent's engine went away by itself, \`{ kind: 'adapter-exit' | 'start-failed', message,
  exitCode, signal }\`, kept until it is started again; \`null\` while fine or stopped on purpose.
  \`lastActionAt\`: its newest tool call, however long ago (a dead engine keeps its last) — compare it with now.
  \`contextTokens\` is the context its engine last reported in use — what its next turn reads back.
  \`rateLimit\` is the account limit its engine last reported: \`{ status: 'allowed' | 'allowed_warning' |
  'rejected', resetsAt, window, utilization }\` — back off at a warning, resume after \`resetsAt\`.
- Scope is NOT an argument. \`agents:read\` answers with the agents you started
  (\`spawnedByThisExtension: true\`, each in a session of its own); \`agents:read:all\` with every
  one on the machine — the agent of your page's session (\`ctx.session.agentId\`) among them. Which one you
  get was settled when the user installed you. \`agents:read:all-machines\` adds the agents on the person's other
  online computers (\`deviceId\`/\`deviceLabel\`; \`null\` = here), live fields \`null\`; offline or too-old ones absent. Declare only ONE word of a family — two is refused by the schema.
- \`transport\` is \`'acp'\` (a chat panel) or \`'pty'\` (a terminal). **Live counters are \`null\` unless that agent is
  open right now**: \`isGenerating\`, \`pendingPermissionCount\`, \`queuedPromptCount\`, \`contextTokens\`,
  \`rateLimit\` and \`lastActionAt\` are \`null\` for every terminal agent and for any panel agent not open now. \`null\` means
  "cannot be asked", NOT zero: a "0 waiting" badge drawn from a \`null\` is a lie.
- \`pendingPermissionCount > 0\` means that agent is blocked on a human. That plus a stale
  \`updatedAt\` is the whole "who is waiting?" question, answered without reading anything.
- \`onAgentsChanged(fn)\` → these agents moved: started, stopped, began generating, finished, now
  waiting on a human. **Ids only**: call \`listAgents()\` for the details of the ones
  you care about. Ids are filtered to your declared scope, so plain
  \`agents:read\` hears only of the ones you started; only this computer's, even with \`:all-machines\`.
  A deleted agent does NOT arrive here: that channel does not exist yet.

Needs \`agents:history\` (or \`agents:history:all\`):

- \`readAgentHistory(agentId, before?)\` →
  \`{ messages: [{ messageId, sender, text, turnId, seq, startedAt }], nextCursor }\`,
  oldest turn first (newest last), capped per call. \`nextCursor\` is \`null\` once you reach the beginning;
  otherwise pass it back as \`before\` for the previous page.
- **Read from the record the agent's engine keeps** (claude, codex, opencode), as the session page shows it: terminal
  and closed agents too; other engines' agents only while open. Reading never opens an agent.
- \`error.code\`: \`not-found\` (not visible; worded as no such agent), \`unavailable\` (there, not readable now),
  \`invalid\` (a \`before\` that is no page's \`nextCursor\`).
- **\`nextCursor\` is the only end-of-conversation judge, not \`messages.length\`.** Paging is
  by turn, filtering is by message, so a page can come back empty while \`nextCursor\` is
  still set — those turns were all thinking and tool calls, nobody spoke. Keep paging until
  \`nextCursor\` is \`null\`.
- \`text\` is what was said; thinking and tool calls are deliberately left out (their shape changes for reasons
  that are not your tab's).
- Scope is its own: this capability does NOT ride on \`agents:read\`. An agent outside your
  scope is refused with the same sentence as one that does not exist, because whether it
  exists is itself something you were not granted.
- This is the person's conversation, including whatever they pasted into it. Read it because
  your tab needs it, not because you can.

Needs \`agents:control\` (or \`agents:control:all\` / \`agents:control:all-machines\`):

Phones: listAgents reads the computers' current lists (own / all-machines scope); live counters are null. Tells/drafts reach their agents. New agents use the context's computer, else the most recently online one;
the sheet lets the person change it. \`agents:control\` starts agents and tells those this App started; \`:all-machines\`
can tell any of the person's agents. A sheet pick needs no capability.

- Starting and telling an agent is \`dispatch\` (\`to: { new: true }\`, \`{ agent }\`): what \`spawn\` leaves out is what the
  person's new-session box would pick; to start one like an agent you see, pass its row's \`providerId\` (as
  \`harness\`), \`model\`, \`transport\`, \`projectId\` (as \`project\`). It stays in your scope (\`spawnedByThisExtension\`).
  \`:all-machines\` reaches your other computers too.
- \`stopAgent(agentId)\` → stops one you can see on this computer, panel or terminal. It does not undo the work
  already done.
- Starting an agent and a message to one **spend the person's quota**. There is no second prompt at
  call time: they agreed when they installed you. That is exactly why you should not loop.
- Anything you start is recorded as started by YOU, and stays marked that way even after the
  person uninstalls you.
`;

export const EXTENSION_GUIDE_PROGRAMS = `# Giving agents your own tools

Programs and skills for this computer's agents. Configuration/behavior: \`apps-settings\`; page calls: \`apps-page\`.

Needs \`agents:tools\`:

- Your tools, in plain JavaScript: \`"contributes": { "mcpServers": [{ "tools": "tools.js" }] }\`, and
  every export of \`tools.js\` is one tool. A card's followers, say:

\`\`\`js
export const follow = {
  description: 'Be told when a card on this board changes.',
  inputSchema: { type: 'object', required: ['board', 'card'], properties: {
    board: { type: 'string', format: 'gugu-file' }, card: { type: 'string' } } },
  async run({ board, card }, { agent }) {
    const f = await gugu.files.open({ id: board })
    if (!f.data.followers[card]) f.data.followers[card] = {}
    f.data.followers[card][agent] = true
    return 'following ' + card
  },
}
\`\`\`

  — and the page, when that card changes, \`gugu.dispatch\`es to each follower of it. \`agent\` is the calling
  agent's \`user:<uuid>\`, stamped by gugu: no agent can fake it, so never ask for it in an argument.
  \`session\`, \`workspaceRoot\` and \`model\` come stamped the same way: its session (a \`{ session }\` place; keep it, and a
  click takes the person there with \`showSession\`), that working copy's absolute path, and the model gugu runs it on,
  as \`listAgents\` gives it (not one switched in its own terminal); each absent when there is none.
  What run returns is the answer (a string as it is, anything else as JSON); what it throws, the
  error the agent reads. An export that is not a tool stops the file with an error naming it: keep
  helpers unexported, or in another module \`tools.js\` imports. It may import your bundle's files
  and Node's built-ins (no \`node_modules\`).
- Your tools run only on the computers the App is installed on, with that person's full rights.
  Another person's agent has them once its owner installs the card too —
  ask them to; never have agents write their ids into your data.
- Another language, or an existing MCP server: \`{ "name", "command", "args"? }\`, MCP over stdio.
  \`command\` \`node\` runs on gugu's own runtime; \`./x\` is a program in your bundle; anything else
  is found on PATH (\`npx\`, \`uvx\`, \`python3\`). An argument naming a file in your bundle is passed
  as its absolute path; the install sheet shows the command verbatim. Answer every request with its
  \`id\`, errors too: an error reply without one fails every call in flight. Each call's \`_meta\`
  carries the same stamp: \`"gugu/agent"\`, \`"gugu/sessionId"\`, \`"gugu/workspaceRoot"\`, \`"gugu/model"\`. A long tool reports progress on the
  call's \`progressToken\` at least every 60 seconds, or Claude aborts it at 300 seconds.
- Either way the working directory is your bundle, with \`GUGU_EXTENSION_ID\` and
  \`GUGU_EXTENSION_DATA_DIR\` — the folder your pages reach with \`readData\`/\`writeData\`. One copy
  serves every session; gugu starts it on first use and stops it when idle (never while it holds a chat file open).
  A program on \`node\` has the global \`gugu\` — a page's, but for the page's own verbs; a \`worker_threads\`
  worker has none (relay through the main thread yourself). It opens a chat file it
  is handed by its id, \`{ id }\`, and \`gugu.dispatch(text, { to: { chat, member }, refs })\` whispers in that file's chat.
  A file it makes goes in with \`gugu.files.upload(place, file)\` (\`files:write\`) — into the chat of a file an agent
  handed it, as that agent, judged by the agent's membership; a stored file it is handed
  gets its next version with \`gugu.files.replace(file, blob, { expectedVersion: entry.version })\` (needed;
  \`content-changed\` if another write came first) — the agent's write, its old version kept
  (\`gugu.files.versions(file)\` lists them, \`gugu.files.readVersion(file, n)\` reads one).
- A parameter \`{ "type": "string", "format": "gugu-file" }\` is a chat file the agent hands you:
  gugu checks the agent can open it, and for that call your program opens it with no capability, as that
  agent — even in a chat the person is not in — and what the program writes is the agent's. No
  presence, and nothing that needs a person's click.
- A parameter \`{ "type": "string", "format": "gugu-chat" }\` is a chat the agent hands you — its id, or the
  number people see (you get the id). gugu checks the agent is in it; for that call what your program lists,
  makes, uploads, renames and removes there is the agent's, by its membership (\`files:read\` / \`:write\` still).
  There, name a file by its entry or \`{ chat, id }\`: a bare \`{ id }\` not handed itself is \`denied\`.
  \`format\` counts on a tool's own parameters (or a string array's items), never inside an object.
  A verb a call's own code makes is its agent's, even with two agents' calls on one file or chat. When the call
  ends, what it opened as the agent closes once that agent has no other call running. Any other chat or file is
  \`denied\` in a call, and after it ends (a timer it set) — never the person's. Made in no call (\`onChanged\`, a timer
  set before): the person's, by \`files:*\`. Await what must be the agent's. A batched write is its call's.
- Doing to a file what an agent does: a JSON file's \`f.text\` is what the agent reads (indented two spaces), and
  \`f.edit(old, new)\` changes it as a text file's does (it must stay an object). \`files.create\` and
  \`files.upload\` take \`{ sourceMessageIds }\`: the messages the file came from. Codex keeps about 12 KB of an answer:
  keep each under 8 KB, page the rest.
- \`contributes.skills\`: a folder of Agent Skills (\`<skill>/SKILL.md\`), given to the agents your
  tools are given to. A session that opens with you there has them from its start (Claude Code and Codex
  list them as skills, other agents get a line naming each SKILL.md); one that opened before
  you were installed finds them in \`catalog_list\`.
- Agents reach your tools through the catalog (\`catalog_list\` / \`catalog_call\`), named
  \`<App id>__<tool>\` whichever program gives it, in every session the moment you are installed; the person can have them
  listed natively instead, from the next session on. \`contributes.toolsListed: true\` asks for that at the first install
  (the person can switch it back). The person can switch \`agents:tools\` off without uninstalling you; running
  sessions' calls are refused from then on.

Free — your own programs and data folder:

- \`callProgram(tool, args?, server?)\` → calls a tool of your own MCP program and resolves its
  result (\`{ content, structuredContent?, isError? }\`). Only tools whose \`_meta.ui.visibility\`
  includes \`"app"\` (MCP Apps; absent: both): mark agent-only tools
  \`["model"]\`, and page-only ones \`["app"]\` — agents never see those. \`server\` only when you
  run several. Stamped \`"gugu/caller": "app"\`, the tab's session and its working copy, and on a page an agent
  works its \`"gugu/agent"\`. Refused while \`agents:tools\` is off.
  A tab of a session on another computer (\`ctx.session.deviceId\`) runs it THERE:
  \`not-installed\`, \`version-mismatch\`, \`unavailable\` (offline, too old, or silent 75 s: it may have run);
  1 MB each way (\`too-large\`).
- \`onProgramNotification(fn)\` → \`{ server, method, params? }\`: a notification your program sent
  while running (it starts on first call, stops after 5 idle minutes). A \`tools.js\` call that answered
  sends \`tools/called\` \`{ tool }\` itself; any other program, send one after the work.
- \`readData(path)\` → string, or \`null\` when absent. \`writeData(path, content)\` (atomic). \`listData(dir)\`.
  8 MB a file (1 MB in another computer's session's tab). Your program's folder: THERE
  in such a tab, a background page's here (\`localStorage\`: only this screen's). Your program announces
  changes, not the folder. Removed when you are uninstalled.
  A save needs no file; say one that fails:

\`\`\`js
let state = JSON.parse((await gugu.readData('save.json')) ?? 'null') ?? { score: 0 }
const save = () => gugu.writeData('save.json', JSON.stringify(state))
  .catch((e) => gugu.reportError(\`Could not save: \${e.message}\`))
\`\`\`
`;

/**
 * `gugu.files` — the platform runtime's shared files (L3; notes/2026-09-29-app-platform/workspace-app/
 * L3-runtime-interface.md). The page an agent reads before writing a vote, a game or an editor.
 */
export const EXTENSION_GUIDE_FILES = `# gugu.files — shared live files

Claim an existing data file's name or suffix and open it live; never copy it into your bundle
(\`app_install\` data \`{ item_id }\`). Top-level \`await\` needs \`<script type="module">\`.

## Which files you may open

Topic file addresses resolve to their source chat; messages keep the topic's.

Each call names its file or place. A file: an entry (from \`list\`) or \`ctx.file\` as it is; by name,
\`{ chat | session | project, name }\`. A place: \`{ chat: id }\`, \`{ session: id }\` or
\`{ project: id }\` — a project's folder, as a working copy (\`gugu.projects.list()\` → \`{ projects: [{ id, name }] }\`).

- The file you were opened for (\`ctx.file\`) — the person clicked it and the host picked your App by its claim
  (\`opensFiles\`, e.g. \`{ "chat": [".vote.json"] }\`; most specific wins) or picked via "open with".
  No capability; a session's claims go under \`"session"\`.
- \`"chatFile": "x.board.json"\` on it (API 14): opened in a chat, \`ctx.file\` is that top-level file, \`{}\` at first: fill it.
- A name claims that one file (\`"session": ["TODO.md"]\`); a suffix is for a format of your own. Keep what your App
  does not understand as is. Changing course, remove the topics and files you made, or ask. A session file
  in a folder the search index skips hears the disk only when written.
- Any other file (a chat you are in, a folder here): \`files:write\`, or \`files:read\` (read-only).
- A session on another of your machines (\`files:read:all-machines\`): open/download only.
- \`gugu.files.list(place)\` needs \`files:read\`; \`gugu.files.create({ ...place, name }, content)\`,
  \`gugu.files.rename(entry, name)\` and \`gugu.files.remove(entry)\` need \`files:write\`. JSON content: an object at the top.
- \`gugu.files.search({ query, suffixes, limit })\` (\`files:read\`): all the reader's chats' files by part of the
  path, with \`chatName\`; \`gugu.files.recent({ limit })\`: those this person opened last (\`openedAt\`).
- A chat's subfolders: \`gugu.files.list({ chat, folder })\` lists one (path or id, \`''\` the top; none: all;
  \`'folder'\` entries are listed, never opened);
  create and upload take \`folder\` too (made if missing); \`gugu.files.mkdir({ chat, path })\`,
  \`gugu.files.move(entry, { folder, name })\`; remove takes a folder with all in it. A name the folder has (any case):
  a new file gets \` (2)\`, a rename or move is \`name-taken\`. 「附件」 (\`systemRole\`) stays put.
- \`gugu.files.onChanged(place, fn)\` → unsubscribe. Chat: \`{ kind: 'entries', entries, gone }\`. A folder here: \`{ kind: 'changes', changes }\` or \`resync\` (list again).
- \`gugu.files.openWith(entry)\` (a click or key) uses the most specific claim or "always use". \`{ ask: true }\`: they pick among all;
  \`{ at }\`: a place, the opener's \`link\`. No App claims it: gugu's file preview, or details and download.
  \`{ peek: true }\`: beside your page; always for project files. \`not-found\`: gone or unreadable.
- \`gugu.files.upload(place)\` (\`files:write\`) opens the file picker (a click or key) → the new entries (\`[]\`);
  given a File, uploads it. Over 25 MB: \`too-large\`. \`gugu.files.download(entry)\` asks where to save (a click or
  key) → \`true\` saved.
- An image, a clip, a sound opens read-only: \`URL.createObjectURL(await f.blob())\`; \`files.replace(entry,
  blob, { expectedVersion: entry.version })\` makes its next version (needed; else \`content-changed\`).
  \`files.versions(entry)\` / \`files.readVersion(entry, n)\`: its history.
- Entry: \`{id,chat|session|project,name,contentType,type,parentId,path,systemRole,size,version,
  createdAt,updatedAt,createdBy,updatedBy,sourceMessageIds,canDelete}\`.
  Both authors: \`{id,name,kind:human|agent|system}\`; unknown/local editor is null.

## A text file (markdown)

Its handle — \`f.text\`, \`f.edit(old, new)\`, anchors — and an editor bound to it: \`apps-editors\`.

## A JSON file

Design the data first. The file keeps every write, so what changes every frame — a cursor, a drag, a
stroke being drawn — goes in \`f.presence\` (\`apps-together\`); the file gets events and results.
The file is data only: what agents should do with it goes in your tools (\`apps-programs\`), never a note in it;
its own id is \`f.entry.id\`. A new version that changes that shape reads the old one too, writes the new, and
raises \`version\`.

\`f.data\` is a live object: read and write it as any object, spread included. An object assigned
over one merges key by key — the keys you list, all the way down; the keys you saw and left out go —
and \`= {}\` clears the keys you see: what others add meanwhile stays. Two writing the same plain
value: the later wins. What many people add to is a map keyed by id, sorted when shown: a vote
\`f.data.votes[me] = i\`; a form \`f.data.answers[me] = { … }\`; a board
\`f.data.cards[crypto.randomUUID()] = { title, column }\` (a move writes \`column\`).
\`f.toJSON()\` is a plain copy; ❌ cloning \`f.data\` (\`structuredClone\` throws). Mid-drag
others, an agent or git may change the file: drop by id (or content), never by the index it began at.
Group a frame's writes with \`f.transact(() => { … })\`.

Text people type in together (a title, a note, a slide's body) is created as \`gugu.text('')\` —
\`f.data.slides[id] = { title: gugu.text('') }\`; in data an agent writes \`{"$text": ""}\`. It reads as a
string, and a string assigned to it merges letter by letter. To type in it: \`f.textAt(['slides', id,
'title'])\` is a text handle, as a text file is — \`gugu.bind.text(input, f.textAt([…]))\`. A field made
as a plain string is one value: the later write wins, and \`textAt\` refuses it.
Key per-person data by \`f.presence.self.userId\` (\`user:<uuid>\`, server-stamped; \`self.name\`: their
name) — ❌ never ask the person who they are. ❌ No locks or "being edited by" fields of your own (they lock
people out and still lose letters): show who edits what with presence.

\`\`\`js
const f = await gugu.files.open((await gugu.getContext()).file)   // { question, options, votes: {} }
const me = f.presence.self.userId
const render = () => {
  title.textContent = f.data.question
  list.replaceChildren(...f.data.options.map((o, i) => {
    const b = document.createElement('button')
    b.textContent = \`\${o} · \${Object.values(f.data.votes).filter((v) => v === i).length}\`
    b.onclick = () => { f.data.votes[me] = i }
    return b
  }))
}
f.onChange(render); render()
\`\`\`

Text others wrote goes in with \`textContent\` or the template's \`render\` with html\`…\` (it escapes every \${…}),
never joined into \`innerHTML\` — markup in a title could draw a fake button. On a change, redraw with \`render\`: it
patches by \`data-key\`; an input showing the file's value goes in it, and the one someone is in stays as it is (focus,
half-typed text, IME). A draft not yet submitted, and \`gugu.bind.text\` boxes, go outside it (\`#controls\`, drawn
once) — \`render\` gives an unfocused input its markup's value again. ❌ \`innerHTML\` or \`replaceChildren\` on a
change: the input goes, and its half value lands in the file as a change. To point at
another file, store its entry's \`id\` and open it on click with \`gugu.files.openWith(entry)\`; a name alone is text nobody can open.

## When things go wrong

\`f.status\` is \`online\`, \`offline\` (keep editing: it is sent when back; also after 10 s without an answer —
it reconnects itself) or \`gone\` (deleted, you left the chat, a permission taken back: say so and grey it out; a
session's file put back on disk comes back \`online\`). \`f.onStatus(fn)\` fires when it or \`f.saved\` moves. Each
\`gugu.files.open(…)\` is its own handle; \`f.close()\` lets it and its handlers go.
\`f.onRefused(({ reason }) => …)\`: \`too-large\` — your change was undone, tell the person;
\`rate-limited\` — it will retry by itself. \`f.saved\` is true once the server has everything.
Every failure is an Error with a \`code\`: \`denied\`, \`not-found\`, \`ambiguous\`, \`read-only\`,
\`content-changed\`, \`name-taken\`, \`invalid\`, \`failed\`; \`file-unavailable\` when \`gugu.files.open\` had no answer in 10 s.
`;

/**
 * 摩擦单 F59(L7-r,S12):「一句话写一个编辑器」的 agent 把整页序列化回 markdown、再和 f.text 做前后缀 diff 写回 ——
 * A 组字期间 B 在别处打的字被当成 A 删的,三边一致地丢了。第二轮 agent 自己用上了 snapshot / applyFrom,仍丢字:
 * 「底要等于画上去的那份」「有未提交输入或组字时不重画」「光标用 anchor 跨过重画」这三条让每个 App 自己记,总有人漏。
 * 所以首推 gugu.bind.text(L3 f7df1b923,把这些都收进绑定):textarea 一行,自己画的视图给四样东西;
 * snapshot / applyFrom 降为自己全权管理视图时的底层用法。
 */
export const EXTENSION_GUIDE_EDITORS = `# Your own editor on a textarea or contenteditable

## A text file's handle

\`f.text\` is the whole text. Change it with \`f.insert(i, s)\`, \`f.delete(i, n)\`, or
\`f.edit(old, new)\` (the unique \`old\` is replaced; else \`content-changed\` / \`ambiguous\`).
\`f.onChange(({ local, delta }) => …)\` gives each change as retain / insert / delete. A caret that must
follow the text is an anchor: \`const a = f.anchor(i)\`, later \`f.resolve(a)\` (null once the file was
rebuilt). Don't diff against \`f.text\` in a view you draw yourself: bind it (below).
No copy menu on a phone: give a selection a Copy button calling \`gugu.clipboard.writeText(text)\` on click.

For a text file (\`apps-files\`). Several people type in the same file at once: bind the editor, and
everyone's letters stay, the caret stays on the letter it was at, and an IME composition stays whole. A
\`<textarea>\` or \`<input>\` is one line:

\`\`\`js
const f = await gugu.files.open((await gugu.getContext()).file)
const unbind = gugu.bind.text(document.querySelector('textarea'), f)   // unbind(): what is typed lands, then it lets go
\`\`\`

A view you draw yourself (a contenteditable, markdown rendered and edited in place) is the same call, given
four things:

\`\`\`js
gugu.bind.text({
  element: pad,                                  // where the person types
  read: () => toMarkdown(pad),                   // the whole text as it shows now
  render: (text, sel) => {                       // draw it (others wrote it: escape it), then the caret
    pad.replaceChildren(...toNodes(text))
    if (sel) placeCaret(pad, sel)
  },
  selection: () => caretOffsets(pad),            // { anchor, head } in the text, or null
}, f)
\`\`\`

The one thing your App must keep: once \`render\` has drawn \`t\`, \`read\` gives back exactly \`t\` — \`*x*\` stays
\`*x*\`, never \`_x_\`. Whatever your serializer rewrites is a change you make to someone else's writing (the
runtime notes it once in your App's error record). A read-only file: a textarea turns read-only, and what is
typed into your own view is taken back.

With CodeMirror it is one line too:

\`\`\`js
const f = await gugu.files.open((await gugu.getContext()).file)
const { EditorView, basicSetup, markdown } = await gugu.codemirror()
const view = new EditorView({ parent: document.body, extensions: [basicSetup, markdown()] })
gugu.bind.codemirror(view, f)   // content, others' cursors, undo of your own typing only
\`\`\`

Bind only an EditorView from \`gugu.codemirror()\` (it also has \`markdownLanguage\` for GFM, \`json\`,
\`keymap\`, \`minimalSetup\`). Another CodeMirror copy cannot be bound; ship none. For your own plugin or
decoration it hands CodeMirror's modules whole — \`view\` (\`Decoration\`, \`ViewPlugin\`, \`MatchDecorator\` …),
\`state\`, \`language\`, \`commands\`, \`search\`, \`autocomplete\`, \`lint\`, \`langMarkdown\`, \`langJson\`,
\`lezerCommon\`, \`lezerHighlight\`, \`lezerMarkdown\`: the very copies the binding uses, so what you build on them
works on a bound editor. \`const { view: { ViewPlugin, Decoration } } = await gugu.codemirror()\`. To style by
syntax rather than a pattern (bold, headings, links): a \`language.HighlightStyle\` over \`lezerHighlight.tags\`
(e.g. \`tags.strong\` in bold), given to \`language.syntaxHighlighting\`.

Beneath it, for a view you manage entirely yourself: \`const s = f.snapshot()\` when you read,
\`f.applyFrom(s, next)\` when you write — only what you changed lands, what others typed since stays.
Text files only (a JSON file is changed key by key). ❌ Never diff \`next\` against \`f.text\`: by then it
holds others' letters, and your diff deletes them.
`;

export const EXTENSION_GUIDE_TOGETHER = `# Several people in one App at once — presence, games, secrets

The file itself is in \`apps-files\`. Ids of people and agents (\`f.presence.self.userId\`,
\`others[].userId\`, an entry's \`createdBy.id\`) are \`user:<uuid>\`, the same as in MCP.

## Presence

\`f.presence.set(state)\` shares something short-lived — a cursor, a selection, a game frame.
It is never saved; the latest one always arrives. \`f.presence.others\` is everyone
else with the file open (\`{ id, userId, name, color, state }\`), \`f.presence.onChange(fn)\` fires
when it moves. Colour people with \`color\` — \`f.presence.self.color\` for yourself: it is the colour
everyone else sees you in, \`''\` for the moment until the server has said who you are (draw a default).
A real-time game: every page moves its own player in its own presence and runs the rest locally; the
file keeps only what lasts — scores, the food, who won. ❌ No clock in the file (\`game.tick\`, \`speed\`)
and ❌ no host page stepping the game for everyone: that writes the file every tick, and the game
stops when the host leaves. A snake: your own snake in presence, the food and scores in the file.

\`\`\`js
setInterval(() => {
  step(body)                                   // your game logic, on your own page
  if (ate(body, f.data.food)) f.transact(() => { f.data.food = randomCell(); f.data.scores[me] = (f.data.scores[me] ?? 0) + 1 })
  f.presence.set({ body })                     // every tick; the file only when something lasts
  draw([{ body, color: f.presence.self.color }, ...f.presence.others.map((p) => ({ body: p.state?.body, color: p.color }))], f.data)
}, 140)
\`\`\`

A game loop draws once per tick, as above: it already reads presence there, so do not also hang a
draw on \`f.presence.onChange\` — that paints every frame twice.

## Secrets

Everyone in the chat can read every file of its workspace — the workspace App shows the raw JSON.
Scrambling a value hides nothing. A secret stays in the page of the person who holds it: in memory,
or your App's own \`writeData\`. Pictionary: the drawer picks the word and judges guesses in
their own page; the file holds only the hint (category, length) and the result (who got it). A game
that needs a trusted judge (werewolf): the judge is an agent whose owner does not play, and it tells
each player their secret privately. Wanting a player's answer in private (a target, a check), the judge
tells them plainly to whisper it — one reaching it with \`whisper_to\` on its envelope was seen by it
alone; asked vaguely, players post it for everyone. A tie, or anything to rule on, goes by the neutral
rule announced beforehand, never by what only the judge knows (citing a seer's check takes a side).
No file is for one person's eyes only.
`;

export const EXTENSION_GUIDE_FORUM = `# gugu.forum — the forum: posts, replies, bounties

The 咕咕 forum, read and written as the person signed in (manifest \`apiVersion\` 9). Free: no capability; every
signed-in person may read it. Writing is a page's, inside the person's click. Who may see and do what is the
database's: a new account (under 3 days, or never signed in on a device) cannot post or reply; a poster's block list;
3 identities per owner in one post; 10 replies per identity per post in 10 minutes. A refusal's \`error.message\` holds
the reason word (\`account_too_new\`, \`blocked_by_poster\`, \`owner_identity_limit\`, \`rate-limited\`, \`post_closed\`,
\`bounty_insufficient_points\`, \`bounty_active_limit\`, \`bounty_award_too_early\`, \`bounty_past_grace\`,
\`bounty_award_to_self\`, \`forum_post_has_open_bounty\`, \`forum_agent_not_assigned\`): say it in your own words.

- \`gugu.forum.list({ query?, sort?, filter?, mine?, limit?, offset? })\` → \`{ me: { id, points }, posts }\`. \`sort\`
  \`active\` | \`new\` | \`amount\` | \`deadline\`; \`filter\` \`all\` | \`bounty_open\` | \`bounty_settled\`; \`mine\`
  \`posted\` | \`answered\`. A post: \`{ id, title, excerpt, author: { id, name, avatar, points }, createdAt,
  lastActivityAt, replyCount, bounty }\`; \`bounty\` null, or \`{ amount, visibility, deadlineAt, status, awards }\`.
- \`gugu.forum.read(postId)\` → \`{ seq, me, post, bounty, replies, reactions, assignments }\`: the replies this person
  can see (a poster-only bounty's answers are the poster's and each answerer's own until it settles), each \`{ id, body,
  createdAt, toPosterOnly, replyTo, author: { id, name, avatar, isAgent }, owner: { id, name, points } }\`;
  \`assignments\` the person's own agents on this post, with \`deliveryState\` (\`pending\` \`delivered\` \`undelivered\`
  \`turn_failed\`) and \`lastError\`.
- \`gugu.forum.post({ title, body, bounty? })\` → \`{ post }\`. With \`bounty: { amount (1–100), days (1|3|7),
  visibility ('public'|'poster_only') }\` the host draws the confirmation and answers \`{ confirming: true }\`; the
  new post arrives on \`gugu.forum.onChanged('feed', …)\`.
- \`gugu.forum.reply(postId, text, { replyTo? })\` → \`{ reply }\` · \`gugu.forum.react({ kind: 'post'|'reply', id, emoji, on })\`
  · \`gugu.forum.remove({ reply } | { post })\` · \`gugu.forum.block(userId, on)\`.
- \`gugu.forum.assign(postId, agentId?)\`: gugu's sheet lists the person's own agents and they pick one (\`agentId\` only
  preselects; you never list them), answering \`{ assigned: { agent } }\` or \`{ cancelled: true }\`. The agent is
  woken with the post and answers with its own \`forum_reply\`.
- \`gugu.forum.award(postId, [{ reply, amount }])\`: 1–3 answers adding up to the bounty, from 24 hours after posting
  to 24 hours after the deadline; \`[]\` ends it without accepting. The host draws the confirmation, answers
  \`{ confirming: true }\`, and the post's \`onChanged\` says \`settled\`.
- \`gugu.forum.onChanged(postId | 'feed', fn)\` → unsubscribe. the handler gets \`{ kind, seq?, entityId? }\`: what moved, never
  the thing: read again. The first one is \`{ kind: 'subscribed' }\`. ❌ Poll.

Community points move only behind the host's own sheet; an App never draws one. People and agents are \`user:<id>\`;
posts and replies their bare id.
`;

export const EXTENSION_GUIDE_MESSAGES = `# gugu.chats, gugu.messages — the chats you are in, and what was said

Which chats the reader is in and who is in one — for a page that is in no chat (an App's own tab, full screen) to
offer one — and what people and agents said in a chat: a stretch of its timeline, one thread, or the messages that
cite a file (a pill, a link) — "this passage was discussed 3 times", each a click away with \`gugu.showMessage(m.id)\`.

Needs \`chat:read\` (manifest \`apiVersion\` 6) — any chat the reader is in, and only what they can see there (the doors an agent's
\`message_conversations\`, \`message_members\` and \`message_history\` take: whispers to others and what came before
they could see it are not there). A page reads as the person, or as the agent working it. An agent's call to your
program reads as that agent: \`chats.list\` its chats, the rest only a chat it handed (\`gugu-chat\`) or a file in it
(\`gugu-file\`) — any other is \`denied\`; outside any call, as the person. A phone too.

- \`gugu.chats.list()\` → \`{ chats: [{ id, name, kind, lastMessageAt }] }\`, all of them, last spoken first: \`kind\`
  \`group\` / \`topic\` / \`dm\` (a private chat's \`name\` is the other one's), \`id\` what every \`chat\` below takes.
- \`gugu.chats.members({ chat })\` → \`{ members }\`, as \`getContext().chat.members\`: \`{ id, name, kind, avatar? }\`.

- \`gugu.messages.history({ chat, thread?, before?, limit? })\` → the timeline (\`thread\`: its first message's id, for
  that thread alone), newest first.
- \`gugu.messages.search({ chat, query } | { chat, file }, …)\` → the messages, threads too, holding \`query\` or citing
  \`file\` (an entry or its id), newest first. Same \`before\` / \`limit\`.
- Both answer \`{ messages, next }\`: pass \`next\` back as \`before\` for the older page; \`null\`, there is none.
  \`limit\` 1–100 (50). A chat the reader is not in has none.
- A message: \`{ id, seq, chat, thread, sender: { id, name }, text, contentType, createdAt, refs }\`. \`sender.id\` is
  \`user:<uuid>\`, as \`chat.members\`; \`null\` for a line gugu wrote (\`system\`: someone joined). \`text\` is as written. \`refs\` is every file link in
  it, read for you: \`{ file, version?, at? }\` — \`at\` is the place your \`refs\` named.

\`{ file }\` finds every message citing that file, anywhere in it. To count one place, keep the ones whose \`at\` is that
place — the search does not:

\`\`\`js
async function discussed(chat, file, h) {
  const found = []
  for (let before; ; ) {
    const page = await gugu.messages.search({ chat, file, before, limit: 100 })
    found.push(...page.messages.filter((m) => m.refs.some((r) => r.file === file.id && r.at?.h === h)))
    if ((before = page.next) === null) return found
  }
}
\`\`\`

Nothing is pushed: read again when your page opens or shows again (\`onContextChanged\`).
`;

export const EXTENSION_GUIDE_UI = `# How an App page looks — gugu's look is there already

Every App page gets gugu's own look before its first line: a stylesheet, all of it in \`@layer gugu\` (the lowest, so
anything you write wins — no \`!important\`), and four elements of the host. Plain semantic HTML looks like gugu, in
light and dark, in a chat's shared side panel (520 px), on a phone (412, touch sizes) and full screen. The
picture below this text is every piece, each captioned with the markup that draws it.

## Four rules

1. Write semantic HTML: it is styled already.
2. Set no fonts, font sizes, colours or corner radii. Drawing something of your own (a board, a chart): only the tokens below.
3. Icons are \`<gugu-icon name="…">\`, people are \`<gugu-avatar user="…">\` — never an emoji, an initial or a coloured box.
4. Read \`gugu.getContext()\` first: \`chat\` is the source group or private chat the page is open in, \`chat.members\` who is in it. Default to that chat; never make the person pick it.

## Elements — one line each

- \`h1\`–\`h3\` titles (a step smaller in a narrow panel), \`h5\` a section label; \`p\`, \`a\`, \`strong\`, \`small\` (times, counts), \`code\`, \`kbd\`, \`blockquote\`, \`hr\`, \`pre\`.
- \`button\`, \`button.primary\` (the one main action), \`button.danger\`, \`disabled\`. An icon alone: a \`button\` with \`aria-label="Refresh"\` and one \`<gugu-icon name="refresh">\` in it.
- \`<label>Name <input></label>\` (the label above it), \`select\`, \`textarea\`, \`input[type=search]\`; \`aria-invalid="true"\` marks a wrong one.
- \`<label><input type="checkbox"> Anonymous</label>\`, radios, a switch \`<input type="checkbox" role="switch">\`; \`fieldset\` + \`legend\` group them.
- \`<ul class="list">\` rows: \`<li><gugu-avatar user="…"></gugu-avatar><div><strong>Title</strong><span>subtitle</span></div><gugu-time datetime="…"></gugu-time></li>\`. A row is clickable as a \`button\` / \`a\` / \`label\` or with \`tabindex\`; \`aria-selected="true"\` marks the selected one. A plain \`ul\` / \`ol\` is a list in text.
- \`table\` (\`thead\`, a \`tfoot\` total), \`details\` + \`summary\`, \`progress\` (a vote's bar), \`meter\`.
- Tabs: \`div[role=tablist]\` of \`button[role=tab]\`, \`aria-selected="true"\` on the open one; \`role="status"\` a quiet note, \`role="alert"\` an error; a \`<dialog>\` (opened with its showModal) to confirm.
- Classes: \`.card\` a block, \`.row\` side by side (wraps), \`.stack\` a column, \`.muted\` secondary text, \`.primary\`, \`.danger\`. Nothing else is needed.

## The host's elements

- \`<gugu-icon name="bell">\` (\`size="md|lg"\`): gugu's icons, named as lucide names them — bell, users, search, settings, plus, x, check, pin, trash-2, chevron-right, refresh, ellipsis… \`customElements.get('gugu-icon').names\` lists them all; a wrong name comes back from \`app_check\` as a hint naming the close ones. \`label="…"\` when it alone says something.
- \`<gugu-avatar user="user:…">\` (\`size="xs|sm|md|lg"\`, \`name\` to show the name): a member of this chat, with their face; an agent's carries ⚡. Someone not in it: \`label="their name"\`.
- \`<gugu-time datetime="…">\` (ISO or ms): 刚刚 / 3 分钟前 / 08:20 / 昨天 14:20 / 10月3日, kept current, in the person's language.
- \`<gugu-empty icon="checklist"><strong>No votes yet</strong><small>Start one</small></gugu-empty>\`, with a \`button.primary\` last in it when there is something to do.

## Markdown

Text written in markdown (a file, a message, a README): render it with gugu's own renderer — the dialect, look and
link rules of every gugu surface (math, tables, task lists, footnotes, coloured code, mermaid). Ship no markdown library.
(\`gugu.codemirror()\`'s \`markdown\` is CodeMirror's language, for editing the source; \`gugu.markdown()\` draws it.)

\`\`\`js
const md = await gugu.markdown()
md.render(element, text)   // replaces what element held; call again when the text changes
md.render(element, f.text, { density: 'comfortable', frontmatter: true, file: f.entry })   // a file to read
\`\`\`

\`density\`: \`'compact'\` (the default, a chat's rhythm) or \`'comfortable'\` (a document). \`frontmatter: true\` shows a
file's leading \`---\` YAML block as code instead of reading it as text. \`sourceLines: true\` marks each block with the
lines it was written on (\`data-line="3-5"\`), to find a line's block. \`trust: 'chat'\` (the default) is for others'
words: raw HTML stays text, no image loads; \`'document'\` only for text your App wrote. Links: \`#…\` in place,
http(s) a browser tab, gugu resources through \`openLink\` (API 13, no capability), relative files beside \`file\`
through \`gugu.files.openWith\` (needs \`files:read\`). Failures call \`reportError\`. Never put others' text through \`innerHTML\`.

## Drawing your own

A canvas, a board, an editor: write your own CSS, and take the values from the tokens — they follow light and dark by
themselves. Colours: \`--em-background\`, \`--em-background-1\` (a card), \`--em-background-3\`, \`--em-foreground\`,
\`--em-foreground-muted\`, \`--em-foreground-passive\`, \`--em-border\`, \`--em-border-1\`, \`--em-accent-9\` /
\`--em-accent-contrast\` (gugu's primary is ink, not a hue), \`--em-foreground-destructive|success|warning|info\` and their
\`--em-background-*\`, \`--em-hover\` / \`--em-press\` / \`--em-selected\`. Sizes: \`--em-font-caption|body|title|heading|page\`
(11–20) with \`--em-lh-*\`, \`--em-spacing-xs\`…\`-2xl\` (4–24), \`--em-radius-control\` (8) / \`-xl\` (12), \`--em-control-h-md\`.
The page's edge is \`body\`'s margin: \`body { margin: 0 }\` and the page is yours edge to edge.

## See it, and try it

\`app_check\` sends back pictures of your page where it opens (a group's panel is 520 wide, a session's tab its
pane), and 412 wide if it goes on phones, light and dark, and \`snapshot\`: the page as its accessibility tree outlines
it, a line per control (\`- button "New vote"\`). Look at them and fix until they look right; only then tell the person
it is done.

Try it as a person would with \`steps\`: \`{"click":{"role":"button","name":"New vote"}}\`,
\`{"fill":{"role":"textbox","name":"Title"},"text":"Friday"}\`, \`{"press":"Enter"}\`, \`{"waitFor":{"text":"Friday"}}\`,
\`"look": true\` for a picture. The page stays as they left it: give the answer's \`page\` back to go on there. A step
finds a control by role and name as the snapshot says them, so:
- an icon alone has \`aria-label\` (above);
- a button on every card or row: name the card — \`<article aria-labelledby="t3"><h3 id="t3">\` — and the step says
  \`"within": {"role":"article","name":"…"}\`;
- a control you draw (an svg node): \`role="button"\`, \`aria-label\`, \`tabindex="0"\`.

## On the market card

What the card, the detail sheet and the installed list show comes from manifest.json, all optional:
- \`description\`: what it does, <= 280 chars (the card clamps at three lines). \`localized\`:
  \`{ "zh-CN": { "name": "…", "description": "…" } }\` per BCP 47 tag; everyone else reads the base ones.
- \`subtitle\`: one line under the name (<= 30 chars, also under \`localized\`); without it the market shows the
  description's first sentence. Needs \`apiVersion\` 8.
- \`icon\`: a bundle raster image (PNG), ❌ SVG — the App's own, and each tab's that names no \`icon\` of its own.
- \`author\` (<= 64, shown, not verified), \`categories\` (1-4 slugs; the market's sections are \`research\`, \`productivity\`,
  \`developer\`, anything else is 其他), \`homepage\` / \`repository\` (https links), \`license\` (an SPDX id or a short name).
- \`examples\`: 1-3 things a person might say to an agent with it (<= 80 chars each, also under \`localized\`); its market page
  lists them, a click starts a task with that sentence. Needs \`engines.gugu >= 0.2.53\`.
- Screenshots: images in README.md — the market page shows them as the preview, the rest of the README as the description.
- \`engines\`: \`{ "gugu": ">=0.2.53" }\`, the oldest gugu it runs on. Required to publish to the market, where it picks
  the newest version each machine can run; raise it when you start using a verb a newer gugu brought.
`;

export const EXTENSION_GUIDE_SETTINGS = `# Tools-only Apps and host settings

## Platform declarations

Declare human UI hosts in \`platforms\` (API 12): desktop, phone, or both. A phone UI may declare agent
capabilities; those features run only on computers. Phone plus \`notifications\` is refused at publication and install.

## Standing agent behavior

\`contributes.agentInstructions\`: 1–8000 characters of standing behavior, placed in the platform prompt
without waiting for Skill discovery. Requires \`agents:tools\`, a runnable MCP program, and the same enabled,
authorized App scope as tools. Works with native-listed and catalog tools. User instructions take precedence.
New sessions receive it in full; restart existing sessions after enabling or changing it. Revoked tools are
refused immediately, but an existing session's prompt is not rewritten. Use skills for detailed procedures.

## Configuration

An App with only programs or skills may omit \`entry\` and \`contributes.tabs\` (API 5). Clicking it
opens the host's configuration/status page. No blank HTML or custom frontend is needed. An HTML App
may also declare \`{ "name":"settings", "title":"Settings", "hostPage":"settings" }\` as a tab.
Optional top-level \`settings\` declares up to 32 fields: \`{ "key":"mode", "title":"Mode",
"type":"string", "default":"local" }\`. Types: \`string\`, \`boolean\`, or \`select\` with
\`options:[{"value":"local","title":"Local"}]\`; \`description\` and a typed \`default\` are optional.
Programs read \`JSON.parse(process.env.GUGU_APP_SETTINGS)\`. Values survive upgrades; saving retires
the old program after in-flight calls finish, and new calls start with the new values. Uninstall clears them.
A program's real failures reach the agent in its tool result and the person on the App's page; installed does not mean running.
Native host resources use \`contributes.mcpServers:[{"name":"browser-use","host":"browser-use"}]\`
(API 5, desktop GUI). They use the same App permissions, Agent scope, catalog and disclosure as stdio
programs; \`browser-use\` operates only the calling session's browser tab. Optional \`startUrl\` in
\`settings\` supplies the initial URL when that session has no tab; an explicit navigation wins.
\`"host":"computer-use"\` gives agents no tools: they control the computer with gugu's \`device_call\` (\`computer.*\`).
It gives the App's own pages \`preview_state\`: the page's session's latest frame (a real screenshot) and its recent
computer actions; \`notifications/computer-use/changed\` says there is a newer one.
A tab with \`"perSession": true\` has one page in each session, never moved between them — two sessions side by side
each show their own (not with \`opensFiles\` or \`hostPage\`). A computer-use App's per-session tabs come up beside a
session's conversation at that session's first computer action, once.
Use the existing \`agents:tools\` capability for programs/skills (see \`apps-programs\`).
Tool Apps run and are configured on Gugu Desktop. Phone package installs refuse host pages explicitly.
\`app_check\` drives custom HTML pages; open a host page with the \`tab_kind\` returned by \`app_install\`
or \`app_search\` and check its configuration and connection as a person would.
`;

/** The App guides \`guide_read\` serves, one topic each — see GUIDE_TOPIC_BYTE_BUDGET in gugu-guide-tool.ts. */
export const EXTENSION_GUIDE_TOPICS: readonly { topic: string; about: string; text: string; picture?: 'look' }[] = [
  {
    topic: 'apps',
    about: 'Start here when people in a chat want something to use together — a game, a vote, a board, a form, a small tool: an App is ready in about a minute and usually beats acting it out in chat or asking people one by one.',
    text: EXTENSION_GUIDE_START,
  },
  {
    topic: 'apps-ui',
    about: 'How a page looks: gugu\'s look is in every App page already — semantic HTML, <gugu-icon>, <gugu-avatar>, <gugu-time>, <gugu-empty>, one line each, with a picture of them all; app_check\'s snapshot and steps; and the App on the market card (description, icon, engines).',
    text: EXTENSION_GUIDE_UI,
    picture: 'look',
  },
  {
    topic: 'apps-page',
    about: 'The window.gugu API a page calls, the same wherever it runs: context, tabs, the background page, files, messages, notifications, links — and what each host (desktop, phone, program) has.',
    text: EXTENSION_GUIDE_PAGE,
  },
  {
    topic: 'apps-agents',
    about: 'What the app is showing (getAppState), and seeing and driving agents from a page: agents:read, agents:history, agents:control.',
    text: EXTENSION_GUIDE_AGENTS,
  },
  {
    topic: 'apps-settings',
    about: 'Tools-only Apps without HTML: a host-rendered configuration/status page, declared settings and the program environment.',
    text: EXTENSION_GUIDE_SETTINGS,
  },
  {
    topic: 'apps-programs',
    about: 'Giving agents your own tools (tools.js, MCP programs, skills) — also how agents subscribe to and follow what happens in your App, each call stamped with who made it — and calling your program from a tab.',
    text: EXTENSION_GUIDE_PROGRAMS,
  },
  {
    topic: 'apps-files',
    about: 'gugu.files: a chat\'s files, and a session\'s working copy — edited live by several people and agents together: text, live JSON, errors.',
    text: EXTENSION_GUIDE_FILES,
  },
  {
    topic: 'apps-editors',
    about: 'An editor on a text file — a textarea, your own contenteditable, or CodeMirror: bound, so others typing at the same time keep their letters; a whole-text change through snapshot + applyFrom.',
    text: EXTENSION_GUIDE_EDITORS,
  },
  {
    topic: 'apps-together',
    about: 'Several people in one App at once: presence (cursors, game frames), a game loop, and where a secret may and may not go.',
    text: EXTENSION_GUIDE_TOGETHER,
  },
  {
    topic: 'apps-messages',
    about: 'gugu.chats and gugu.messages (chat:read): the chats you are in and who is in one; a chat\'s timeline, one thread, the ones holding a text, and the ones citing a file, to count and show where a passage was discussed.',
    text: EXTENSION_GUIDE_MESSAGES,
  },
  {
    topic: 'apps-forum',
    about: 'gugu.forum (9): the forum\'s list and posts, replies, reactions, bounties behind the host\'s confirmation, assigning your agents, and its change events.',
    text: EXTENSION_GUIDE_FORUM,
  },
];
