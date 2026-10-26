import { readFileSync } from 'node:fs'
import { HOST_CALLS, HOST_EVENTS } from '../../../../apps/desktop/src/session/shared/extensions/host-calls'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { EXTENSION_GUIDE_TOPICS } from '../../../../apps/desktop/src/session/shared/extensions/authoring-guide'
import { BRIDGE_VERBS } from '../../../../apps/desktop/src/session/shared/extensions/bridge-protocol'
import { EXTENSION_CAPABILITIES } from '../../../../apps/desktop/src/session/shared/extensions/manifest'
import { EXTENSION_TOOL_DEFS } from '../../../../apps/desktop/electron/mcp/gugu-extension-tool'
import { GUIDE_TOPIC_BYTE_BUDGET, GUIDE_TOPICS } from '../../../../apps/desktop/electron/mcp/gugu-guide-tool'

// 扩展指南是手写的散文,所以它会过期(#6177 删掉旧判据后就过期过)。这里对着三处源码判覆盖:
// window.gugu 的真实动词(preload 暴露的那个对象)、桥上每个动词要的能力、app_* 工具定义。
// 指南拆成了几篇(#6615 W-22:Codex 按字节截掉超长工具输出的中段),判的是几篇合起来覆盖全部,且每篇不超上限。

interface Truth {
  verbs: readonly string[]
  capabilityOf: Readonly<Record<string, string | null>>
  capabilities: readonly string[]
  tools: readonly string[]
}

type Guide = { topic: string; text: string }

