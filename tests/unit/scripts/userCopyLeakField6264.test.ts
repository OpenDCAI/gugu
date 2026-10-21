import { describe, expect, it } from 'vitest'
import { countSource } from '../../../scripts/user-copy-leak-check.mjs'

const field = (source: string, file = 'host.ts'): number => countSource(source, file).field

// #6264 d22 真机:宿主把 model-access 的 503 原文装进 `catalogError`,经 IPC 画进新建任务的工具栏。
// 前两条规则看不见它 —— 词条里没有 `{{error}}`,也不是 toast。第三条在「装进去」那一刻认。
describe('copy-leaks-raw-error-field', () => {
  it('catches the exact shape that leaked', () => {
    expect(field('let catalogError = null\ntry {} catch (error) { catalogError = (error as Error).message }')).toBe(1)
    expect(field("const meta = { available: false, reason: error instanceof Error ? error.message : String(error) }")).toBe(1)
    expect(field("p.catch((cause: unknown) => { setCatalogError((cause as Error).message) })", 'pane.tsx')).toBe(1)
    expect(field('const out = { guguReason: err.message }')).toBe(1)
  })

  it('leaves logs, codes and ordinary result shapes alone', () => {
    expect(field("log.warn({ reason: error.message }, 'catalog failed')")).toBe(0)
    expect(field("catalogError = guguCatalogReasonCode('service-unavailable')")).toBe(0)
    expect(field('return { ok: false, error: e.message }')).toBe(0)
    expect(field("const reason = t('settings.model.catalogUnavailable')")).toBe(0)
  })
})
