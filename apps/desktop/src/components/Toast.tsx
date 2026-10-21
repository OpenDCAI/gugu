import { useCallback, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useTranslation } from 'react-i18next'
import { X } from '../lib/icons'
import { IconButton } from './ui/IconButton'
import { ToastContext, type ToastType } from './toastContext'
import { TOAST_DWELL_MS, isReadableTier } from '../lib/toastTiers'
import { AUTOMATION_TEST_IDS } from '../lib/automationDom'
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion'
import { DUR_MED_MS, tween } from '../styles/motion'

interface ToastItem {
  id: number
  message: string
  type: ToastType
}

let _id = 0

const TYPE_COLORS: Record<ToastType, string> = {
  success: 'var(--toast-success)',
  error:   'var(--toast-error)',
  warning: 'var(--toast-warning)',
  info:    'var(--toast-info)',
}

// 停留时长与「哪几档要读」都从 `../lib/toastTiers` 读,与会话页同一张表。
// ❌ 别在这里再抄一份:抄一次就会漂一次,而漂了没有人会发现(#4891)。

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation('common')
  const [items, setItems] = useState<ToastItem[]>([])
  const reduceMotion = usePrefersReducedMotion()

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((item) => item.id !== id))
  }, [])

  const toast = useCallback((message: string, type: ToastType = 'info') => {
    const id = ++_id
    setItems((prev) => [...prev, { id, message, type }])
    setTimeout(() => dismiss(id), TOAST_DWELL_MS[type])
  }, [dismiss])

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div
        style={{
          position: 'fixed',
          // 顶栏右上是「动作车道」(会话页的分享/面板开关就常驻在那儿)。toast 是转瞬的反馈,
          // 不该压在常驻控件上 —— 两边都读同一个 token,❌ 各自拍一个 top 值(那就是实机看到的
          // 「组件堆叠」:toast 正好盖住会话页顶栏那排按钮)。
          top: 'calc(var(--titlebar-actions-lane) + 8px)',
          right: 16,
          // toast 是全局最顶层反馈,必须压过图片预览遮罩(10000),否则复制/下载的结果提示被盖住 (#1892)
          zIndex: 'var(--z-toast)',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          pointerEvents: 'none',
        }}
      >
        <AnimatePresence>
          {items.map((item) => (
            <motion.div
              key={item.id}
              data-testid={AUTOMATION_TEST_IDS.toastItem}
              data-toast-type={item.type}
              initial={reduceMotion ? false : { opacity: 0, x: 60, scale: 0.95 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={reduceMotion ? undefined : { opacity: 0, x: 60, scale: 0.95 }}
              transition={tween(reduceMotion ? 0 : DUR_MED_MS)}
              style={{
                background: 'var(--surface-white)',
                borderRadius: 'var(--radius-surface)',
                boxShadow: 'var(--shadow-toast-card)',
                padding: '10px 16px',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 'var(--font-body)',
                lineHeight: 'var(--lh-body)',
                color: 'var(--text-on-white)',
                minWidth: 200,
                maxWidth: 320,
                // 成功/提示纯展示 → 点击穿透。toast 在全局最顶层(10010)且定位在右上角,
                // 与图片预览工具栏同坐标,若吃掉点击会把下面的按钮挡住整整一个停留周期。
                // 失败/告警反过来必须接指针:要能选中复制,也要能在挡路时当场关掉 ——
                // 停留时长翻倍(6s/5s)之后,「不可关闭」比「短暂遮挡」更难受(#4891)。
                pointerEvents: isReadableTier(item.type) ? 'auto' : 'none',
                userSelect: isReadableTier(item.type) ? 'text' : 'none',
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 'var(--radius-circle)',
                  background: TYPE_COLORS[item.type],
                  flexShrink: 0,
                }}
              />
              {item.message}
              {isReadableTier(item.type) && (
                <IconButton
                  aria-label={t('toast.dismiss')}
                  size="sm"
                  onClick={() => dismiss(item.id)}
                  data-testid={AUTOMATION_TEST_IDS.toastDismiss}
                >
                  <X />
                </IconButton>
              )}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  )
}
