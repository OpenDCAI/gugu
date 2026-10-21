// @@@5813 更新说明的"入口",不是它的"界面" —— 界面在官网上那一页。
//
// 它不画任何东西:装完新版第一次打开时把人带过去一次,以及「设置 → 关于」那一行点了带过去。
// 挂在 App 根上,因为「第一次打开」这件事的判断要在应用起来的时候就发生一次。
//
// 这里原先是一个 400 行的弹窗:自己一套极简 markdown 渲染器、自己一条历史清单、
// 自己一份本机缓存。owner 2026-09-18:「之前硬编码一拖还不改吗」—— 内容有了自己的家之后,
// 应用再留一套画法就是第二份现实,两边迟早对不上。
import { useEffect } from 'react'
import { useReleaseNotes } from '../hooks/useReleaseNotes'
import { UI_EVENTS } from '../lib/uiEvents'

export function ReleaseNotesOpener() {
  const { open } = useReleaseNotes()

  useEffect(() => {
    window.addEventListener(UI_EVENTS.openReleaseNotes, open)
    return () => window.removeEventListener(UI_EVENTS.openReleaseNotes, open)
  }, [open])

  return null
}
