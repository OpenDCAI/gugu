import { useState, type MouseEvent } from 'react'

/**
 * 一条气泡上手机长按的两段状态:菜单开过一次就一直挂着(收起要播完退场动画,由 open 开合);
 * 「选择文本」期间气泡放开选字。
 */
export function usePhoneMessageMenu(open: boolean) {
  const [mounted, setMounted] = useState(false)
  const [selecting, setSelecting] = useState(false)
  if (open && !mounted) setMounted(true)
  return { mounted, selecting, setSelecting }
}

/** 气泡上开菜单的手势:右键 / 系统长按 / 触摸长按都开同一份菜单;选字期间都还给系统(拖把手、改范围)。 */
export function bubbleMenuGestures<T extends object>(longPress: T, openAt: (x: number, y: number) => void, selecting: boolean) {
  if (selecting) return {}
  return {
    ...longPress,
    onContextMenu: (event: MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
      openAt(event.clientX, event.clientY)
    },
  }
}
