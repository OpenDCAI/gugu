import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { PREFERRED_SESSION_PROVIDERS } from '@shared/core/sessions/new-session-defaults'
import { AppIcon } from '@renderer/lib/components/app-icon'
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { Check } from '@/lib/icons'
import { writeFirstRunHarness } from '../../lib/firstRun'
import { useFirstRunInstaller } from './first-run-install-context'
import './first-run-harness.css'

/** 多选推荐；统一交给咕咕自己的托管安装，外部副本不参与首次安装判断。 */
export function FirstRunHarness({ userId, onDone }: { userId: string; onDone: () => void }) {
  const { t } = useTranslation('main')
  const queryClient = useQueryClient()
  const memory = useAppSettingsKey('newSessionMemory')
  const installInBackground = useFirstRunInstaller()
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(['codex']))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const selected = PREFERRED_SESSION_PROVIDERS.filter((id) => picked.has(id))
  const canContinue = selected.length > 0 && !memory.isLoading && !memory.error && !saving

  const toggle = (id: string) => setPicked((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const proceed = async () => {
    if (!canContinue) return
    setSaving(true)
    setError(null)
    try {
      await memory.updateAsync({ lastPicked: selected[0] })
      await writeFirstRunHarness(userId, selected)
      installInBackground(selected)
      onDone()
    } catch {
      setError(t('firstRun.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <h1 className="ta-onb-title">{t('firstRun.harnessTitle')}</h1>
      <p className="ta-onb-sub">{t('firstRun.harnessSub')}</p>
      <div className="first-run-harness-choices" role="group" aria-label={t('firstRun.harnessTitle')}>
        {PREFERRED_SESSION_PROVIDERS.map((id) => (
          <HarnessChoice key={id} id={id}
            selected={picked.has(id)} disabled={saving} onToggle={() => toggle(id)} />
        ))}
      </div>
      {memory.error ? (
        <div role="alert">
          <p className="ta-onb-error">{t('firstRun.harnessReadFailed')}</p>
          <Button variant="secondary" size="sm" onClick={() => { void queryClient.invalidateQueries({ queryKey: ['appSettings', 'newSessionMemory'] }) }}>{t('firstRun.retry')}</Button>
        </div>
      ) : null}
      {error ? <p className="ta-onb-error" role="alert">{error}</p> : null}
      <div className="ta-onb-actions first-run-harness-actions">
        <Button variant="primary" size="lg" className="rounded-full" disabled={!canContinue} onClick={() => void proceed()} data-testid="first-run-harness-continue">
          {saving ? t('firstRun.saving') : t('firstRun.continue')}
        </Button>
      </div>
    </>
  )
}

function HarnessChoice({ id, selected, disabled, onToggle }: {
  id: string; selected: boolean; disabled: boolean; onToggle: () => void
}) {
  const { t } = useTranslation('main')
  const name = id === 'codex' ? 'Codex' : 'Claude'
  return (
    <label className="first-run-harness-choice" data-selected={selected} data-testid={`first-run-harness-${id}`}>
      <input type="checkbox" className="first-run-harness-input" checked={selected} disabled={disabled} onChange={onToggle}
        aria-label={t('firstRun.harnessSelect', { name })} />
      {id === 'codex' ? <Chip appearance="filled" className="first-run-harness-badge">{t('firstRun.harnessRecommended')}</Chip> : null}
      <span className="first-run-harness-check" aria-hidden>{selected ? <Check size={12} /> : null}</span>
      <AppIcon id={id} size={52} />
      <h2>{name}</h2>
    </label>
  )
}
