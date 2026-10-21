import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scanSubjectScopedHooks, HOOKS_DIR } from '../../../scripts/subject-scoped-hooks.mjs'

// #3922 —— 状态串台那一族的**登记闸**。
//
// 它不判对错,只要求每个「收主体参数且返回值」的 renderer hook 说出一句「它如何避开这一类」。
// ❌ 不做正确性探测器:让脚本去猜一个 hook 对不对,猜错就是假红,而假红会训练所有人去点重跑。
//
// ⚠️ 扫描用真 AST。第一版用正则扫 `export function use\w+(…): T {`,实测**会静默漏**:
// `useAgentDisplayStatus` 没有返回类型标注(`) {`),非贪婪匹配一路吞到下一个函数的 `): Record<…> {`,
// 把 `useAgentDisplayStatuses` 整个吃掉。一个会漏的名单比没有名单更坏 —— 它给出「已覆盖」的假象,
// 而那正是本闸要防的那类错误本身。

const ROOT = resolve(__dirname, '../../..')
const REGISTRY_PATH = resolve(ROOT, 'scripts/subject-scoped-hook-registry.json')
const HOW = new Set(['subject-scoped', 'keyed-map', 'derived', 'no-own-state'])

const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as Record<string, { how: string; why: string }>
const registered = Object.keys(registry).filter((k) => k !== '_')
const found = scanSubjectScopedHooks(ROOT)

const HOWTO = [
  '',
  `${HOOKS_DIR} 下出现了「收主体参数且返回值」的新 hook。这一族有过三次实例(#3911 / #3921 / #3922):`,
  '状态只能在副作用里追上主体参数,而副作用落在绘制之后 ⇒ 切换那一刻,「上一个主体的答案」会被消费方',
  '盖上「当前主体的身份」,造出一条看起来完全合法的假事实 —— 下游门控识别不了它。',
  '',
  '请在 scripts/subject-scoped-hook-registry.json 里登记它,并写清 how / why:',
  '  subject-scoped —— 状态与它描述的主体一起存,主体不符时交出「还不知道」',
  '  keyed-map      —— 结果按 key 存 map,取用**当前参数**算出的 key',
  '  derived        —— 没有自有 state,值全部由下游 hook 当场派生',
  '  no-own-state   —— 只有 ref / useMemo,不承载「关于某个主体的读数」',
].join('\n')

describe('#3922 主体作用域 hook 登记闸', () => {
  it('[阳控] 扫描器确实扫到了东西,而且包含已知的那几个 —— 空名单不算通过', () => {
    expect(found.length, '扫描器返回空 = 仪器坏了,不是「没有这类 hook」').toBeGreaterThan(5)
    // 这三个是已知实例;少了任何一个说明扫描器又开始漏了(正则版正是漏在 useAgentDisplayStatuses 上)。
    for (const known of [
      `${HOOKS_DIR}/useSessionpageAgentProjection.ts::useSessionpageAgentProjection`,
      `${HOOKS_DIR}/useAgentDisplayStatus.ts::useAgentDisplayStatuses`,
    ]) {
      expect(found, `[阳控] 扫描器必须能看见 ${known}`).toContain(known)
    }
  })

  it('每个都已登记「它如何避开这一类」', () => {
    const unregistered = found.filter((h) => !registered.includes(h))
    expect(unregistered, `未登记:${JSON.stringify(unregistered, null, 2)}${HOWTO}`).toEqual([])
  })

  it('登记表里没有已经消失的条目(名单要跟着代码走)', () => {
    const stale = registered.filter((h) => !found.includes(h))
    expect(stale, `这些登记项在代码里已不存在,请删掉:${JSON.stringify(stale, null, 2)}`).toEqual([])
  })

  it('每条登记都说了 how 和 why —— ❌ 不接受空理由', () => {
    const bad = registered.filter((h) => !HOW.has(registry[h]?.how) || !(registry[h]?.why ?? '').trim())
    expect(bad, `how 不在允许取值内、或 why 为空:${JSON.stringify(bad, null, 2)}`).toEqual([])
  })
})
