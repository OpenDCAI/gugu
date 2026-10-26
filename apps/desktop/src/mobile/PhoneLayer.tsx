import type { ReactNode } from 'react'
import { RETAINED_SURFACE_HIDDEN_STYLE } from '@/lib/retainedSurface'

/**
 * 手机上推在「消息 / 伙伴」首页上的一层(咕咕、项目、我的;owner 10-26,OpenDCAI/gugu#446):整屏盖住分页器、没有底栏,
 * 返回回到推它之前那一格。不在最上面时常驻只藏(lib/retainedSurface.ts):草稿、滚动位置、各自往下钻的层级都在,
 * 同从前它们是分页器里的一页。
 */
export function PhoneLayer({ open, testId, children }: { open: boolean; testId?: string; children: ReactNode }) {
  return (
    <div data-phone-layer="" data-open={open || undefined} data-testid={testId} style={open ? undefined : RETAINED_SURFACE_HIDDEN_STYLE}>
      {children}
    </div>
  )
}
