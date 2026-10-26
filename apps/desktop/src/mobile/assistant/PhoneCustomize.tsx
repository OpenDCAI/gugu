import { useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AgentSettingsModal } from '@/components/agentsettings/AgentSettingsModal'
import { Avatar } from '@/components/Avatar'
import { useToast } from '@/components/toastContext'
import { Button } from '@/components/ui/Button'
import { Palette } from '@/lib/icons'
import { rendererLogger } from '@/lib/log'
import { composeInstructions, joinPersona, PERSONA_PRESETS, type PersonaPreset } from '@/session/renderer/features/assistant/assistant-files'
import { readText, writeText } from '@/session/renderer/features/assistant/assistant-machine-core'
import { AssistantEmpty, PageHead } from '@/session/renderer/features/assistant/assistant-ui-parts'
import { useContactsStore } from '@/store/contactsContext'
import type { PhonePageProps } from './MobileAssistantApp'
import { PhoneMachineGate } from './PhoneMachineGate'
import { ReadFailed, ReadingNow } from './PhoneMachineView'
import { customizePlan } from './phoneProfileModel'
import type { PhonePersona } from './usePhoneProfileData'
import { reportAssistantAppChange } from '@/components/assistant/assistant-app-client'

const log = rendererLogger('mobile/assistant')

/**
 * 「自定义」(同桌面 CustomizeDialog;手机上推进来一页,❌ 弹窗、❌ 底部抽屉):
 * 头像 +「换形象」(形象工坊)、名字、性格(预设 + 一段自己写的,留空清除),一个「保存」。
 * 名字、形象在咕咕身份上,随时能改;性格在它家里,在休息时那一块说清并给「叫醒它」(❌ 自己叫),名字照样能存。
 */
