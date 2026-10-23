import { useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { Toaster } from 'sonner'
import { readEffectiveHostTheme, subscribeToHostTheme } from '@renderer/lib/theme/host-theme'
import './notice-host.css'

const CLAIM = 'noticeHost'
const RELEASED = 'gugu:notice-host-released'

/**
 * 全 app 唯一的提示条(#137):右下角,所有提示(主 app 的、会话页的、同 key 原地更新的)都画在这一处。
 *
 * sonner 的状态是全窗口一份,挂两个就会每条画两遍 ——「谁来画」是这里认领的:
 * 同一个文档里先挂上的那个画,后到的什么也不画;画的那个卸载了,留着的接着认领(不然提示条凭空消失)。
 * 认领记在 `<html>` 上而不是模块变量里,因为两个入口各是各的 bundle,模块变量不跨入口。
 */
export function NoticeHost({ closeLabel }: { closeLabel?: string }) {
  // 主题真值读全局订阅,❌ 读 React 上下文:会话页是另一棵根,拿不到主 app 的 ThemeContext。
  const theme = useSyncExternalStore(subscribeToHostTheme, readEffectiveHostTheme, () => 'light' as const)
  const [owner, setOwner] = useState(false)
  useLayoutEffect(() => {
    const root = document.documentElement
    let owned = false
    const claim = () => {
      if (owned || root.dataset[CLAIM]) return
      root.dataset[CLAIM] = 'true'
      owned = true
      setOwner(true)
    }
    claim()
    document.addEventListener(RELEASED, claim)
    return () => {
      document.removeEventListener(RELEASED, claim)
      if (!owned) return
      delete root.dataset[CLAIM]
      document.dispatchEvent(new Event(RELEASED))
    }
  }, [])
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
