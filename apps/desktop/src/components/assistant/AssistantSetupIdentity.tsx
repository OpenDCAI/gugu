import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pencil, X } from '@/lib/icons'
import { ASSISTANT_NAME_MAX, type AssistantSetupDraft } from '../../lib/assistantSetup'
import { AgentAvatar } from '../agentAvatar/AgentAvatar'
import { wornOf } from '../agentAvatar/look'
import { AgentLookEditor } from '../agentsettings/AgentLookEditor'
import { Button } from '../ui/Button'
import { Sheet } from '../ui/Sheet'
import { IconButton } from '../ui/IconButton'

/** 名字与形象在安家前确认；工坊只更新草稿，取消不影响先前选择。 */
export function AssistantSetupIdentity({ draft, onChange, onBack, onContinue }: {
  draft: AssistantSetupDraft
  onChange: (draft: AssistantSetupDraft) => void
  onBack: () => void
  onContinue: () => void
}) {
  const { t } = useTranslation('assistant')
  const { t: tc } = useTranslation('common')
  const [editing, setEditing] = useState(false)
  const name = draft.name.trim() || t('setup.defaultName')
  return (
    <>
      <h1 className="ta-onb-title">{t('setup.identityTitle')}</h1>
      <Button variant="ghost" className="ta-onb-look" onClick={() => setEditing(true)} aria-label={t('setup.customizeLook')}>
        <AgentAvatar id="assistant-draft" name={name} look={draft} size={112} holdExpression />
        <span className="ta-onb-look-label"><Pencil size={14} aria-hidden="true" />{t('setup.customizeLook')}</span>
      </Button>
      <label className="ta-onb-field">
        <span className="ta-onb-note">{t('setup.nameTitle')}</span>
        <input
          className="gg-settings-input window-no-drag-region"
          value={draft.name}
          maxLength={ASSISTANT_NAME_MAX}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
          onKeyDown={(event) => { if (event.key === 'Enter' && draft.name.trim()) onContinue() }}
          data-testid="assistant-setup-name"
        />
      </label>
      <div className="ta-onb-actions">
        <Button variant="secondary" size="lg" className="rounded-full flex-1" onClick={onBack}>{t('setup.back')}</Button>
        <Button variant="primary" size="lg" className="rounded-full flex-1" disabled={!draft.name.trim()} onClick={onContinue}>{t('setup.continue')}</Button>
      </div>
      <Sheet open={editing} onClose={() => setEditing(false)} desktopWidth="min(880px, 100%)" desktopMaxHeight="calc(100dvh - 32px)" fullScreenMobile ariaLabel={t('setup.customizeLook')}>
        <div className="ta-onb-workshop">
          <header className="ta-onb-look-header">
            <h2>{t('setup.customizeLook')}</h2>
            <IconButton aria-label={tc('dialog.close')} onClick={() => setEditing(false)}><X size={18} aria-hidden="true" /></IconButton>
          </header>
          {editing ? <AgentLookEditor
            id="assistant-draft"
            name={name}
            current={draft}
            onSave={async (look) => {
              onChange({ ...draft, color: look.color, rest: look.rest, wear: wornOf(look, 'assistant-draft') })
              setEditing(false)
            }}
          /> : null}
        </div>
      </Sheet>
    </>
  )
}
