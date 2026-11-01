import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown } from '@/lib/icons'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { Menu, MenuItem } from '../ui/Menu'
import { Sheet } from '../ui/Sheet'
import type { useAnnotateActions } from './useAnnotateActions'

type Actions = ReturnType<typeof useAnnotateActions>
export function AnnotateDoneMenu({ actions, mobile }: { actions: Actions; mobile: boolean }) {
  const { t } = useTranslation('main', { keyPrefix: 'imageAnnotate' })
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  return <>
    <div className="ia-completion-actions">
      {actions.canCompose ? <>
        <Button variant="primary" disabled={actions.busy} onClick={() => void actions.putInComposer()}>{t('done')}</Button>
        <IconButton ref={anchor} aria-label={t('export')} disabled={actions.busy} onClick={() => setOpen(value => !value)} aria-expanded={open}><ChevronDown /></IconButton>
      </> : <Button ref={anchor} variant="primary" disabled={actions.busy} onClick={() => setOpen(value => !value)} aria-expanded={open}>{t('done')}<ChevronDown /></Button>}
    </div>
    {open && mobile ? <Sheet onClose={() => setOpen(false)} mobileFitContent ariaLabel={t('export')} zIndex="var(--z-overlay)">
      <div className="ia-completion-sheet">
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
