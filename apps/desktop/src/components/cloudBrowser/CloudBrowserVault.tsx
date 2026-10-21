import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Eye, EyeOff, KeyRound } from '@/lib/icons'
import type { CloudBrowserAssistance } from '@/session/shared/cloud-browser'
import { Button } from '../ui/Button'
import { Field } from '../ui/Field'
import { IconButton } from '../ui/IconButton'
import { Sheet } from '../ui/Sheet'
import { Switch } from '../ui/Switch'
import { siteLabel } from './cloudBrowserLabels'
import './cloudBrowser.css'

export type VaultProblem = 'gone' | 'noForm' | 'saveFailed' | 'offline'
export type VaultOutcome = { ok: true } | { ok: false; reason: VaultProblem }

/**
 * 密码保险箱(browserVault.*):agent 请人登录某个网站时,人在这里填账号密码。
 * 提交只经实时浏览器那条线(远程隧道,SSH 端到端加密)直送云电脑上的咕咕 server,由它填进页面;
 * ❌ 进聊天、❌ 给 agent。这里也不留:关掉就清空。
 */
export function CloudBrowserVault({
  assistance,
  onSubmit,
  onClose,
}: {
  assistance: CloudBrowserAssistance
  onSubmit: (input: { username: string; password: string; save: boolean }) => Promise<VaultOutcome>
  onClose: () => void
}) {
  const { t } = useTranslation('cloudBrowser')
  const titleId = useId()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [reveal, setReveal] = useState(false)
  const [save, setSave] = useState(true)
  const [phase, setPhase] = useState<'idle' | 'adding' | 'added'>('idle')
  const [problem, setProblem] = useState<VaultProblem | null>(null)

  useEffect(() => {
    if (phase !== 'added') return
    const timer = setTimeout(onClose, 800)
    return () => clearTimeout(timer)
  }, [phase, onClose])

  const site = siteLabel(assistance.site)
  const submit = async () => {
    if (phase !== 'idle' || (!username && !password)) return
    setPhase('adding')
    setProblem(null)
    const outcome = await onSubmit({ username, password, save })
    if (outcome.ok) {
      setPassword('')
      setPhase('added')
      return
    }
    setPhase(outcome.reason === 'saveFailed' ? 'added' : 'idle')
    setProblem(outcome.reason)
  }

  return (
    <Sheet onClose={onClose} titleId={titleId} desktopWidth="min(400px, 100%)" mobileFitContent>
      <form
        className="cb-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <div className="cb-row">
          <span className="cb-vault-key">
            <KeyRound size={16} />
          </span>
          <div className="cb-head-text">
            <h2 id={titleId} className="cb-dialog-title">
              {t('vault.title')}
            </h2>
            <span className="cb-caption">{t('vault.privacy')}</span>
          </div>
        </div>
        <div className="cb-vault-site">
          {t('vault.login', { site })}
          {assistance.text ? <div className="cb-vault-reason">{assistance.text}</div> : null}
        </div>
        <Field.Root>
          <Field.Label>{t('vault.url')}</Field.Label>
          <Field.Input value={assistance.url ?? assistance.site ?? ''} readOnly />
        </Field.Root>
        <Field.Root>
          <Field.Label>{t('vault.username')}</Field.Label>
          <Field.Input value={username} onChange={(event) => setUsername(event.currentTarget.value)} autoComplete="off" autoFocus disabled={phase !== 'idle'} />
        </Field.Root>
        <Field.Root>
          <Field.Label>{t('vault.password')}</Field.Label>
          <div className="cb-vault-secret">
            <Field.Input
              type={reveal ? 'text' : 'password'}
              value={password}
              onChange={(event) => setPassword(event.currentTarget.value)}
              autoComplete="new-password"
              disabled={phase !== 'idle'}
            />
            <IconButton
              size="sm"
              aria-label={reveal ? t('vault.hidePassword') : t('vault.showPassword')}
              onClick={() => setReveal((v) => !v)}
              className="cb-vault-eye"
            >
              {reveal ? <EyeOff size={16} /> : <Eye size={16} />}
            </IconButton>
          </div>
        </Field.Root>
        <label className="cb-vault-save">
          <Switch checked={save} onCheckedChange={setSave} disabled={phase !== 'idle'} />
          {t('vault.savePassword')}
        </label>
        {problem ? <div role="alert" className="cb-vault-problem" data-soft={problem === 'saveFailed' || undefined}>{t(problem === 'offline' ? 'viewer.disconnected' : `vault.${problem}`)}</div> : null}
        <div className="cb-actions">
          <Button variant="secondary" onClick={onClose}>{t('vault.close')}</Button>
          <Button variant="primary" type="submit" disabled={phase !== 'idle' || (!username && !password)}>
            {phase === 'adding' ? t('vault.adding') : phase === 'added' ? t('vault.added') : t('vault.confirm')}
          </Button>
        </div>
      </form>
    </Sheet>
  )
}
