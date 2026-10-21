import { useTranslation } from 'react-i18next'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'

/**
 * 冷启动那一屏 —— 会话恢复期（`session.status === 'boot-restoring'`）挡在主界面前的整屏。
 *
 * 这里只负责「整屏 + 居中 + 主题底色」；加载态本身由 LoadingIndicator 统一给，
 * 与会话页骨架、TUI、ACP、开工作区是同一个。❌ 别在这里另加文字或装饰。
 */
export function FullScreenLoader() {
  const { t } = useTranslation('main')

  return (
    <main
      data-testid="full-screen-loader"
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        overflow: 'hidden',
        background: 'var(--bg-primary)',
        color: 'var(--text-primary)',
      }}
    >
      <LoadingIndicator size="page" ariaLabel={t('shell.loading')} />
    </main>
  )
}
