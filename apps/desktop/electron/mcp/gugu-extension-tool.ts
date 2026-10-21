// app_* 域 —— 会话页 tab 扩展的四个原子工具(create / pack / install / check);找 App 是 app_search 的事(gugu-app-search-tool.ts);怎么写扩展在 guide 域(gugu-guide-tool.ts)。
// 与社交域、session 域注册在同一个会话 MCP server 上。单 server 下「域」是架构一等公民(#4191):
// 本文件只有这个域的定义,注册机制在 sessionpage-tool-registrar.ts。
//
// 扩展侧只有两件事:写出来(app_create)和装上去(app_install)。**没有第三件叫
// 「批准权限」** —— product spec 里那条线(agent 可以创建,但不能自己批准权限)靠 install 侧真的
// 拒来守,不靠工具描述里写一句劝告。Refs #2374

import type { GuguMcpRequestTracker } from '../gugu-mcp-host'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  registerSessionpageTools,
  type SessionDispatcher,
  type SessionpageToolDef,
} from './sessionpage-tool-registrar'
import { APP_RUNTIME_GLUE_MODULE } from '../../src/session/shared/extensions/app-runtime-protocol'
import { APP_CHECK_ARGS, APP_CREATE_ARGS, APP_INSTALL_ARGS, APP_PACK_ARGS } from '../../src/session/shared/extensions/app-tool-args'

