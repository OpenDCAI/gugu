// app_* 工具的入参 —— **一份**(App 体检 10-17 #15):给 agent 看的那张(gugu-extension-tool.ts 的工具定义)与
// 真正校验的那张(会话主进程 extension-agent-actions.ts)都从这里取。从前两边各写一份,已经分岔过(id 的 min(1))。
// 有意的差别只有两格:`opens_files` 与 `manifest`。工具这一面原样放行(S1,create 压到 500 token 以内;错的写法由
// 下面那一层说清,extensionCreateOpensFiles.test.ts 守着),主进程那一侧在动作 schema 上换成 `opensFilesSchema` /
// `manifestFragmentSchema` 判 —— 它们的形状对 agent 没有新信息,却会进每条会话的前缀。
//
// 这里只放 agent 亲手传的那几格;宿主自己造的动作(bump / install_attachment / pack_installed / ask_install)
// 只在主进程那一侧。工具面另加的整体约束(app_install 的「恰好一个来源」等)在工具定义上 refine,
// 它们说的是「这几格怎么搭配」,不是「这一格是什么」。
import { z } from 'zod';
import { EXTENSION_STEP_SCHEMA } from './extension-check';
import { EXTENSION_TEMPLATES } from './templates';

/**
 * S1 (create under 500 tokens) The rest of manifest.json as the agent writes it: its own tabs, background, programs,
 * skills, permissions — writing permissions is authoring, `install` asks the person. Read loosely here, only as far as
 * `create` needs (the tabs, to give each its page); the manifest's own schema reads all of it when the bundle is
 * written, so there is one description of its fields, not a second one to drift.
 */
export const manifestFragmentSchema = z
  .object({
    contributes: z.object({ tabs: z.array(z.record(z.string(), z.unknown())).optional() }).passthrough().optional(),
  })
  .passthrough();

export const APP_CREATE_ARGS = {
  // F81 Left out: this computer's App folder (appSourcesRoot), not the working copy.
  target_dir: z.string().min(1).describe('Default: outside the working copy.').optional(),
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1).optional(),
  // F11 A ready-made App (its tab, page and files), or your own tabs in `manifest` — one of the two.
  template: z.enum(EXTENSION_TEMPLATES).optional(),
  // F40 Every file but manifest.json, pages included, written in this call; over a template's own.
  files: z.record(z.string().min(1), z.string()).optional(),
  // The App's claim: its first tab's opensFiles, by context (F110: say which — a session's files or a chat's).
  opens_files: z.unknown().describe('As opensFiles: {"chat":[".csv"],"session":[…]}').optional(),
  manifest: z.record(z.string(), z.unknown()).describe('Rest of manifest.json: guide "apps".').optional(),
};

export const APP_PACK_ARGS = {
  source_dir: z.string().min(1).describe('The bundle directory to pack, as you would pass to app_install; a relative path is taken from your working copy.'),
  output_path: z.string().min(1).describe('No need to pass it: the file is written next to the bundle folder and its path comes back. To choose: a folder (made if missing), or a path ending in .guguext.').optional(),
  // The host (acp-engine-utils withPackedCardSent) sends the card; the pack itself does not read it.
  chat_id: z.string().min(1).describe('A chat you are in: the packed App is sent there as an App card, and the answer carries its message_id.').optional(),
};

/** F102 The chat's data file: a new one ({title, content}) or a file already in the chat ({item_id}), opened as it is. */
export const appInstallDataSchema = z.object({
  title: z.string().min(1).describe('What the chat calls it (the App\'s file type is added).').optional(),
  content: z.unknown().describe('What it starts with; a .json App: an object — text people type in together as {"$text": ""}.').optional(),
  item_id: z.string().min(1).describe('Instead: a file already in the chat, opened as it is (claimed by its name or suffix), never copied.').optional(),
}).strict().refine((data) => (data.item_id === undefined) !== (data.title === undefined), {
  message: 'data is {title, content} for a new file, or {item_id} for one already in the chat',
}).describe('The chat\'s data file; one already there under that name is kept.');

export const APP_INSTALL_ARGS = {
  source_dir: z.string().min(1).describe('The App\'s folder, as app_create returned it.').optional(),
  // #6646 The host reads the message as this agent and installs it as `install_attachment`; it never reaches the plain install.
  source_message_id: z.string().min(1).describe('Instead: the chat message (msg:…) whose .guguext to install.').optional(),
  // App 市场方案 10-07: an App from the market, by its id or a name its card shows.
  market: z.string().min(1).describe('Instead: an App from the market — its id, or the name its card shows; @<version> (radar@0.1.2) for that version.').optional(),
  // F15 chat_id / F40 data: the host (acp-engine-utils) does the chat's part after the install — the data file, the
  // check on it, the card. The install itself only words `next` with chat_id.
  chat_id: z.string().min(1).describe('A chat you are in; the App goes there as a card.').optional(),
  data: appInstallDataSchema.optional(),
  // D-31 Another machine of the owner's: the host asks it (installedElsewhere). device 的写法在 session_spawn 上写一次(上下文工程第一批 P5)。
  device: z.string().min(1).optional(),
};

export const APP_CHECK_ARGS = {
  // F14 (L7-b) The tab_kind app_install / app_search hand back: one value names the App and its tab.
  tab_kind: z.string().min(1).describe('Which tab of which App, exactly as app_install and app_search hand it back ("<id>.<tab>").'),
  // F5 The host already read chat_id / item_id as this agent (acp-engine-utils withMessageAttachment).
  item_id: z.string().min(1).describe('A chat\'s file (workspace__list) the tab opens: it runs opened on that file, in that file\'s chat. An App of chat files wants it.').optional(),
  chat_id: z.string().min(1).describe('Only without item_id: a chat you are in, and the tab runs as it does in that chat\'s side panel. With item_id it must be that file\'s chat.').optional(),
  // F94 In a session: a file of the caller's working copy, the page opened on it as a session tab claiming it would be.
  file_path: z.string().min(1).describe('Instead, in a session: a file of your working copy the tab opens, as opening it there would.').optional(),
  // Owner 10-12: what to click, fill, call and wait for once it settled; at a phone's width with touch (`phone`).
  steps: z.array(EXTENSION_STEP_SCHEMA).min(1).max(30).describe('Once it settled, in order, as a person would: {"click":{role,name}}, {"fill":{role,name},"text"}, {"press":"Enter"} (or Escape, Tab, Backspace, an arrow: on what has the focus), {"waitFor":{role,name} or {text}} (up to 5 s); "look": true adds a picture after that step. Name a control by its role and name as the snapshot says them; several alike: add "within": {role,name} or {role,text}. One match or the step fails, listing candidates; the first failure stops the rest. Up to 15 s in all.').optional(),
  phone: z.boolean().describe('With steps: run them at a phone\'s width, tapping instead of clicking.').optional(),
  // Owner 10-13: go on with the page an earlier check of this session kept, where it was left.
  page: z.string().min(1).describe('The page an earlier app_check of yours answered with: the steps go on there, where it was left (its selection, scroll, open dialog). Alone with tab_kind and steps.').optional(),
};
