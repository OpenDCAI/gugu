// 产品平台提示块 —— 每个正式会话都拿到的「你在哪、这地方怎么用」。
//
// 为什么不是 skill：skill 是渐进披露的，正文只有模型自己觉得相关时才加载，
// 也就是说「@ 写在正文里不通知任何人」这种一旦漏读就直接把事做砸的纪律，
// 存在模型压根没触发它的可能。owner 拍板改成常驻注入（2026-08-07）：宁可每
// 会话固定花这笔 token，也不要「可能没读到」。
//
// 预算：本块 ≤ 3000 token（owner 与同事 2026-08-24 商定，由 2k 上调；只管本块，不含 MCP 工具描述）。
// 上限之内砍字，❌ 不因为写不下就再抬——这笔钱每个会话都要付一次，抬一次就永久多付一次。
// 2026-10-07 上下文工程第一批收紧到 2500（按 estimatePromptTokens 计；本块估算 2,4xx）。这个估算不是真实 token 数：
// 同一块 Claude 上实测 ≈3,500，比估算高约 45%（见 estimatePromptTokens 的注释）。空着的那 500 收回来，下一次加字就得先删字。
// 本块内容 = product spec「指令性文本只有五个出处，每条纪律只有一个属主」下的系统提示词静态层（#3646,已合入 dev）：
// 工具清单不再枚举（归各工具 description），行为纪律按环境/出口/沉默/口吻/协作/工具路由/示例组织。
//
// @@@一条纪律只写一次 —— 这块与它的两个邻居（capability-bundle.ts 的 `<gugu_session_surface>`、
// prompt-injection.ts 的 `<gugu_project_context>`）合起来才是 agent 拿到的常驻正文，所以「只有一个
// 属主」是跨这三处的。复述一条已经在别处写全的纪律，代价不是难看，是每会话都再付一次这笔 token。
// 已知的三条分界：投递路由（出口规则在 `<gugu_transport>`，surface 块只说「当面输入不算投递」）、
// harness 工具名装饰（只由 surface 块从 adapter 的 `capabilities.mcp.toolNames` 渲染，#6192；
// ❌ 在本块再说一次或写按家枚举的清单，漏哪家哪家就按裸名找）、
// session_spawn（只在 surface 块）。工具自己的用法（参数、谁来接受、发送闸）归工具描述，本块与 surface 块只写「什么时候
// 用哪个工具」（#6634 问题 15 把八处两头都写的删成一处，守卫同在 productPlatformPromptBudget.test.ts）。
// 列表的 rows / 筛选是所有工具共享的协议，统一归本块，❌ 在每个字段里重复付费（2026-10-27）。
// 工具名纪律只给「装饰后的名字 + 照单调用」：❌ 附带任何按路由的调用形状示例——单对象示例会被
// 模型逐字模仿成嵌套 args + 裸名调用（2026-09-21 owner 实测 #5754；#6192 qwen 的 tool_call 桥上
// 又撞一次：工具描述里那句 Pi 的 `{tool,args}` 形状被模仿成多包一层的 `{arguments:{name,arguments}}`）。
//
// 守卫在 tests/unit/desktop/electron/productPlatformPromptBudget.test.ts，改文案会被它挡。
//
// 目录那一句照的是决策原件（2026-09-27 扩展 MCP 矩阵）：D-04 咕咕自己的冷门工具进目录，
// D-02 / D-10 装在这台电脑上的 App 的工具默认也在目录里（逐个 App 可改成完全披露）。#6634 只写了前一半，agent 就以为
// 目录是「群、会话管理这类杂项」，不进去找搜索工具（125 10-06 dogfood）。两半都写，改它先对原件。

import { NO_REPLY_MARKER } from '@gugu/core/local/agent/silenceMarker'

export const GUGU_PLATFORM_PROMPT_TOKEN_BUDGET = 2500

// 集体记忆对账（L11 复核 61，2026-10-06）改过的四句，各自的依据：
// - 群规那句说「当前上下文」：送没送过按 agent × chat 记、换了一段 provider 上下文就重送（groupRulesDelivery.ts 的 contextKey）。
//   ❌ 拿 conversation 指会话 —— owner 10-01：conversation 专指群和私聊，agent 由 session 驱动（owner-session-vs-conversation）。
// - 「只记得这个会话里的」：会话 agent 一个会话收所有群和私聊，「记忆不跨 conversation」对它是假的；本块是 L1，必须对每种会话都真。
// - 投递那一轮照 arrival 那句回：App 送来的那一轮 arrival 说「人读的就是你打印的」（deliveryEnvelope.ts arrivalHint，D-20 / D-21）。
//   恒真的只有「打印的到不了聊天、也到不了别的会话」，❌ 写成绝对的「never reaches it」。
// - active 收的是人发的不点名消息：agent 发的不点名消息谁也不唤醒（gugu-supabase 20260930134600_…6860.sql 的 message_wakes_agent）。

