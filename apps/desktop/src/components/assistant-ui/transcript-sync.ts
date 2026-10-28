import type { TranscriptTurn } from '@gugu/session-core/acp/client'

/**
 * 一份完整的时间线(`TranscriptTurn[]`,按序)怎么喂给一个 ChatState:最后一轮还没收尾(没有 `outcome`)
 * 就是正在进行的那一轮(`activeTurn`),其余都是定稿的历史。
 */
export function splitActiveTurn(turns: readonly TranscriptTurn[]): { settled: readonly TranscriptTurn[]; active: TranscriptTurn | null } {
  const last = turns.at(-1)
  return last && !last.outcome ? { settled: turns.slice(0, -1), active: last } : { settled: turns, active: null }
}

export type HistorySync =
  | { op: 'none' }
  | { op: 'append'; turns: readonly TranscriptTurn[] }
  | { op: 'prepend'; turns: readonly TranscriptTurn[] }
  | { op: 'seed'; turns: readonly TranscriptTurn[] }

/**
 * 上一次写进去的定稿历史 → 这一次的,用最省的那一步:只在末尾多了(新收尾的轮)就 append,只在开头多了
 * (往前翻)就 prepend,其余(某一轮被改写、被删)才整份 seed。按**引用**比:时间线没变的轮保持同一个对象,
 * 转录的缓存也按引用认它们。
 */
export function planHistorySync(prev: readonly TranscriptTurn[], next: readonly TranscriptTurn[]): HistorySync {
  if (prev === next) return { op: 'none' }
  if (prev.length === 0) return next.length === 0 ? { op: 'none' } : { op: 'seed', turns: next }
  if (next.length >= prev.length) {
    if (prev.every((turn, i) => turn === next[i])) {
      return next.length === prev.length ? { op: 'none' } : { op: 'append', turns: next.slice(prev.length) }
    }
    const offset = next.length - prev.length
    if (prev.every((turn, i) => turn === next[offset + i])) return { op: 'prepend', turns: next.slice(0, offset) }
  }
  return { op: 'seed', turns: next }
}
