import { beforeEach, expect, it, vi } from 'vitest'

const control = vi.hoisted(() => ({ error: null as { message: string } | null }))
const query = vi.hoisted(() => ({
  select: vi.fn(), order: vi.fn(), range: vi.fn(), ilike: vi.fn(), gte: vi.fn(), lt: vi.fn(),
}))
const rpc = vi.hoisted(() => vi.fn(async () => ({ data: [], error: null })))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  dataClient: { schema: () => ({ from: () => query, rpc }) },
}))
import { fetchCreditDays, fetchLedgerPage } from '../../../../apps/desktop/src/lib/usage/cloud'

beforeEach(() => {
  vi.clearAllMocks()
  control.error = null
  for (const key of ['select', 'order', 'range', 'ilike', 'gte', 'lt'] as const) query[key].mockReturnValue(query)
  Object.assign(query, { then: (resolve: (value: unknown) => unknown) => Promise.resolve(resolve({ data: [], count: 0, error: control.error })) })
})
const options = { page: 2, pageSize: 20, model: null, range: { from: '2026-10-01', to: '2026-10-30' } }

it('明细按用户本地日起止筛选，并保留分页', async () => {
  await fetchLedgerPage(options)
  expect(query.gte).toHaveBeenCalledWith('created_at', new Date(2026, 9, 1).toISOString())
  expect(query.lt).toHaveBeenCalledWith('created_at', new Date(2026, 9, 31).toISOString())
  expect(query.range).toHaveBeenCalledWith(20, 39)
})

it('模型筛选仍按字面量转义百分号和下划线', async () => {
  await fetchLedgerPage({ ...options, model: 'a%_b' })
  expect(query.ilike).toHaveBeenCalledWith('model', '%a\\%\\_b%')
})

it('明细失败仍抛出原错误，不冒充空记录', async () => {
  control.error = { message: 'ledger offline' }
  await expect(fetchLedgerPage(options)).rejects.toThrow('ledger offline')
})

it('积分汇总使用同一组本地日边界，仍然没有设备参数', async () => {
  await fetchCreditDays(options.range.from, options.range.to, 'Asia/Shanghai')
  expect(rpc).toHaveBeenCalledWith('my_daily_credit_usage', {
    p_from: new Date(2026, 9, 1).toISOString(), p_to: new Date(2026, 9, 31).toISOString(), p_tz: 'Asia/Shanghai',
  })
})