/** 指南与源码对不上的地方;空 = 对得上。几篇合起来判:动词写在哪一篇都行,但要写在那一篇里对的「Needs」下。 */
function guideProblems(guides: readonly Guide[], truth: Truth): string[] {
  const problems: string[] = []
  const firstMention = (verb: string) => {
    for (const { text } of guides) {
      const at = text.indexOf(`\`${verb}(`)
      if (at >= 0) return { text, at }
    }
    return null
  }
  for (const verb of truth.verbs) if (!firstMention(verb)) problems.push(`window.gugu.${verb} is not in the guide`)
  for (const { topic, text } of guides) {
    for (const [, verb] of text.matchAll(/`([a-z][A-Za-z]+)\(/g)) {
      if (!truth.verbs.includes(verb)) problems.push(`the guide (${topic}) describes ${verb}(), which window.gugu does not have`)
    }
  }
  // 每个桥动词的首次出现,要写在它真正需要的那条「Needs `能力`」下;免权限的写在「Free」下。
  for (const [verb, capability] of Object.entries(truth.capabilityOf)) {
    const mention = firstMention(verb)
    if (!mention || !truth.verbs.includes(verb)) continue
    const heading = [...mention.text.slice(0, mention.at).matchAll(/^(Free\b|Needs `([^`]+)`)/gm)].at(-1)
    const filedUnder = heading?.[2] ?? (heading ? null : 'no heading')
    if (filedUnder !== capability) problems.push(`${verb} is filed under ${filedUnder ?? 'Free'}, needs ${capability ?? 'nothing'}`)
  }
  const all = guides.map(({ text }) => text).join('\n')
  for (const capability of truth.capabilities) if (!all.includes(`\`${capability}\``)) problems.push(`capability ${capability} is not in the guide`)
  for (const tool of truth.tools) if (!all.includes(`\`${tool}\``)) problems.push(`tool ${tool} is not in the guide`)
  for (const [tool] of all.matchAll(/extension_[a-z_]+/g)) if (!truth.tools.includes(tool)) problems.push(`the guide names ${tool}, which does not exist`)
  return problems
}

/** 超过上限的篇:Codex 会把这一篇截掉中段,整段 API 说明就这么没了。 */
function oversized(guides: readonly Guide[]): string[] {
  return guides
    .filter(({ text }) => Buffer.byteLength(text, 'utf8') > GUIDE_TOPIC_BYTE_BUDGET)
    .map(({ topic, text }) => `${topic}: ${Buffer.byteLength(text, 'utf8')} bytes > ${GUIDE_TOPIC_BYTE_BUDGET}`)
}

function preloadVerbs(): string[] {
  // Every host's members come from one table (host-calls.ts): a page's own and the background page's own (`VerbFacts.only`) too.
  // `appFiles.*` and `clipboard.*` are host halves internal to the platform runtime: pages call `gugu.files.*` and
  // `gugu.clipboard.writeText`, which the runtime builds on them (checked below); so is `onFilesChanged`.
  const hostHalves = ['onFilesChanged', 'onForumChanged', 'onModalFocus']
  return [...Object.keys(HOST_CALLS), ...Object.keys(HOST_EVENTS)].filter((key) => !key.includes('.') && !hostHalves.includes(key))
}

/** What `gugu.files` offers, read from the runtime that builds it (app-runtime/create-gugu.ts). */
function runtimeFileVerbs(): string[] {
  const source = readFileSync(fileURLToPath(new URL('../../../../apps/desktop/src/session/app-runtime/create-gugu.ts', import.meta.url)), 'utf8')
  const start = source.indexOf('const files = Object.freeze({')
  const body = source.slice(start, source.indexOf('\n  });', start))
  return [...body.matchAll(/^ {4}([A-Za-z]\w*)[:,]/gm)].map(([, key]) => key)
}

const truth: Truth = {
  verbs: preloadVerbs(),
  // `dispatch` needs what its target needs (app-dispatch-core.ts): written under no single 「Needs」, its section says which.
  capabilityOf: Object.fromEntries(Object.entries(BRIDGE_VERBS).map(([verb, facts]) => [verb, typeof facts.needs === 'function' ? null : facts.needs])),
  capabilities: EXTENSION_CAPABILITIES,
  tools: EXTENSION_TOOL_DEFS.map((def) => def.name),
}

describe('扩展指南与源码对得上 (#6614)', () => {
  it('动词、能力、工具一个不漏,带权限的动词写在对的「Needs」下', () => {
    // 阳控:读出来的真值不能是空的,否则下面每一条都空转成绿。
    expect(truth.verbs).toEqual(expect.arrayContaining(['getContext', 'readAgentHistory', 'callProgram', 'dispatch']))
    expect(truth.tools).toEqual(['app_create', 'app_pack', 'app_install', 'app_check'])
    expect(guideProblems(EXTENSION_GUIDE_TOPICS, truth)).toEqual([])
  })

  it('gugu.files 的每个动词、gugu.messages、gugu.chats、编辑器绑定和 gugu.codemirror 都写进了指南', () => {
    const verbs = runtimeFileVerbs()
    // 阳控:从运行时读出来的动词不能是空的。
    expect(verbs).toEqual(expect.arrayContaining(['open', 'list', 'create', 'rename', 'remove', 'onChanged']))
    // `gugu.messages.*` and `gugu.chats.*` are the host's own rows (host-calls.ts), as the page reaches them.
    const messageVerbs = Object.keys(HOST_CALLS).filter((key) => key.startsWith('messages.') || key.startsWith('chats.') || key.startsWith('projects.'))
    // `gugu.forum.*`: the page's own (create-gugu.ts); subscribe / unsubscribe are `forum.onChanged`'s host half.
    const forumVerbs = Object.keys(HOST_CALLS).filter((key) => key.startsWith('forum.') && key !== 'forum.subscribe' && key !== 'forum.unsubscribe').concat('forum.onChanged')
    const modalVerbs = Object.keys(HOST_CALLS).filter((key) => key.startsWith('modal.') && key !== 'modal.key')
    expect(messageVerbs).toEqual(['messages.history', 'messages.search', 'chats.list', 'chats.members', 'projects.list'])
    const all = EXTENSION_GUIDE_TOPICS.map(({ text }) => text).join('\n')
    const missing = [...verbs.map((verb) => `gugu.files.${verb}(`), ...messageVerbs.map((key) => `gugu.${key}(`), ...forumVerbs.map((key) => `gugu.${key}(`), ...modalVerbs.map((key) => `gugu.${key}(`), 'gugu.bind.codemirror(', 'gugu.codemirror(', 'gugu.clipboard.writeText(']
      .filter((call) => !all.includes(call))
    expect(missing).toEqual([])
  })

  it('每篇都不超过上限,且 guide_topics 列出了每一篇', () => {
    const sizes = EXTENSION_GUIDE_TOPICS.map(({ topic, text }) => ({ topic, bytes: Buffer.byteLength(text, 'utf8') }))
    process.stdout.write(`[guide-topic-bytes] ${JSON.stringify(sizes)}\n`)
    expect(oversized(EXTENSION_GUIDE_TOPICS)).toEqual([])
    expect(GUIDE_TOPICS.map(({ topic }) => topic)).toEqual(expect.arrayContaining(EXTENSION_GUIDE_TOPICS.map(({ topic }) => topic)))
    // 阳控:一篇超上限的必须被点名。
    expect(oversized([{ topic: 'fat', text: 'x'.repeat(GUIDE_TOPIC_BYTE_BUDGET + 1) }]))
      .toEqual([`fat: ${GUIDE_TOPIC_BYTE_BUDGET + 1} bytes > ${GUIDE_TOPIC_BYTE_BUDGET}`])
  })

  it('判据会红:桥上多一个动词、动词挪错小节、指南提到已退役的工具、整篇漏掉', () => {
    expect(guideProblems(EXTENSION_GUIDE_TOPICS, { ...truth, verbs: [...truth.verbs, 'frobnicate'] }))
      .toContain('window.gugu.frobnicate is not in the guide')
    expect(guideProblems(EXTENSION_GUIDE_TOPICS, { ...truth, verbs: truth.verbs.filter((verb) => verb !== 'onLink') }))
      .toContain('the guide (apps-page) describes onLink(), which window.gugu does not have')
    expect(guideProblems(EXTENSION_GUIDE_TOPICS, { ...truth, capabilityOf: { ...truth.capabilityOf, readAgentHistory: 'agents:control' } }))
      .toContain('readAgentHistory is filed under agents:history, needs agents:control')
    expect(guideProblems([...EXTENSION_GUIDE_TOPICS, { topic: 'extra', text: 'Call `extension_guide` first.' }], truth))
      .toContain('the guide names extension_guide, which does not exist')
    // 拆篇特有的一种漏:某篇整篇没挂上,它里面的动词就查不到了。
    expect(guideProblems(EXTENSION_GUIDE_TOPICS.filter(({ topic }) => topic !== 'apps-agents'), truth))
      .toContain('window.gugu.listAgents is not in the guide')
  })
})
