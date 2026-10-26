import { createContext, useContext } from 'react'
import type { ToastTier } from '../lib/toastTiers'

/**
 * 主 app 沿用的名字,但**不是第二份定义** —— 它就是 `ToastTier`。
 * 档位有几档只在 `../lib/toastTiers` 说一次;这里若写成字面量 union,
 * 加一档时两边会静默不同步(#4891 里会话页少了 warning 就是这么来的)。
 */
export type ToastType = ToastTier

export interface ToastContextValue {
  toast: (message: string, type?: ToastType, description?: string) => void
}

export const ToastContext = createContext<ToastContextValue>({ toast: () => {} })

export function useToast() {
  return useContext(ToastContext)
}
