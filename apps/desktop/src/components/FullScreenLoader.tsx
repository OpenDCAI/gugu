import { useTranslation } from 'react-i18next'
import { useLayoutEffect, useSyncExternalStore } from 'react'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { retainStartupMotion, hasStartupMotion, subscribeStartupMotion } from '@/lib/startup-motion'

/**
 * 冷启动那一屏 —— 会话恢复期（`session.status === 'boot-restoring'`）挡在主界面前的整屏。
 *
 * Startup continues the same wordmark animation which HTML already started.
 * 等待指示仍复用 LoadingIndicator；消息、局部与文件加载不增加品牌标识。
 */
export function FullScreenLoader({ showLogo = true }: { showLogo?: boolean }) {
  const { t } = useTranslation('main')
  const active = useSyncExternalStore(subscribeStartupMotion, hasStartupMotion, () => false)
  const continuingStartup = showLogo && active
  useLayoutEffect(() => continuingStartup ? retainStartupMotion() : undefined, [continuingStartup])

  return (
    <main
      data-testid="full-screen-loader"
      aria-label={t('shell.loading')}
      aria-busy="true"
      style={{
        minHeight: '100vh',
        position: 'relative',
        display: 'grid',
        placeItems: 'center',
        overflow: 'hidden',
        background: 'var(--bg-primary)',
        color: 'var(--text-primary)',
      }}
    >
      {!continuingStartup && <LoadingIndicator size="page" ariaLabel={t('shell.loading')} />}
    </main>
  )
}
