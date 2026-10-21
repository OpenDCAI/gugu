import { describe, expect, it } from 'vitest'
import { followAnchor, pinDelta } from '@/mobile/agent-watch/load-older-on-top'

/**
 * #6726 往上翻到顶自动载入更早的轮次后,读者正看着的那一行要回到原处。
 * 判据喂合成的「翻页前位置 / 翻页后位置」,每条都构造得出必失败条件。
 */
describe('翻页后把读者正看着的那一行钉回原处', () => {
  const anchor = { id: 'u5', top: 16 }

  it('锚点那一行被新的一页往下推了多少,视口就跟着挪多少', () => {
    expect(pinDelta(anchor, (id) => (id === 'u5' ? 755 : null))).toBe(739)
  })

  it('原生锚定已经钉住了(位置没变)就是 0,不再挪', () => {
    expect(pinDelta(anchor, () => 16)).toBe(0)
  })

  it('认不出那一行就不动(null),❌ 猜一个位置', () => {
    expect(pinDelta(anchor, () => null)).toBeNull()
  })
})

/** #6952 请求在路上时手指还在拖:钉回的要是插入前一刻读者看着的位置,❌ 发请求那一刻的。 */
describe('新的一页落地之前,锚跟着读者走', () => {
  const pending = { firstId: 'u1', row: { id: 'u3', top: 40 } }

  it('新的一页还没进来(第一行没变):换成读者此刻看着的那一行', () => {
    expect(followAnchor(pending, [{ id: 'u1', top: -300 }, { id: 'a2', top: -20 }, { id: 'u3', top: 63 }])).toEqual({ id: 'u3', top: 63 })
  })

  it('新的一页已经在 DOM 里(第一行换了):不换,留给钉位去用', () => {
    expect(followAnchor(pending, [{ id: 'u0', top: -3000 }, { id: 'u1', top: 3400 }, { id: 'u3', top: 3763 }])).toBe(pending.row)
  })

  it('视口里一行都没有起头的:留着原来的锚', () => {
    expect(followAnchor(pending, [{ id: 'u1', top: -300 }])).toBe(pending.row)
  })
})
