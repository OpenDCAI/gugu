import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { notify } from '../lib/notices'
import { NoticeHost } from './NoticeHost'
import { ToastContext, type ToastType } from './toastContext'

/**
 * 主 app 沿用的入口:`toast(message, type)` 不变(130 多处调用不动),但不再自己画 ——
 * 一律交给 lib/notices,落到 `<NoticeHost/>` 那一个提示条上(#137)。
 * 档位、停留时长与「要读的两档带关闭钮」都在 notices / toastTiers 里,❌ 别在这里再抄一份(#4891)。
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation('common')
  const value = useMemo(
    () => ({
      toast: (message: string, type: ToastType = 'info') => {
        notify({ title: message, tier: type })
      },
    }),
    []
  )
  return (
    <ToastContext.Provider value={value}>
      {/* 排在子树前面:它的订阅要比子组件挂载时发的第一条提示先就位(effect 按兄弟顺序跑)。 */}
      <NoticeHost closeLabel={t('toast.dismiss')} />
      {children}
    </ToastContext.Provider>
  )
}
