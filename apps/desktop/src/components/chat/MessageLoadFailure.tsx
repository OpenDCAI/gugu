import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { platform } from '../../platform'
import { useToast } from '../toastContext'
import { Button } from '../ui/Button'
import { safeFailureLine } from '@/session/renderer/features/sessions/gugu-reason'

/**
 * #7199 这条线这次没读出来:说读不到、给重试。一行都没有时占满列表(❌ 落成「开始第一次对话」欢迎页 ——
 * 那是在说「你们从没聊过」);手上已有行(缓存)时只在列表上方压一条,已读到的照常可见。
 * 原因原文(库报错之类)不直接摆给人看,点「查看详情」才展开、可复制;原文另进日志(读的那一处记)。
 */
export function MessageLoadFailure({ error, onRetry, inline }: { error: Error; onRetry: () => Promise<void>; inline: boolean }) {
  const { t } = useTranslation('messaging')
  const [retrying, setRetrying] = useState(false)
  const [details, setDetails] = useState(false)
  const { toast } = useToast()
  // 复制没成(网页不安全上下文、平台不支持)要让人知道,❌ 按了没反应、只留一个未处理的拒绝。
  const copy = () => {
    // 有的平台不支持时是同步抛的:包进 promise 链里一起接住。
    void Promise.resolve().then(() => platform.writeClipboardText(error.message)).then(
      () => toast(t('message.copied'), 'success'),
      (cause) => toast(safeFailureLine(String((cause as Error)?.message ?? cause)), 'error'),
    )
  }
  const retry = () => {
    setRetrying(true)
    // 重试的结果由线自己记(成了清掉、又失败换成新原因),这里只管按钮别连点。
    void onRetry().catch(() => undefined).finally(() => setRetrying(false))
  }
  const actions = (
    <>
      <Button size="sm" variant="secondary" disabled={retrying} onClick={retry} data-testid="chat-load-retry">{t('chatArea.loadFailedRetry')}</Button>
      <Button size="sm" variant="ghost" aria-expanded={details} onClick={() => setDetails((open) => !open)} data-testid="chat-load-details-toggle">
        {t(details ? 'chatArea.loadFailedHideDetails' : 'chatArea.loadFailedDetails')}
      </Button>
    </>
  )
  const detail = details ? (
    <div className="flex max-w-[360px] items-start gap-2 text-left" data-testid="chat-load-details">
      <code className="min-w-0 flex-1 select-text break-words text-[length:var(--font-caption)] leading-[1.5] text-[var(--text-tertiary)]">{error.message}</code>
      <Button size="sm" variant="ghost" onClick={copy} data-testid="chat-load-details-copy">{t('chatArea.loadFailedCopy')}</Button>
    </div>
  ) : null
  if (inline)
    return (
      <div role="alert" data-testid="chat-load-failed" data-inline="true"
        className="flex shrink-0 flex-col gap-1 px-4 py-1 text-[length:var(--font-caption)] text-[var(--text-secondary)]">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1">{t('chatArea.loadFailedStale')}</span>
          {actions}
        </div>
        {detail}
      </div>
    )
  return (
    <div role="alert" data-testid="chat-load-failed"
      className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <div className="text-[length:var(--font-body)] font-semibold text-[var(--text-primary)]">{t('chatArea.loadFailedTitle')}</div>
      <div className="max-w-[320px] text-[length:var(--font-caption)] leading-[1.5] text-[var(--text-tertiary)]">{t('chatArea.loadFailedBody')}</div>
      <div className="flex items-center gap-2">{actions}</div>
      {detail}
    </div>
  )
}
