import { useEffect, useRef, useState } from 'react'

/** @ 候选的高亮、动态列表收敛与键盘滚动保持在同一条状态链。 */
export function useMentionKeyboardSelection(
  query: string,
  popupClosed: boolean,
  candidates: readonly unknown[],
) {
  const [mentionIndex, setMentionIndex] = useState(0)
  const activeMentionOptionRef = useRef<HTMLDivElement>(null)

  // 只认开/关状态，不依赖每次打字都会重建的 range 对象，避免选择中途跳回第一项。
  useEffect(() => { setMentionIndex(0) }, [query, popupClosed])

  // 名册/备注可能在弹层打开时更新；列表缩短后不能留下一个不可见的越界高亮。
  useEffect(() => {
    setMentionIndex((index) => candidates.length === 0 ? 0 : Math.min(index, candidates.length - 1))
  }, [candidates.length])

  // #6722：方向键可以走出首屏；活动行必须随索引滚到最近的可见位置。
  useEffect(() => {
    activeMentionOptionRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [mentionIndex, candidates])

  return { mentionIndex, setMentionIndex, activeMentionOptionRef }
}