export const EXTENSION_TOOL_DEFS: readonly SessionpageToolDef[] = [
  {
    name: 'app_create',
    // S1 (L5: under a minute) The common path whole, and nothing of the rest: the rest of manifest.json goes in
    // `manifest` as manifest.json writes it, checked there by the manifest's own schema — not described twice.
    description: [
      'A chat App (a group, topic or private chat): template "group-json", your whole app.js in files["app.js"]; it looks like gugu by itself — semantic HTML, <gugu-avatar user>, <gugu-icon name> (guide apps-ui). app.js:',
      `  import { f, me, myName, $, $$, html, render } from '${APP_RUNTIME_GLUE_MODULE}'  // gugu's, not in your bundle; me: 'user:<uuid>'`,
      '  f.data.answers[me] = x  // live JSON, spread ok, never cloned; typed together: gugu.text(""), in data {"$text":""}; many adding: a map by id',
      '  f.presence.set(pos)  // per-frame state; the file: events, results (a catch)',
      '  let members = (await gugu.getContext()).chat?.members ?? []  // { id, name, kind }: pick, never copy',
      '  // f.onChange(renderShared): render($("#shared"), html`…`) — inputs of file values too, rows by data-key; drafts, bind.text boxes: #controls',
      '  // wake only the agent it concerns: gugu.send(member.id, "your move", { refs: [{ file: f.entry }] }) — state stays in the file; manifest.permissions.capabilities ["chat:relay"]',
      '  // agents follow: a tool in tools.js, run(args, { agent }) — guide apps-programs',
      'Then app_install with chat_id, data (in the chat already: {item_id}, never a copy). Own pages: manifest.contributes.tabs + files["<name>.html"]. Text file: gugu.bind.text(textarea, f).',
    ].join('\n'),
    // 这一份就是主进程校验的那一份(app-tool-args.ts)。
    schema: z.object(APP_CREATE_ARGS).strict(),
    action: 'create',
  },
  {
    name: 'app_pack',
    description: 'Only for sharing an App with other people: pack a bundle directory into a .guguext file; it must pass the same checks app_install runs. With chat_id it also goes into that chat as an App card the people there install from, in the same call; without, send the returned file_path with message_send_file. Installing and testing your own App never needs it — app_install takes the folder, and puts it on your owner\'s computer.',
    schema: z.object(APP_PACK_ARGS).strict(),
    action: 'pack',
  },
  {
    name: 'app_install',
    // 集体记忆对账第 7 条:D-17 重装没新增声明不弹框(extension-agent-actions.ts installPlan 的 asks),说明里补这半句。
    description: 'Install an App on your owner\'s computer (this one, or another with device): from source_dir (app_create), a .guguext in a chat (source_message_id), or the market. For a chat App give chat_id and data too: one call makes its data file, checks the App on it, posts it to the chat as a card and returns the file\'s link. An App asking for capabilities waits for the person to confirm; reinstalling from the same folder with nothing new declared replaces it without asking.',
    schema: z.object(APP_INSTALL_ARGS).strict().refine((args) => [args.source_dir, args.source_message_id, args.market].filter((given) => given !== undefined).length === 1, {
      message: 'app_install takes exactly one of source_dir, source_message_id or market',
    }).refine((args) => args.chat_id === undefined || args.source_message_id === undefined, {
      message: 'app_install: chat_id goes with source_dir or market — an App installed from a card is already in that chat',
    }).refine((args) => args.device === undefined || args.market === undefined, {
      // Another machine is asked through the package it is sent (install_attachment's two-step consent); the market has no such step.
      message: 'app_install: device takes source_dir or source_message_id — an App from the market installs on the computer you run on',
    }).refine((args) => args.data === undefined || args.chat_id !== undefined, {
      message: 'app_install: data is the data file of a chat — it goes with chat_id',
    }).refine((args) => args.device === undefined || args.chat_id === undefined, {
      message: 'app_install: device installs it on that machine only — the chat gets its card from here: app_install with chat_id, without device',
    }),
    action: 'install',
  },
  {
    name: 'app_check',
    // Owner 10-13: the page is kept to go on with (page), it runs where it opens. Owner 10-14: you work it — the one
    // sentence says so, and nothing else warns.
    description: 'See whether an installed App actually works: the host runs one of its tabs as a hidden page where it opens — on a chat\'s file (item_id) as opening that file there would, in a chat\'s side panel (chat_id), else as a tab of your session — and you work it. What it does on the page is real, done in your name. It waits until it settles (loaded, its files opened, quiet; up to 15 s), and reads back whether it loaded, the errors it threw or reported with the file, line and source (a hint is advice to you, not a failure), what the App\'s real pages recorded since this version was installed, console errors, a snapshot of what it shows (its accessibility tree, a line per control: role "name"), and what would have reached your owner\'s screen (shown). With steps it then clicks, fills, presses and waits as a person would and says what each step did. The page stays as the check left it: the answer\'s page, given back, goes on from there.',
    schema: z.object(APP_CHECK_ARGS).strict(),
    action: 'check',
  },
]

// F14 (L7-b) 列出来就得能用:app_check 要宿主真能把 App 开成隐藏页(有窗口、接上了那条检查通路)。做不到的宿主
// 干脆不列它,❌ 列出来再逐次拒 —— agent 看见工具就会去调,拒了还会换着参数重试。这是进程级的一件事实:宿主加载会话页
// 模块时问一次(main.ts loadEmdashBridge),不随 grant 变,所以工具清单仍不随 grant 变。
let extensionCheckAvailable = false

export function setExtensionCheckAvailable(available: boolean): void {
  extensionCheckAvailable = available
}

/** F40 app_install { data } checks the App on its new data file only where app_check itself is listed. */
export function isExtensionCheckAvailable(): boolean {
  return extensionCheckAvailable
}

/** 把 app_* 原子工具注册进已有 MCP server，动作交给宿主的扩展分派器。 */
export function registerGuguExtensionTools(
  server: McpServer,
  runExtensionAction: SessionDispatcher | undefined,
  track: GuguMcpRequestTracker,
): void {
  registerSessionpageTools(
    server,
    EXTENSION_TOOL_DEFS.filter((def) => def.action !== 'check' || extensionCheckAvailable),
    runExtensionAction,
    (tool) => `${tool} is unavailable for this grant`,
    track,
  )
}
