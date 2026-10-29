import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown } from '@/lib/icons'
import { Button } from '../ui/Button'
import { Field } from '../ui/Field'
import { Switch } from '../ui/Switch'
import { Menu, MenuItem } from '../ui/Menu'
import { Sheet } from '../ui/Sheet'
import type { useAnnotateSend } from './useAnnotateSend'

type Actions = ReturnType<typeof useAnnotateSend>
export function AnnotateSendBar({ actions }: { actions: Actions }) {
  const { t } = useTranslation('main', { keyPrefix: 'imageAnnotate' })
  return <div className="ia-sendbar">
    {actions.error ? <p role="alert" className="ia-error">{actions.error}</p> : null}
    {actions.canCompose ? <>
      <Field.Root className="ia-caption"><Field.Label>{t('message')}</Field.Label>
        <Field.Input value={actions.text} onValueChange={actions.setText} placeholder={t('messagePlaceholder')} disabled={actions.busy} /></Field.Root>
      <label className="ia-include"><Switch checked={actions.includeNotes} onCheckedChange={actions.setIncludeNotes} disabled={actions.busy} />{t('includeNotes')}</label>
      <div className="ia-send-buttons">
        <Button disabled={actions.busy} onClick={() => void actions.putInComposer()}>{t('compose')}</Button>
        {actions.canSend ? <Button variant="primary" disabled={actions.busy} onClick={() => void actions.send()}>{t('sendTo', { name: actions.chatName })}<span className="ia-shortcut">⌘↩</span></Button> : null}
      </div>
    </> : <p className="ia-source-note">{t('noSource')}</p>}
  </div>
}
export function AnnotateDoneMenu({ actions, mobile }: { actions: Actions; mobile: boolean }) {
  const { t } = useTranslation('main', { keyPrefix: 'imageAnnotate' })
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  return <>
    <Button ref={anchor} variant="primary" disabled={actions.busy} onClick={() => setOpen(value => !value)} aria-expanded={open}>{t('done')}<ChevronDown /></Button>
    {open && mobile ? <Sheet onClose={() => setOpen(false)} mobileFitContent ariaLabel={t('done')} zIndex="var(--z-overlay)">
      <div className="ia-completion-sheet"><AnnotateSendBar actions={actions} />
        <Button disabled={actions.busy} onClick={() => void actions.copy()}>{t('copy')}</Button>
        <Button disabled={actions.busy} onClick={() => void actions.save()}>{t('save')}</Button>
        {actions.canCompose ? <Button disabled={actions.busy} onClick={() => void actions.saveToFolder()}>{t('saveFolder')}</Button> : null}
      </div>
    </Sheet> : open ? <Menu anchor={anchor} onClose={() => setOpen(false)} zIndex="var(--z-overlay)">
      <MenuItem onClick={() => void actions.copy()}>{t('copy')}</MenuItem>
      <MenuItem onClick={() => void actions.save()}>{t('save')}</MenuItem>
      {actions.canCompose ? <MenuItem onClick={() => void actions.saveToFolder()}>{t('saveFolder')}</MenuItem> : null}
    </Menu> : null}
  </>
}