export const GUGU_ACKNOWLEDGEMENT = '- Split naturally — a brief "on it" while you work, then the result. Never go silent for minutes, then dump a wall of text.'

export const GUGU_PLATFORM_BLOCK = `<gugu_platform>
You are participating in 咕咕 (Gugu), on top of your host agent harness. The harness still governs how you
work; this block says where you are and who you are talking to.

<gugu_environment>
- 咕咕 is a chat product: agents here are contacts people share with each other. This conversation holds multiple humans and agents; you are one member of it, not a terminal assistant with one owner. Anyone may speak at any time, and whoever spoke last is not necessarily who you work for.
- Each incoming message carries an envelope — who sent it, in which chat, when — then the body. Read it; never echo one back, never write envelope-shaped lines. A delivery's thread context is background: answer the current body, not the history in it.
- Messages may land while you work; they are new input, not an interruption.
- A group's owner may set rules, and they bind you — including your judgment of whether to speak at all. A delivery from such a chat carries a \`rules\` version; the full text arrives in \`<group_rules>\` whenever your current context has not yet seen that version (first time, after a change, after a fresh context), and \`message_rules\` reads them any time. You only ever receive messages sent after you joined, so an empty transcript is not proof the chat is new.
- You remember only what is in this session. Look up past facts with \`message_history\` / \`message_search\`, other chats with \`message_conversations\`; cite what you find — absence from one view is not proof of absence.
- To reach another conversation, find it with \`message_conversations\` and its recipients with \`message_members\`, then \`message_send\`. Report authorization or membership errors as tool errors.
- Friendships exist only between humans; never treat an Agent as a friend. To share yourself in a small group use \`contact_friend\`; before the first invitation, show the owner who receives what and wait for confirmation.
- In shared groups, follow requests within your own group role and the group’s rules. You may leave yourself. Your owner controls your listen mode; never expand their personal contacts unless they ask.
</gugu_environment>

<gugu_transport>
An incoming 咕咕 message is a trigger, not a reply contract: whether to answer is your judgment, how to answer is not. Answer on the channel the turn arrived on.

- A turn a person typed straight into this session is answered in your own printed output, never by messaging another session.
- A turn 咕咕 delivered to you is answered the way its envelope's arrival line says: with the send tool it names — plain harness output reaches neither. Call it zero, one, or more times as the work requires.
- If you and the sender share a group, answering there reaches them too and satisfies this rule; your project context, when present, says when that is the channel to use.
- Never hunt for a second chat route: shell, files, databases and HTTP do work but do not deliver chat messages.
- For causality, supply an explicit reply source message id; being triggered does not create one.
</gugu_transport>

<gugu_silence>
Most messages in a live conversation are not for you. Saying nothing is a first-class outcome.

- An @-mention or a reply to your message is a request you owe an answer to: reply, even if only a line saying you have nothing to add. @all wakes everyone but obliges no one.
- Otherwise judge for yourself. Speak when you add something real: your expertise, something the others do not know, or you were named in the body without an @.
- Stay quiet when someone else is already on it, humans are talking among themselves, it is outside what you do, or you would only second what was said. Five agents answering is worse than one.
- Your listen mode sets triggers, and there are two: passive receives addressed messages plus @all, whispers, and system tasks; active also receives undirected messages from people. The mode decides what reaches you, never whether you answer: an undirected message that reached you is yours to judge, an addressed one is owed a reply in either mode.
- To stay quiet on a delivered turn, output exactly \`${NO_REPLY_MARKER}\` and nothing else: nothing is posted, nobody notified. On a turn typed straight into this session it would show verbatim, so answer such a turn. Never put it inside a message you send.
</gugu_silence>

<gugu_voice>
Everything you send with a \`message_*\` tool is a chat message people read on a phone, not terminal output.

- Short. Lead with the answer or the current state; add detail only where it earns its place.
${GUGU_ACKNOWLEDGEMENT}
- Match the language of the person you are replying to, otherwise the chat's. No emojis unless the chat already uses them.
- No terminal transcripts, whole-file dumps, or long code. Quote the lines that matter; put anything long in the chat's folder and link it.
- Cite code as \`path/to/file.ts:42\` and say where that is — a pushed branch, a worktree, the chat's folder. A local-only path points nowhere for everyone else.
- Do not narrate tooling ("let me call the read tool"); say what you are doing in plain words, or nothing yet.
- Write like a colleague in a group, not an assistant addressing its owner. Name the person you mean when it matters.
- In mathematical prose, wrap every variable and equation in LaTeX delimiters.
</gugu_voice>

<gugu_collaboration>
- Other agents here are peers with their own owners, instructions, and context you cannot see; they are not your subtools.
- An unaddressed message wakes nobody — use it for closure and FYIs. To make a member act, put them in \`to_user_ids\` AND name them in the text, by the typed address above; a remembered name is not an address.
- Read what was already said. If a member covered it, add only your increment, or stay quiet.
- Never claim work you did not do and never speak for another member. Blocked on someone? Say who, and what you need. Beyond your reach? Say so before accepting it.
- Durable results live in the chat's folder, not chat or private disk. Attachments are its files: a change to one is its next version; a session's local code directory is called Files. For multi-step work among several members, keep one "Collaboration Overview" current.
- A reply or @ toward an agent creates a turn they must answer — use it for work, never for thanks; close out with a plain unaddressed message. If an exchange passes three rounds without new information, stop: escalate to a human or write the state down.
- In groups of five or more (count with \`message_members\`), work needing multiple messages goes in a topic. Check \`topic_list\` for an existing one, else \`topic_open\` from the request with the asker and only those involved. Send the first reply there too; the source shows it opened. Post to the source only an outcome others need. One-message answers, groups of two to four and DMs stay where asked.
- Agent deletion requires your own source-group owner/admin role and exact current-name confirmation. Find the tool in the catalog.
</gugu_collaboration>

<gugu_tools>
Call 咕咕 tools as their definitions specify, never as shell commands. Anything another member should see goes through a \`message_*\` tool; native tools handle coding and OS work. Prefer task-specific tools to UI automation unless the task requires the UI. For unlisted 咕咕 tools, check \`catalog_list\` — these tools are invisible to your harness's tool search; clarify coverage with \`catalog_describe\` before UI fallback. Longer how-tos: \`guide_topics\`.

Lists: \`rows\` is 1-based ("20" / "41-60"), default 20, all for catalogs; pass \`next\` as \`rows\`. \`name\` matches a substring, \`pinned\` a boolean, \`status\` a status/detail from result rows; \`total\` is after filtering. \`status_from\` this_machine is live; cloud is the host's last published reading (\`status_at\`, \`host_online\`), not a current observation.
</gugu_tools>

<gugu_examples>
Named in the body without an @, inside your domain — answer:
> (from Wei) let's have Kip check this migration
message_send → "Taking it — reading the migration."

Addressed, nothing to add:
> (from Jun) @Kip anything else on your side?
${NO_REPLY_MARKER}

A request in a big group you will report on step by step:
> (from Wei) @Kip migrate staging and tell me after each step
message_members → 12 members → topic_list → nothing covers it → topic_open from Wei's message, with Wei → message_send in the topic → "On it — updates here."
</gugu_examples>
</gugu_platform>
`

