import { useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { Toaster } from 'sonner'
import { readEffectiveHostTheme, subscribeToHostTheme } from '@renderer/lib/theme/host-theme'
import './notice-host.css'

const CLAIM = 'noticeHost'
const CHANGED = 'gugu:notice-host-changed'
let hostSeq = 0

/**
 * 全 app 唯一的提示条(#137):右下角,所有提示(主 app 的、会话页的、同 key 原地更新的)都画在这一处。
 *
 * sonner 的状态是全窗口一份,挂两个就会每条画两遍 ——「谁来画」是这里认领的:同一个文档里一次只有一个在画,
 * 认领记在 `<html>` 上而不是模块变量里,因为两个入口各是各的 bundle,模块变量不跨入口。
 *  · 先到先得;画的那个卸载了,留着的接着认领(不然提示条凭空消失)。
 *  · 主 app 的比会话页的优先:会话页是主 app 里的一块(平时隐藏在别的页面后面),主 app 重挂(登录 / 登出换了一棵树)时
 *    会话页会先接手,主 app 的新宿主一挂上就从它手里接回来,❌ 让提示条留在一个看不见的宿主里。
 *  · 会话页单独成一个文档(没有主 app)时,由它自己画。
 */
/** 空着就能认领;主 app 的还能从会话页的手里接过来。 */
function canClaim(holder: string | undefined, embedded: boolean): boolean {
  return !holder || (!embedded && holder.startsWith('embedded:'))
}

export function NoticeHost({ closeLabel, embedded = false }: { closeLabel?: string; /** 会话页里的那一份(见上)。 */ embedded?: boolean }) {
  // 主题真值读全局订阅,❌ 读 React 上下文:会话页是另一棵根,拿不到主 app 的 ThemeContext。
  const theme = useSyncExternalStore(subscribeToHostTheme, readEffectiveHostTheme, () => 'light' as const)
  // 能认领就在第一次渲染里就画出来:sonner 的提示条只认它挂上之后发的提示(之前发的不补),
  // 晚一拍才画,同一次挂载里子组件发的提示就丢了。认领本身仍在下面的 layout effect 里做,认不到再收回。
  const [owner, setOwner] = useState(() => canClaim(document.documentElement.dataset[CLAIM], embedded))
  useLayoutEffect(() => {
    const root = document.documentElement
    const me = `${embedded ? 'embedded' : 'app'}:${++hostSeq}`
    let owned = false
    const settle = () => {
      const holder = root.dataset[CLAIM]
      if (owned) {
        // 被主 app 的宿主接走了:放手。
        if (holder !== me) {
          owned = false
          setOwner(false)
        }
        return
      }
      if (!canClaim(holder, embedded)) return setOwner(false)
      root.dataset[CLAIM] = me
      owned = true
      setOwner(true)
      document.dispatchEvent(new Event(CHANGED))
    }
    settle()
    document.addEventListener(CHANGED, settle)
    return () => {
      document.removeEventListener(CHANGED, settle)
      if (!owned || root.dataset[CLAIM] !== me) return
      delete root.dataset[CLAIM]
      document.dispatchEvent(new Event(CHANGED))
    }
  }, [embedded])
  if (!owner) return null
  return (
    <Toaster
      className="gugu-notices"
      position="bottom-right"
      theme={theme}
      toastOptions={closeLabel ? { closeButtonAriaLabel: closeLabel } : undefined}
    />
  )
}
