import '@/i18n/registerSettingsCatalog'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChatChannelKind } from '@gugu/core/cloud/chatChannels'
import { Button } from '../../ui/Button'
import { SettingsGroup, SettingsRow } from '../SettingsPrimitives'
import { ConnectedChannels } from './ChatChannelsPanel'
import { useChatChannels } from './useChatChannels'
import { WechatConnectDialog } from './WechatConnectDialog'
import { SectionLabel } from '../../ui/SectionLabel'

export function ChannelAppConnection({ kind, name }: { kind: ChatChannelKind; name: string }) {
  const { t } = useTranslation('assistant')
  const state = useChatChannels()
  const [connecting, setConnecting] = useState(false)
  const connected = state.list?.channels.some(channel => channel.kind === kind)
  if (kind !== 'wechat') return null
  if (kind === 'wechat' && connected && state.client && state.list) return <div className="gg-settings-page" data-testid={`assistant-app-chat-${kind}`}>
    <SectionLabel>{t('connectors.chatPurpose', { app: name })}</SectionLabel>
    <ConnectedChannels client={state.client} list={state.list} apply={state.apply} />
  </div>
  return <SettingsGroup title={t('connectors.chatPurpose', { app: name })} data-testid={`assistant-app-chat-${kind}`}>
    {state.status === 'loading' ? <SettingsRow description={t('library.loading')} />
      : state.status === 'failed' ? <SettingsRow description={<span role="alert">{state.error}</span>} control={<Button size="sm" variant="ghost" onClick={() => void state.refresh()}>{t('machine.retry')}</Button>} />
      : !state.client || !state.list?.kinds.includes(kind) ? <SettingsRow description={t('connectors.chatUnavailable')} />
      : <SettingsRow description={t('connectors.chatDescription')} control={<Button size="sm" onClick={() => setConnecting(true)} data-testid="assistant-app-chat-connect">{t('connectors.connect')}</Button>} />}
    {connecting && state.client && state.list ? <WechatConnectDialog client={state.client} list={state.list} refresh={state.refresh} apply={state.apply} onClose={() => setConnecting(false)} /> : null}
  </SettingsGroup>
}
