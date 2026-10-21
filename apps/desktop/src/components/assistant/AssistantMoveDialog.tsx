import { useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../ui/Button'
import { Sheet } from '../ui/Sheet'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import type { MoveDirection } from '@renderer/features/assistant/assistant-move'
import { dismissMove, getMoveState, startMove, startPreview, subscribeMove } from '@renderer/features/assistant/assistant-move-controller'
import '../../i18n/registerAssistantCatalog'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

/** 账号清单上的名字:「飞书 · 阿满的飞书」(集成显示名取资源库那一份,查不到退回 id)。 */
function accountLabel(names: Map<string, string>, account: { integrationId: string; accountId: string; displayName?: string }): string {
  const service = names.get(account.integrationId) ?? account.integrationId
  const who = account.displayName?.trim() || (account.accountId === 'default' ? '' : account.accountId)
  return who ? `${service} · ${who}` : service
}

/**
 * #7199 搬家的弹窗(预览 → 确认 → 搬着 → 结果)。状态在 assistant-move-controller(模块级),这个组件挂在壳上:
 * 搬到中途设置页上的搬家那一组会换位置、被卸载重挂,弹窗不能跟着没;人离开设置页,弹窗也还在(搬还在跑)。
 */
export function AssistantMoveDialog() {
  const { t } = useTranslation('assistant')
  const { phase, assistantName, env, language } = useSyncExternalStore(subscribeMove, getMoveState)
  if (phase.kind === 'idle') return null
  const go = (direction: MoveDirection, names: Map<string, string>) => {
    if (env) void startMove(env, direction, names, language)
  }
  const start = (direction: MoveDirection) => {
    if (env) void startPreview(env, direction, language)
  }
  return (
    <Sheet onClose={phase.kind === 'moving' || phase.kind === 'preparing' ? () => undefined : dismissMove} desktopWidth="440px" desktopMaxHeight="80vh" mobileFitContent ariaLabel={t('move.group')} testId="assistant-move-dialog" zIndex="var(--z-settings-modal)">
      <div className="flex flex-col gap-3 overflow-y-auto p-[18px]" data-testid="assistant-move-phase" data-phase={phase.kind}>
        {phase.kind === 'preparing' ? (
          <p className="inline-flex items-center gap-2 text-[var(--muted-fg)]">
            <LoadingIndicator size="inline" />
            {t('move.preparing', { name: assistantName })}
          </p>
        ) : null}

        {phase.kind === 'prepare-failed' ? (
          <>
            <p>{t('move.prepareFailed', { name: assistantName })}</p>
            <div className="flex justify-end gap-2">
              <Button size="sm" onClick={dismissMove}>{t('move.close')}</Button>
              <Button size="sm" onClick={() => void start(phase.direction)}>{t('move.retry')}</Button>
            </div>
          </>
        ) : null}

        {phase.kind === 'confirm' ? (
          <>
            <div className="text-[length:var(--font-title)] font-semibold text-[var(--fg)]">
              {t(phase.direction === 'to-cloud' ? 'move.confirmTitleToCloud' : 'move.confirmTitleToComputer', { name: assistantName })}
            </div>
            <p>{t('move.confirmItems')}</p>
            {phase.direction === 'to-cloud' ? <p className="text-[var(--muted-fg)]">{t('move.confirmCloudModel')}</p> : null}
            <p className="text-[var(--muted-fg)]">
              {t('move.confirmSize', { files: phase.preview.files, size: formatSize(phase.preview.bytes) })}
            </p>
            {phase.preview.accounts.unsupported ? (
              <p className="text-[var(--muted-fg)]" data-testid="assistant-move-accounts-unsupported-note">{t('move.confirmAccountsUnsupported')}</p>
            ) : phase.preview.accounts.moving.length > 0 ? (
              <div data-testid="assistant-move-accounts">
                <p>{t('move.confirmAccounts', { name: assistantName })}</p>
                <ul className="ml-5 list-disc">
                  {phase.preview.accounts.moving.map((account) => (
                    <li key={`${account.integrationId}/${account.accountId}`}>{accountLabel(phase.names, account)}</li>
                  ))}
                </ul>
                <p className="text-[var(--muted-fg)]">{t(phase.direction === 'to-cloud' ? 'move.confirmAccountsNoteComputer' : 'move.confirmAccountsNoteCloud')}</p>
              </div>
            ) : (
              <p className="text-[var(--muted-fg)]">{t('move.confirmNoAccounts')}</p>
            )}
            {phase.preview.accounts.reconnect.length > 0 ? (
              <div data-testid="assistant-move-reconnect">
                <p>{t('move.confirmReconnect')}</p>
                <ul className="ml-5 list-disc">
                  {phase.preview.accounts.reconnect.map((item) => (
                    <li key={`${item.integrationId}/${item.accountId ?? ''}`}>{phase.names.get(item.integrationId) ?? item.integrationId}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <p className="text-[var(--muted-fg)]">{t('move.confirmKept')}</p>
            <div className="flex justify-end gap-2">
              <Button size="sm" onClick={dismissMove}>{t('move.cancel')}</Button>
              <Button size="sm" variant="primary" onClick={() => void go(phase.direction, phase.names)} data-testid="assistant-move-confirm">
                {t('move.confirmStart')}
              </Button>
            </div>
          </>
        ) : null}

        {phase.kind === 'moving' ? (
          <>
            <div className="text-[length:var(--font-title)] font-semibold text-[var(--fg)]">{t('move.movingTitle')}</div>
            <p className="inline-flex items-center gap-2" data-testid="assistant-move-step" data-step={phase.progress?.step ?? 'preflight'}>
              <LoadingIndicator size="inline" />
              {t(`move.step.${phase.progress?.step ?? 'preflight'}`, { name: assistantName })}
              {phase.progress?.bytes && phase.progress.bytes.total > 0
                ? ` · ${Math.min(100, Math.floor((phase.progress.bytes.done / phase.progress.bytes.total) * 100))}%`
                : ''}
            </p>
            <p className="text-[var(--muted-fg)]">{t('move.movingNote')}</p>
          </>
        ) : null}

        {phase.kind === 'done' ? (
          <>
            <div className="text-[length:var(--font-title)] font-semibold text-[var(--fg)]">{t('move.doneTitle')}</div>
            <ul className="ml-5 list-disc" data-testid="assistant-move-report">
              <li>{t('move.doneFiles', { count: phase.report.files })}</li>
              <li>{t('move.doneAccounts', { count: phase.report.accounts.moved.length })}</li>
              <li>{t('move.doneSchedules', { count: phase.report.schedules.restored })}</li>
            </ul>
            {phase.report.accounts.skipped.length > 0 ||
            phase.report.accounts.kept.length > 0 ||
            phase.report.skippedFiles.length > 0 ||
            phase.report.schedules.skipped.length > 0 ? (
              <div>
                <p>{t('move.doneNotMoved')}</p>
                <ul className="ml-5 list-disc">
                  {phase.report.accounts.skipped.map((item) => (
                    <li key={`s-${item.integrationId}/${item.accountId ?? ''}`}>
                      {t(item.reason === 'exists' ? 'move.doneNotMovedExists' : 'move.doneNotMovedCli', {
                        name: phase.names.get(item.integrationId) ?? item.integrationId,
                      })}
                    </li>
                  ))}
                  {phase.report.accounts.kept.map((item) => (
                    <li key={`k-${item.integrationId}/${item.accountId}`}>
                      {t('move.doneNotMovedKept', { name: phase.names.get(item.integrationId) ?? item.integrationId })}
                    </li>
                  ))}
                  {phase.report.skippedFiles.map((item) => (
                    <li key={`f-${item.rel}`}>{t('move.doneNotMovedFile', { rel: item.rel })}</li>
                  ))}
                  {phase.report.schedules.skipped
                    .filter((item) => item.reason !== 'exists')
                    .map((item) => (
                      <li key={`c-${item.name}`}>{t('move.doneNotMovedSchedule', { name: item.name })}</li>
                    ))}
                </ul>
              </div>
            ) : null}
            {phase.report.accounts.unsupported ? <p data-testid="assistant-move-accounts-unsupported">{t('move.doneAccountsUnsupported')}</p> : null}
            {phase.report.schedules.unreadable ? (
              <p data-testid="assistant-move-schedules-unreadable">{t('move.doneSchedulesUnreadable', { name: assistantName })}</p>
            ) : null}
            {phase.report.schedules.unsupported.length > 0 ? (
              <p data-testid="assistant-move-schedules-unsupported">
                {t('move.doneSchedulesUnsupported', { names: phase.report.schedules.unsupported.map((s) => s.name).join('、') })}
              </p>
            ) : null}
            {phase.report.warnings.length > 0 ? <p className="text-[var(--muted-fg)]">{t('move.doneWarn')}</p> : null}
            <div className="flex justify-end">
              <Button size="sm" variant="primary" onClick={dismissMove} data-testid="assistant-move-done">
                {t('move.close')}
              </Button>
            </div>
          </>
        ) : null}

        {phase.kind === 'failed' ? (
          <>
            <div className="text-[var(--danger)] font-semibold">{t('move.failedTitle')}</div>
            <p>{t(`move.failedReason.${phase.reason}`)}</p>
            <p className="text-[var(--muted-fg)]">
              {phase.intact ? t('move.failedIntact', { name: assistantName }) : t('move.failedResume')}
            </p>
            <div className="flex justify-end gap-2">
              <Button size="sm" onClick={dismissMove}>{t('move.close')}</Button>
              <Button size="sm" onClick={() => void (phase.resumable ? go(phase.direction, new Map()) : start(phase.direction))} data-testid="assistant-move-retry">
                {t(phase.resumable ? 'move.resumeAction' : 'move.retry')}
              </Button>
            </div>
          </>
        ) : null}
      </div>
    </Sheet>
  )
}
