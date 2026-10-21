import { useCallback, useEffect, useState } from 'react'
import type { CreditUsageDay, UsageDay } from '@gugu/core/shared/usage/dailyUsage'
import { fetchCreditDays, fetchUsageDays, fetchUsageDevices, type UsageDevice } from '../../lib/usage/cloud'
import { HEATMAP_DAYS, addDays, localDay } from '../../lib/usage/derive'
import { canSyncLocalUsage, syncLocalUsage } from '../../lib/usage/sync'

/**
 * 两页各取各的:「活跃」取会话/token 汇总与设备清单,「用量」取积分。
 * 一条挂了只让它那几段说「取不到」,❌ 不把整页吞掉,更❌ 不把失败画成 0 ——
 * 一次网络抖动长得像「你这一年什么都没干」,那是编造出来的事实(同 #2503)。
 */
export type Loadable<T> = { status: 'loading' } | { status: 'error'; error: string } | { status: 'ready'; value: T }

export type UsageData = {
  today: string
  usage: Loadable<UsageDay[]>
  /** 一年档的对照段(再往前一年),只在选中一年档时才取。 */
  previousYear: Loadable<{ usage: UsageDay[] }> | null
  devices: UsageDevice[]
  /** 本机正在把最新数据送上云端;送完会自动再取一次。 */
  syncing: boolean
  syncError: string | null
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** 近一年(热力图要满一年)的起点。 */
function yearFrom(today: string): string {
  return addDays(today, -(HEATMAP_DAYS - 1))
}

/** 「活跃」页:会话/token 汇总(跨设备)与设备清单。 */
export function useUsageData({ userId, deviceId, wantPreviousYear }: { userId: string | null; deviceId: string | null; wantPreviousYear: boolean }): UsageData {
  const [today] = useState(() => localDay(new Date()))
  const [revision, setRevision] = useState(0)
  const [usage, setUsage] = useState<Loadable<UsageDay[]>>({ status: 'loading' })
  const [previousYear, setPreviousYear] = useState<UsageData['previousYear']>(null)
  const [devices, setDevices] = useState<UsageDevice[]>([])
  const [syncing, setSyncing] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)
  const from = yearFrom(today)

  // 打开页面就先把这台机器的最新数据送上去,送完再取一遍 —— 否则刚跑完的会话要等半小时才出现。
  useEffect(() => {
    if (!userId || !canSyncLocalUsage()) return
    let alive = true
    setSyncing(true)
    syncLocalUsage({ force: true })
      .then(() => { if (alive) { setSyncError(null); setRevision((r) => r + 1) } })
      .catch((e: unknown) => { if (alive) setSyncError(message(e)) })
      .finally(() => { if (alive) setSyncing(false) })
    return () => { alive = false }
  }, [userId])

  useEffect(() => {
    if (!userId) return
    let alive = true
    fetchUsageDays(from, today, deviceId)
      .then((value) => { if (alive) setUsage({ status: 'ready', value }) })
      .catch((e: unknown) => { if (alive) setUsage({ status: 'error', error: message(e) }) })
    fetchUsageDevices()
      .then((value) => { if (alive) setDevices(value) })
      .catch(() => { /* 设备筛选只是锦上添花:取不到就只剩「所有设备」,不单独报错 */ })
    return () => { alive = false }
  }, [userId, deviceId, from, today, revision])

  const loadPreviousYear = useCallback(() => {
    const prevTo = addDays(today, -365)
    const prevFrom = addDays(prevTo, -364)
    setPreviousYear({ status: 'loading' })
    return fetchUsageDays(prevFrom, prevTo, deviceId)
      .then((u) => setPreviousYear({ status: 'ready', value: { usage: u } }))
      .catch((e: unknown) => setPreviousYear({ status: 'error', error: message(e) }))
  }, [today, deviceId])

  useEffect(() => {
    if (!userId || !wantPreviousYear) return
    void loadPreviousYear()
  }, [userId, wantPreviousYear, loadPreviousYear, revision])

  return { today, usage, previousYear: wantPreviousYear ? previousYear : null, devices, syncing, syncError }
}

/**
 * 「用量」页:积分按天 × 模型(账户级,与设备无关),外加所有设备的用量汇总 ——
 * 统计条的「总 Token 数」取其中走咕咕模型的那部分,与「活跃」页同一个数。
 */
export function useCreditData(userId: string | null): { today: string; credits: Loadable<CreditUsageDay[]>; usage: Loadable<UsageDay[]> } {
  const [today] = useState(() => localDay(new Date()))
  const [credits, setCredits] = useState<Loadable<CreditUsageDay[]>>({ status: 'loading' })
  const [usage, setUsage] = useState<Loadable<UsageDay[]>>({ status: 'loading' })
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const from = yearFrom(today)
  useEffect(() => {
    if (!userId) return
    let alive = true
    fetchCreditDays(from, today, timeZone)
      .then((value) => { if (alive) setCredits({ status: 'ready', value }) })
      .catch((e: unknown) => { if (alive) setCredits({ status: 'error', error: message(e) }) })
    fetchUsageDays(from, today, null)
      .then((value) => { if (alive) setUsage({ status: 'ready', value }) })
      .catch((e: unknown) => { if (alive) setUsage({ status: 'error', error: message(e) }) })
    return () => { alive = false }
  }, [userId, from, today, timeZone])
  return { today, credits, usage }
}