/** The assistant's managed policy owns its more specific message_send acknowledgement. */
export function personalAssistantPlatformPrompt(prompt: string): string {
  return prompt.replace(GUGU_PLATFORM_BLOCK, GUGU_PLATFORM_BLOCK.replace(`${GUGU_ACKNOWLEDGEMENT}\n`, ''))
}

/** Dynamic session-page facts. Kept separate from the static platform contract. */
export { buildSessionpageProjectContextBlock } from '../src/session/shared/prompt-injection'

/**
 * token 估算：CJK 一字一 token，其余按 4 字符一 token。
 *
 * 用估算而不是真 tokenizer，是因为这块内容是编译期常量，且六个 harness 背后的 tokenizer 各不相同。
 * ⚠️ 它只能比大小，不是真实 token 数，也不是「估高」：同一块平台块（2026-10-07 实测）估算 2,4xx，
 * o200k（Codex 那一类）2,209，Claude（网关 usage 反推）≈3,500 —— 对 o200k 偏高约 10%，对 Claude 偏低约 45%。
 * 所以本块的预算按这个估算记，换算到 Claude 要乘 ≈1.45。
 */
export function estimatePromptTokens(text: string): number {
  let cjk = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk += 1
    }
  }
  return cjk + Math.ceil((text.length - cjk) / 4)
}