export function PhoneCustomize({ assistant, readiness, machine, persona, go }: PhonePageProps & { persona: PhonePersona }) {
  const { t } = useTranslation('assistant')
  const { toast } = useToast()
  const { contacts, updateAgentProfile } = useContactsStore()
  const contact = contacts.find((candidate) => candidate.id === assistant.id) ?? null
  const read = persona.error ? null : persona.persona
  const readable = !!read && machine.state === 'ready'
  const [lookOpen, setLookOpen] = useState(false)
  const [name, setName] = useState(assistant.display_name)
  const [preset, setPreset] = useState<PersonaPreset | null>(read?.preset ?? null)
  const [rest, setRest] = useState(read?.rest ?? '')
  const [touched, setTouched] = useState(false)
  const revision = useRef<string | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 读到之前进来的:读到那一刻把读到的填进来(人还没动过的话)。
  if (!touched && read && (preset !== read.preset || rest !== read.rest)) {
    setPreset(read.preset)
    setRest(read.rest)
  }
  const plan = customizePlan({ draftName: name, currentName: assistant.display_name, personaTouched: touched, personaReadable: readable })

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      // 改名与桌面同一条路(通讯录 updateAgentProfile:云端身份 + 本机花名册)。
      if (plan.rename) {
        await updateAgentProfile(assistant.id, { name: plan.rename })
      }
      if (plan.writePersona && machine.state === 'ready') {
        const home = machine.machine
        // 写之前现读一遍:宿主维护那段取此刻的原文(进来之后它可能刚被升级过),❌ 用进来时读到的那份。
        const current = home.panel ? '' : (await readText(home, home.paths.instructions)) ?? ''
        await writeText(home, home.paths.instructions, composeInstructions(current, joinPersona(preset, rest)),revision.current)
        if (!home.panel) await reportAssistantAppChange(home, assistant.id, { resource: 'personality', operation: 'edited',
          id: home.paths.instructions, deviceId: home.deviceId, after: { path: home.paths.instructions } })
        persona.reload()
      }
      toast(t('customize.saved'), 'success')
      go(null)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      log.warn({ error: message }, 'save assistant customization failed')
      setError(t('customize.saveFailed', { message }))
    } finally {
      setSaving(false)
    }
  }

  const edit = <T,>(set: (value: T) => void) => (value: T) => {
    if (!touched) revision.current = persona.revision
    setTouched(true)
    set(value)
  }

  return (
    <div className="ta-page ta-phone-profile" data-testid="assistant-customize">
      <PageHead title={t('customize.title')} />
      <div className="ta-phone-customize-who">
        <Avatar name={name.trim() || assistant.display_name} avatarUrl={assistant.avatar} seed={assistant.id} size={72} isAgent harnessBadge={false} />
        <label className="flex min-w-0 flex-1 flex-col gap-2">
          <span className="ta-field-label">{t('customize.name')}</span>
          <input className="ta-input" value={name} maxLength={40} onChange={(event) => setName(event.target.value)} data-testid="assistant-customize-name" />
        </label>
      </div>
      <Button variant="ghost" className="ta-wide-btn" onClick={() => setLookOpen(true)} disabled={!contact || saving} data-testid="assistant-customize-look">
        <Palette />
        {t('customize.look')}
      </Button>
      <div className="ta-phone-persona-fields">
        <label className="ta-field-label" htmlFor={`assistant-persona-${assistant.id}`}>{t('customize.character')}</label>
        <PersonaGate readiness={readiness} machine={machine} persona={persona} name={assistant.display_name}>
          <div className="ta-chips" role="group" aria-label={t('customize.character')}>
            {PERSONA_PRESETS.map((key) => (
              <Button variant="ghost" key={key} aria-pressed={preset === key} onClick={() => edit(setPreset)(preset === key ? null : key)} data-testid={`assistant-persona-${key}`}>
                {t(`customize.preset.${key}`)}
              </Button>
            ))}
          </div>
          <textarea id={`assistant-persona-${assistant.id}`} className="ta-input" value={rest} placeholder={t('customize.describe')} onChange={(event) => edit(setRest)(event.target.value)} data-testid="assistant-persona-text" />
        </PersonaGate>
      </div>
      {error ? (
        <p className="ta-phone-error" role="alert">
          {error}
        </p>
      ) : null}
      <Button variant="ghost" className="ta-wide-btn" data-tone="primary" onClick={() => void save()} disabled={saving || !plan.canSave} aria-busy={saving} data-testid="assistant-customize-save">
        {saving ? t('common.saving') : t('common.save')}
      </Button>
      {/* 形象工坊:与桌面「换形象」同一个(手机上它自己铺满全屏、左上返回)。 */}
      {lookOpen && contact ? <AgentSettingsModal agent={contact} initialTab="look" onClose={() => setLookOpen(false)} /> : null}
    </div>
  )
}

/** 性格那一块读到之前说清是哪一步:在休息 / 正在醒 / 连不上(PhoneMachineGate)→ 工作区没开好 / 读失败(带重试)→ 正在读。 */
function PersonaGate({
  readiness,
  machine,
  persona,
  name,
  children,
}: Pick<PhonePageProps, 'readiness' | 'machine'> & { persona: PhonePersona; name: string; children: ReactNode }) {
  const { t } = useTranslation('assistant')
  const retry = (onRetry: () => void) => (
    <Button variant="ghost" className="ta-pill-btn" onClick={onRetry} data-testid="assistant-persona-retry">
      {t('machine.retry')}
    </Button>
  )
  const body = (() => {
    if (machine.state === 'no-workdir') return <AssistantEmpty>{t('machine.noWorkdir', { name })}</AssistantEmpty>
    if (machine.state === 'error') return <ReadFailed title={t('customize.loadFailed')} error={machine.error} onRetry={machine.retry} />
    if (persona.error)
      return (
        <AssistantEmpty title={t('customize.loadFailed')} action={retry(persona.reload)}>
          <span role="alert">{persona.error instanceof Error ? persona.error.message : String(persona.error)}</span>
        </AssistantEmpty>
      )
    if (!persona.persona) return <ReadingNow />
    return children
  })()
  return (
    <PhoneMachineGate readiness={readiness} name={name}>
      {body}
    </PhoneMachineGate>
  )
}
