import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  ASSISTANT_DENIED_TOOLS,
  ASSISTANT_FIRST_TASK,
  ASSISTANT_GUIDE_BEGIN,
  ASSISTANT_GUIDE_END,
  LEGACY_ASSISTANT_GUIDE_BEGIN,
  LEGACY_ASSISTANT_GUIDE_END,
  OWNER_PROFILE_INDEX_LINE,
  assistantBrief,
  assistantGuide,
  assistantHomePaths,
  claudeProjectDirName,
  ownerProfileMarkdown,
  ownerProfileMemoryFile,
  upsertAssistantGuide,
  withDeniedTools,
  withOwnerProfileIndex,
} from '../../../../packages/core/src/shared/assistantPolicy'
import { ASSISTANT_CONTEXT_CORE, ASSISTANT_TASK_EXECUTION, ASSISTANT_WORKFLOW } from '../../../../packages/core/src/shared/assistantWorkflow'
import { splitInstructions } from '../../../../apps/desktop/src/session/renderer/features/assistant/assistant-files'

// #7199 住云上(管家写)与住人自己的电脑上(客户端写)共用同一份说明、同一份初始化任务。
describe('assistantGuide', () => {
  it('keeps titles and shared fields neutral without growing the core', () => {
    const prompts = [ASSISTANT_CONTEXT_CORE.join('\n'), ASSISTANT_WORKFLOW.join('\n')]
    for (const kind of ['cloud', 'computer'] as const) {
      prompts.push(assistantBrief(kind, '/assistant/reference.md', '/assistant/memory'), assistantGuide(kind))
    }
    for (const prompt of prompts) {
      expect(prompt).toContain('私聊、早晚报和日程用已确认称呼或「你」')
      expect(prompt).toContain('任务标题及共读字段不带身份称谓')
    }
    expect(ASSISTANT_CONTEXT_CORE.join('\n').length).toBeLessThanOrEqual(1272)
  })

  it('keeps the template sources and all generated instructions free of role address terms', () => {
    const prompts = [ASSISTANT_TASK_EXECUTION, ASSISTANT_FIRST_TASK, ASSISTANT_CONTEXT_CORE.join('\n'), ASSISTANT_WORKFLOW.join('\n'), ownerProfileMemoryFile('称呼：小明'), OWNER_PROFILE_INDEX_LINE]
    for (const kind of ['cloud', 'computer'] as const) {
      const brief = assistantBrief(kind, '/assistant/.gugu-assistant-reference.md', '/assistant/memory')
      prompts.push(brief, assistantGuide(kind))
      expect(brief.length).toBeLessThanOrEqual(kind === 'computer' ? 2106 : 2128)
    }
    for (const prompt of prompts) {
      expect(prompt).not.toMatch(/主人|用户/)
    }
    for (const source of ['assistantPolicy', 'assistantWorkflow']) {
      expect(readFileSync(new URL(`../../../../packages/core/src/shared/${source}.ts`, import.meta.url), 'utf8')).not.toContain('主人')
    }
    expect(ASSISTANT_CONTEXT_CORE.join('\n').length).toBeLessThanOrEqual(1262)
  })

  it('keeps person facts separate from instructions and lets the host trigger version review', () => {
    for (const kind of ['cloud', 'computer'] as const) {
      const brief = assistantBrief(kind, '/assistant/.gugu-assistant-reference.md', '/assistant/memory')
      const guide = assistantGuide(kind)
      expect(brief).toContain('关于你：按宿主整理要求处理，不自行重查版本。')
      expect(brief).not.toContain('比对上下文索引')
      expect(brief.length).toBeLessThanOrEqual(kind === 'computer' ? 2106 : 2128)
      expect(guide).toContain('正文开头先用「你」写 1～3 句人物事实')
      expect(guide).toContain('身份、正在做的事、已确认的作息')
      expect(guide).toContain('不凭文件时间猜作息')
      expect(guide).toContain('称呼只写一行「称呼：姓名」')
      expect(guide).toContain('全文不用「他」指代本人')
      expect(guide).toContain('其余称呼原话和规矩全部删除，不保存在任何记忆（包括 feedback）')
      expect(guide).toContain('本人确已确认的其他行为约定归 feedback')
      expect(guide).toContain('保留原有事实和依据')
      expect(guide).toContain('缺失/不同仍在下一轮整理')
      expect(guide).toContain('回读确认合规后')
      expect(guide).toContain('profile_rules: 6')
      expect(guide).toContain('失败不标记通过，下轮再查')
      expect(guide).not.toContain('比对上下文索引')
    }
  })

  it('frames delegated work as tasks and tools without person-like worker terminology', () => {
    const kinds = ['cloud', 'computer'] as const
    const resident = kinds.map(kind => assistantBrief(kind, '/assistant/reference.md', '/assistant/memory'))
    const guides = kinds.map(kind => assistantGuide(kind))
    for (const prompt of [ASSISTANT_TASK_EXECUTION, ASSISTANT_CONTEXT_CORE.join('\n'), ASSISTANT_WORKFLOW.join('\n'), ASSISTANT_FIRST_TASK, ...resident, ...guides]) {
      expect(prompt).not.toMatch(/执行者|同事|小弟|Task Agent|任务 [Aa]gent|子 agent/)
    }
    for (const prompt of [...resident, ...guides]) {
      expect(prompt).toContain('我开了个任务去你 MacBook 上看一眼')
    }
    for (const prompt of resident) expect(prompt).toContain('任务是工具')
    for (const prompt of guides) {
      expect(prompt).toContain('全程只有你这一个身份，你不是某个项目里的任务')
      expect(prompt).toContain('任务是你用的工具，不当成人来称呼')
      expect(prompt).not.toContain('不作人称')
    }
    expect(ASSISTANT_TASK_EXECUTION).toContain('你在完成一项任务，不是个人助理')
    // A byte-level tokenizer cannot emit more tokens than UTF-8 bytes.
    // Use the conservative bound instead of assuming a particular provider's tokenizer.
    expect(new TextEncoder().encode(ASSISTANT_TASK_EXECUTION).length).toBeLessThanOrEqual(500)
  })

  it('两种家都带头尾标记,界面那一侧(splitInstructions)认得出宿主维护的那一段', () => {
    for (const kind of ['cloud', 'computer'] as const) {
      const guide = assistantGuide(kind)
      expect(guide.startsWith(ASSISTANT_GUIDE_BEGIN)).toBe(true)
      expect(guide.trimEnd().endsWith(ASSISTANT_GUIDE_END)).toBe(true)
      const parts = splitInstructions(`我喜欢简短的回答。\n\n${guide}`)
      expect(parts.managed?.trim()).toBe(guide.trim())
      expect(parts.user).toBe('我喜欢简短的回答。')
    }
  })

  it('describes cloud scaling and disconnected local delivery without personifying machines', () => {
    const cloud = assistantGuide('cloud')
    const computer = assistantGuide('computer')
    expect(cloud).toContain('后台资源需要时自动启动')
    expect(cloud).toContain('不用对人提后台资源')
    expect(computer).toContain('暂不可用时消息保留')
    expect(computer).not.toContain('提醒、定时汇报用咕咕的 schedule_create')
    expect(computer).not.toContain('海外网站')
    for (const prompt of [cloud, computer]) expect(prompt).not.toMatch(/一直在|电脑睡|机器睡|睡着|叫醒|正在连接|未连接|重新连接|连接断/)
  })

  it('早晚简报那一节两边一字不差(今天页读的格式只此一份)', () => {
    const section = (g: string) => g.slice(g.indexOf('# 早晚简报'))
    expect(section(assistantGuide('computer'))).toBe(section(assistantGuide('cloud')))
  })
})

