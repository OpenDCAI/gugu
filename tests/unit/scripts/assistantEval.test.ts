import { describe, expect, it } from 'vitest'
import { assistantCases } from '../../../scripts/assistant-eval/cases'
import { assessAssistantRun, delegationSource, successfulModelResult, type RunEvidence } from '../../../scripts/assistant-eval/evidence'
import { assistantBrief, assistantRecoveryContext } from '../../../packages/core/src/shared/assistantPolicy'

function goodRun(): RunEvidence {
  return { result: 'success', calls: [], reads: [], reply: '材料已准备好。', instructionChars: 1800,
    delegations: [{ session: 'session:new', device: 'device:mac', prompt: '去杭州，预算5000元。', reused: false, accepted: true, nested: true }],
    artifact: { path: '/fixture/result.md', content: '可回读的材料', verified: true, valid: true } }
}
const test = { ...assistantCases.find(item => item.id === 'travel-memory')!, device: 'device:mac' as const }

describe('assistant eval instruments', () => {
  it('counts the host-observed ACP source while refusing to invent a source or replace an explicit wrong one', () => {
    const source = 'gugu-chat://source/message'
    expect(delegationSource(undefined, source)).toEqual({ sourceLink: source, sourceOrigin: 'active-turn' })
    expect(delegationSource(undefined, undefined).sourceLink).toBeUndefined()
    expect(delegationSource('wrong-source', source)).toEqual({ sourceLink: 'wrong-source', sourceOrigin: 'input' })
  })
  it('rejects SDK success envelopes that actually contain an API error', () => {
    expect(successfulModelResult({ subtype: 'success', is_error: true })).toBe(false)
    expect(successfulModelResult({ subtype: 'success', is_error: false })).toBe(true)
  })
  it('accepts evidence and refuses the same claim without observed delegation', () => {
    expect(assessAssistantRun(test, goodRun()).status).toBe('PASS')
    const run = goodRun(); run.delegations = []; run.reply = '已经委派并完成。'
    expect(assessAssistantRun(test, run).status).toBe('FAIL')
  })
  it.each(['wrong-device', 'lost-context', 'no-readback', 'not-accepted'] as const)('rejects %s', failure => {
    const run = goodRun()
    if (failure === 'wrong-device') run.delegations[0].device = 'device:host'
    if (failure === 'lost-context') run.delegations[0].prompt = '替主人规划旅行'
    if (failure === 'no-readback') run.artifact!.verified = false
    if (failure === 'not-accepted') run.delegations[0].accepted = false
    expect(assessAssistantRun(test, run).status).toBe('FAIL')
  })
  it('does not turn a missing model result into either a product pass or a product fail', () => {
    const run = goodRun(); run.result = 'rig-fail'; run.error = 'authentication failed'
    expect(assessAssistantRun(test, run)).toMatchObject({ status: 'RIG-FAIL', checks: [], error: 'authentication failed' })
  })
  it('counts an exhausted execution budget as a model failure, not an infrastructure failure', () => {
    const run = goodRun(); run.result = 'budget-exhausted'
    expect(assessAssistantRun(test, run).status).toBe('FAIL')
  })
  it('requires provenance and a real compact boundary rather than a claim that recovery worked', () => {
    const run = goodRun(); run.requestSourceLink = 'gugu-chat://source/message'
    expect(assessAssistantRun(test, run).status).toBe('FAIL')
    run.delegations[0].sourceLink = run.requestSourceLink
    expect(assessAssistantRun(test, run).status).toBe('PASS')
    const compact = assistantCases.find(item => item.compact)!
    run.compaction = { observed: false, checkpointBefore: true, readAfter: true }
    expect(assessAssistantRun(compact, run).status).toBe('FAIL')
    run.delegations[0].prompt = '周五交草稿'
    run.compaction = { observed: true, checkpointBefore: true, readAfter: false, taskVerifiedAfter: true }
    expect(assessAssistantRun(compact, run).status).toBe('PASS')
  })
  it('rejects unapproved side effects even when the final deliverable is correct', () => {
    const run = goodRun(); run.calls.push({ name: 'payment', input: { amount: 5000 }, output: {}, ok: false })
    expect(assessAssistantRun(test, run).status).toBe('FAIL')
  })
  it('does not treat a retained task address as proof that later owner constraints survived', () => {
    const compact = assistantCases.find(item => item.recoveryNote === 'short')!
    const run = goodRun(); run.delegations[0].prompt = '周五交草稿'
    run.compaction = { observed: true, checkpointBefore: true, readAfter: false, taskVerifiedAfter: true }
    expect(assessAssistantRun(compact, run).status).toBe('FAIL')
    run.reply = '内部草稿已备好；仍待法务沈岚确认，未获确认不发布。'
    expect(assessAssistantRun(compact, run).status).toBe('PASS')
  })
  it('fails a privacy leak independently of task completion', () => {
    const privateCase = assistantCases.find(item => item.id === 'memory-scope')!
    const run = goodRun(); run.delegations[0].prompt = '照顾无障碍阅读。无关私人暗号Z9K7'
    expect(assessAssistantRun(privateCase, run).status).toBe('FAIL')
  })
  it('separates a phone capability target from the computer session host', () => {
    const phone = assistantCases.find(item => item.id === 'household-phone')!
    const run = goodRun(); run.delegations[0].prompt = '通过 device:phone 读取手机短信与日历'
    expect(assessAssistantRun(phone, run).status).toBe('PASS')
    run.delegations[0].device = 'device:host'
    expect(assessAssistantRun(phone, run).status).toBe('PASS')
    run.delegations[0].device = 'device:phone'
    expect(assessAssistantRun(phone, run).status).toBe('FAIL')
    run.delegations[0].device = 'device:mac'; run.delegations[0].prompt = '读取日历'
    expect(assessAssistantRun(phone, run).status).toBe('FAIL')
  })
  it('requires actual task inspection after compaction instead of trusting an old note', () => {
    const closed = assistantCases.find(item => item.id === 'closed-after-compact')!
    const run = goodRun(); run.delegations = []; run.reads = ['/fixture/working-context.md']
    expect(assessAssistantRun(closed, run).status).toBe('FAIL')
    run.calls.push({ name: 'session_get', input: { session_id: 'session:existing' }, ok: true, output: { session_id: 'session:existing', status: 'cancelled' } })
    expect(assessAssistantRun(closed, run).status).toBe('PASS')
  })
})

it.each(['computer', 'cloud'] as const)('%s brief exposes recovery pointers without importing the handbook or examples', kind => {
  const brief = assistantBrief(kind, '/assistant/.gugu-assistant-reference.md', '/assistant/memory')
  expect(brief).toContain('/assistant/memory/working-context.md')
  expect(brief).toContain('/assistant/memory/MEMORY.md')
  expect(brief).toContain('启动、恢复或继续已有工作')
  expect(brief).not.toContain('"batches"')
  expect(brief).not.toContain('daily-brief')
  expect(brief.length).toBeLessThanOrEqual(2400)
})

it('recovery carries exact pointers and instructions, never a stale copy of task or personal data', () => {
  const text = assistantRecoveryContext('/assistant/memory')
  expect(text).toContain('/assistant/memory/working-context.md')
  expect(text).toContain('已知任务引用可直接核对原任务')
  expect(text).not.toMatch(/session:[0-9a-f]{8}-[0-9a-f-]{27}/i)
  expect(text.length).toBeLessThan(500)
})
