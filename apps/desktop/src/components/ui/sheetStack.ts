import { useCallback, useLayoutEffect, useRef } from 'react'

// 盖在页面上的层(Sheet、看图、菜单、手机整页、多选态),按打开顺序(挂载入栈、卸载出栈)。Escape 与安卓返回键
// 都只交给栈顶那一层,所以子层不会在同一次按键里把父层也关掉。
export const sheetStack: symbol[] = []

export const NATIVE_BACK_EVENT = 'gugu:native-back'

/**
 * 安卓返回键 = 栈顶那一层自己的返回(同它左上返回 / 取消 / Escape)。页面那一层(MainLayout)
 * 的返回键处理先问这一句,有层开着就不动下面的页面 —— 否则层还开着、底下已经退回了列表(或整个 App 退出)。
 * 不靠监听器谁先注册谁先跑:安卓 WebView(Chrome 113 实测)在 window 上不按 capture 先于 bubble 排序。
 */
export function isSheetOpen(): boolean {
  return sheetStack.length > 0
}

/**
 * 在 `active` 期间进栈,栈顶时安卓返回键调 `onBack` 并告诉原生「已处理」。返回「此刻是不是栈顶」,
 * 给同一层的 Escape 用。`onBack` 取最新的那个,❌ 因为它换了引用就出栈再入栈(那会把它挪到栈顶)。
 * 提交时就进栈(layout effect):层一画出来就接得住返回键,没有「已提交、还没登记」的那一帧。
 */
export function useBackLayer(onBack: (() => void) | undefined, active = true): () => boolean {
  const idRef = useRef<symbol>(undefined)
  if (!idRef.current) idRef.current = Symbol('back-layer')
  const onBackRef = useRef(onBack)
  onBackRef.current = onBack
  const on = active && Boolean(onBack)
  useLayoutEffect(() => {
    if (!on) return
    const id = idRef.current!
    sheetStack.push(id)
    const handleNativeBack = () => {
      if (sheetStack[sheetStack.length - 1] !== id) return
      ;(window as Window & { __guguNativeBackHandled?: boolean }).__guguNativeBackHandled = true
      onBackRef.current?.()
    }
    window.addEventListener(NATIVE_BACK_EVENT, handleNativeBack)
    return () => {
      window.removeEventListener(NATIVE_BACK_EVENT, handleNativeBack)
      const index = sheetStack.indexOf(id)
      if (index >= 0) sheetStack.splice(index, 1)
    }
  }, [on])
  return useCallback(() => sheetStack[sheetStack.length - 1] === idRef.current, [])
}