describe('upsertAssistantGuide', () => {
  const guide = assistantGuide('computer')
  it('没有文件 = 就是这份说明', () => {
    expect(upsertAssistantGuide('', guide)).toBe(guide)
  })
  it('文件里有人写的、没有标记 = 接在末尾,人写的原样留着', () => {
    const next = upsertAssistantGuide('我的备忘\n', guide)
    expect(next.startsWith('我的备忘\n\n')).toBe(true)
    expect(next.endsWith(guide)).toBe(true)
  })
  it('有标记 = 只换标记那一段,前后人写的都留着;再来一遍结果不变', () => {
    const old = `前面\n\n${ASSISTANT_GUIDE_BEGIN}\n旧说明\n${ASSISTANT_GUIDE_END}\n\n后面\n`
    const once = upsertAssistantGuide(old, guide)
    expect(once).toContain('前面')
    expect(once).toContain('后面')
    expect(once).not.toContain('旧说明')
    expect(upsertAssistantGuide(once, guide)).toBe(once)
  })
  it('旧标记(带「云电脑」的)就地换成新的', () => {
    const old = `${LEGACY_ASSISTANT_GUIDE_BEGIN}\n旧\n${LEGACY_ASSISTANT_GUIDE_END}\n我的\n`
    const next = upsertAssistantGuide(old, guide)
    expect(next).not.toContain('旧\n')
    expect(next).toContain('我的')
    expect(next).toContain(ASSISTANT_GUIDE_BEGIN)
  })
})

