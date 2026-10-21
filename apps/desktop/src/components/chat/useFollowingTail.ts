import { useCallback, useEffect, useState, type RefObject } from 'react'

/**
 * @@@6352 「读者在底部」是一个电平,不是一次事件。
 *
 * 列表的 onAtBottomChange 只在它自己的判断翻转时发一次。以前在这个回调里就地和
 * 「未读定位进行中 / 窗口之外还有更新 / 正在翻页」取与再写进窗口:回调那一刻只要有一道门挡着,
 * 这次读数就作废,门打开之后也没有第二次 —— 读者一直停在底部,列表不会再发。
 * 窗口于是一直以为读者在翻历史,下一条自己发的消息被当作跳出窗口:行被裁掉、回到最新页、
 * 整张列表重挂(owner 报的「发一条消息整个消息流闪一下」)。
 *
 * 所以这里只存电平,「跟随尾部」= 电平 ∧ 各道门都开着,任何一项变化都重算。
 * 电平按列表的 resetKey 归属:换会话 / 回到最新页时列表重挂并从 LAST 打开,
 * 在它报出第一次读数之前沿用「在底部」。
 */
export function useFollowingTail({
  resetKey,
  unreadNavigationPending,
  hasNewer,
  loading,
  isPreservingPosition,
  isAtBottomRef,
  setFollowingTail,
}: {
  resetKey: string
  unreadNavigationPending: boolean
  hasNewer: boolean
  loading: boolean
  isPreservingPosition: () => boolean
  isAtBottomRef: RefObject<boolean>
  setFollowingTail: (following: boolean) => void
}): { viewportAtBottom: boolean; onAtBottomChange: (atBottom: boolean) => void } {
  const [level, setLevel] = useState({ resetKey, atBottom: true })
  const viewportAtBottom = level.resetKey === resetKey ? level.atBottom : true
  // The level records every report, including those made while a saved position is restored: dropping
  // them left the level at its default and a later gate flip pinned a reader who was reading history.
  const onAtBottomChange = useCallback((atBottom: boolean) => setLevel({ resetKey, atBottom }), [resetKey])
  const following = viewportAtBottom && !unreadNavigationPending && !hasNewer && !loading
  useEffect(() => {
    // @@@sticky-pin (#667) - while a saved position is restored the restore owns following (it ends with
    // false itself); the list's at-bottom reading is transient in the meantime.
    if (isPreservingPosition()) return
    isAtBottomRef.current = following
    // @@@chat-window (#504) - tell the store whether we're pinned to the tail so it can trim the window.
    setFollowingTail(following)
  }, [following, isPreservingPosition, isAtBottomRef, setFollowingTail])
  return { viewportAtBottom, onAtBottomChange }
}
