import React from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from './ui/Button'
import { rendererLogger } from '../lib/log'

const shellLog = rendererLogger('app/shell-boundary')

/**
 * ⚠️ 兜底,不是修复(#5610 §2.5)。
 *
 * 桌面壳层从前只有根部一个 ErrorBoundary(main.tsx),从根到 Panel 十几层 Provider/Layout 之间没有任何中间边界,
 * 任何 render 抛错都是整 app 白屏、且唯一出口是 reload —— 对必现 bug 等于死循环。这一层包在 <MainLayout> 外:
 * ContactsProvider / DevicesProvider / InnerLayout 抛的时候,ChatProvider 与各个宿主(创建重试、更新条、会话过期
 * 提示)照常活着,用户拿到的是「这个界面出错了 + 重试 / 重新加载」而不是整棵树卸载。
 *
 * 它可能掩盖什么:
 * - 洞还在。真正的修法是让 render 里不再有可达的 throw(#5610 §2.1–2.4 做的事);这里只是把「整 app 挂」降成
 *   「主界面挂」。所以 componentDidCatch 必须响亮记日志,❌ 不许静默重试。
 * - 主界面没 commit 过时 App 的 effectsActive 一直是 false,靠它门控的宿主(创建重试等)不会启动 —— 这是既有的
 *   激活契约,不是这里的 bug,但看现象会像「某某功能没反应」。
 * - 「重新加载」不清任何持久化状态:桌面壳没有会话页那样单一的 viewState 可以 reset,哪份本地状态是毒状态这里
 *   判不了,盲清 localStorage 会连草稿 / 偏好一起清掉。毒状态要在它自己的读取点过滤(#5610 §2.1 的做法)。
 */
interface ShellErrorBoundaryState {
  error: Error | null
  /** 每次「重试」+1,作为子树的 key —— 重试 = 整个主界面重新挂载,而不是在坏掉的实例上继续。 */
  attempt: number
}

function ShellErrorFallback({ error, onRetry, onReload }: { error: Error; onRetry: () => void; onReload: () => void }) {
  const { t } = useTranslation('main')
  return (
    <div role="alert" data-testid="shell-error-fallback" className="flex min-h-0 flex-1 items-center justify-center bg-[var(--bg-primary)] p-8 text-[var(--text-primary)]">
      {/* 主界面连同无边框标题栏一起没了;留一条可拖拽区,窗口坏着也还能挪。 */}
      <div className="window-drag-region fixed inset-x-0 top-0 z-0 h-10" />
      <div className="relative z-10 w-[min(560px,100%)] rounded-[var(--radius-xl)] border border-[var(--border-color)] bg-[var(--bg-elevated)] p-6 shadow-[var(--shadow-popover)]">
        <div className="mb-2 text-[length:var(--font-title)] leading-[var(--lh-title)] font-semibold">{t('errorBoundary.shell.title')}</div>
        <div className="mb-4 text-[length:var(--font-body)] leading-[var(--lh-body)] text-[var(--text-secondary)]">{t('errorBoundary.shell.description')}</div>
        <div className="flex gap-2">
          <Button variant="primary" onClick={onRetry}>{t('errorBoundary.shell.retry')}</Button>
          <Button onClick={onReload}>{t('errorBoundary.shell.reload')}</Button>
        </div>
        {import.meta.env.DEV && (
          <details className="mt-4">
            <summary className="cursor-pointer select-none text-[length:var(--font-body)] leading-[var(--lh-body)] text-[var(--text-secondary)]">{t('errorBoundary.diagnostics')}</summary>
            <pre className="mt-3 whitespace-pre-wrap break-words rounded-[var(--radius-control)] border border-[var(--border-subtle)] bg-[var(--bg-primary)] p-3 font-[family-name:var(--font-family-mono)] text-[length:var(--text-code)] leading-[var(--lh-body)] text-[var(--danger-fg)]">{error.stack || error.message}</pre>
          </details>
        )}
      </div>
    </div>
  )
}

class ShellErrorBoundaryImpl extends React.Component<React.PropsWithChildren, ShellErrorBoundaryState> {
  state: ShellErrorBoundaryState = { error: null, attempt: 0 }

  static getDerivedStateFromError(error: Error): Partial<ShellErrorBoundaryState> {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // 响亮:这条日志是「兜底接住了一次本该白屏的崩溃」的唯一痕迹。被兜住 ≠ 被修好。
    shellLog.error(
      { err: error.stack ?? String(error), componentStack: info.componentStack ?? null, attempt: this.state.attempt },
      'main shell render failed; fallback shown, the underlying bug is NOT handled (#5610 §2.5)',
    )
  }

  private handleRetry = (): void => {
    this.setState((state) => ({ error: null, attempt: state.attempt + 1 }))
  }

  private handleReload = (): void => {
    window.location.reload()
  }

  render() {
    if (this.state.error) return <ShellErrorFallback error={this.state.error} onRetry={this.handleRetry} onReload={this.handleReload} />
    return <React.Fragment key={this.state.attempt}>{this.props.children}</React.Fragment>
  }
}

// 函数外壳不跑任何 hook(根边界 AppErrorBoundary 在它之上,而且那颗雷已经拆了),只是让 react-refresh 认得这是组件。
export function ShellErrorBoundary({ children }: React.PropsWithChildren) {
  return <ShellErrorBoundaryImpl>{children}</ShellErrorBoundaryImpl>
}