describe('assistantHomePaths', () => {
  it('云上:说明 / 技能 / 设置在 ~/.claude,记忆在 Claude Code 按工作目录记的那一夹,资料夹在主目录', () => {
    const p = assistantHomePaths('/home/wuying', '/home/wuying/助理', 'cloud')
    expect(p.instructions).toBe('/home/wuying/.claude/CLAUDE.md')
    expect(p.memoryDir).toBe(`/home/wuying/.claude/projects/${claudeProjectDirName('/home/wuying/助理')}/memory`)
    expect(p.claudeMemoryDir).toBe(p.memoryDir)
    expect(p.skillsDir).toBe('/home/wuying/.claude/skills')
    expect(p.resourcesDir).toBe('/home/wuying/给助理的资料')
  })

  it('住电脑:一个字都不落在人自己的 ~/.claude 里(除了那一夹链接),其余都在它的工作目录里', () => {
    const work = '/Users/me/.gugu/assistant'
    const p = assistantHomePaths('/Users/me', work, 'computer')
    for (const path of [p.instructions, p.memoryDir, p.memoryIndex, p.skillsDir, p.settings, p.resourcesDir]) {
      expect(path.startsWith(`${work}/`)).toBe(true)
    }
    expect(p.claudeMemoryDir).toBe(`/Users/me/.claude/projects/${claudeProjectDirName(work)}/memory`)
  })
})

describe('withDeniedTools', () => {
  it('没有设置文件 = 只禁 CronCreate', () => {
    expect(JSON.parse(withDeniedTools(null))).toEqual({ permissions: { deny: [...ASSISTANT_DENIED_TOOLS] } })
  })
  it('已有的设置与禁用项照留,重复来不重复加', () => {
    const raw = JSON.stringify({ model: 'x', permissions: { allow: ['Bash(ls)'], deny: ['WebFetch'] } })
    const once = withDeniedTools(raw)
    expect(JSON.parse(once)).toEqual({ model: 'x', permissions: { allow: ['Bash(ls)'], deny: ['WebFetch', 'CronCreate'] } })
    expect(withDeniedTools(once)).toBe(once)
  })
  it('原文读不懂 = 抛(❌ 盖掉人写的设置)', () => {
    expect(() => withDeniedTools('{not json')).toThrow()
    expect(() => withDeniedTools('[1]')).toThrow()
  })
})

describe('主人的称呼和基本信息', () => {
  it('称呼必有,介绍可空', () => {
    expect(ownerProfileMarkdown({ preferredName: ' 小明 ', about: '', language: 'en-US' })).toBe('称呼：小明\n开通时的界面语言：en-US')
    expect(ownerProfileMarkdown({ preferredName: '小明', about: '做设计', language: 'zh-CN' })).toBe('做设计\n\n称呼：小明\n开通时的界面语言：zh-CN')
  })
  it('记忆文件是 Claude Code 的记忆格式:name 是主人看得懂的短标题', () => {
    const file = ownerProfileMemoryFile('- 称呼：小明')
    expect(file.startsWith('---\nname: 基本信息\n')).toBe(true)
    expect(file).toContain('type: user')
    expect(file.trimEnd().endsWith('- 称呼：小明')).toBe(true)
  })
  it('索引补一行,已有就不重复,没有索引就新建', () => {
    expect(withOwnerProfileIndex(null)).toBe(`${OWNER_PROFILE_INDEX_LINE}\n`)
    const existing = '- [暗号](code.md) — 暗号是香蕉\n'
    const once = withOwnerProfileIndex(existing)
    expect(once).toBe(`${existing}${OWNER_PROFILE_INDEX_LINE}\n`)
    expect(withOwnerProfileIndex(once)).toBe(once)
  })
})

describe('ASSISTANT_FIRST_TASK', () => {
  it('幂等(已有 today.json 就什么都不做)、先读「关于主人」再开口', () => {
    expect(ASSISTANT_FIRST_TASK).toContain('已经有 today.json 就是初始化过了')
    expect(ASSISTANT_FIRST_TASK).toContain('owner-profile.md')
    expect(ASSISTANT_FIRST_TASK.indexOf('owner-profile.md')).toBeGreaterThan(ASSISTANT_FIRST_TASK.indexOf('schedule_create'))
  })
})

describe('ASSISTANT_FIRST_TASK opening (#7349, dots-style)', () => {
  it('keeps the confirmed name, points to settings and offers one concrete thing', () => {
    expect(ASSISTANT_FIRST_TASK).not.toContain('想给我起个名字吗')
    expect(ASSISTANT_FIRST_TASK).toContain('名字已经在开通时确认')
    expect(ASSISTANT_FIRST_TASK).toContain('在设置里修改名字和样子')
    expect(ASSISTANT_FIRST_TASK).toContain('挑一件现在就能帮上的具体事情')
    expect(ASSISTANT_FIRST_TASK.indexOf('名字已经在开通时确认')).toBeLessThan(ASSISTANT_FIRST_TASK.indexOf('挑一件'))
  })
})
