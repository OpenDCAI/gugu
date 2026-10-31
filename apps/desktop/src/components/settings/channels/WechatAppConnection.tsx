import '@/i18n/registerSettingsCatalog'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AppConnectionHero } from '../../assistant/AppConnectionHero'
import { Button } from '../../ui/Button'
import { SettingsNote } from '../SettingsPrimitives'
import { ConnectedChannels } from './ChatChannelsPanel'
import { useChatChannels } from './useChatChannels'
import { WechatConnectDialog } from './WechatConnectDialog'
import { ChannelBrandIcon } from './ChannelBrandIcon'

/** WeChat uses its existing authorization transport; the app detail has the same surface as every provider. */
export function WechatAppConnection() {
  const { t } = useTranslation('assistant')
  const state = useChatChannels()
  const [connecting, setConnecting] = useState(false)
  const connected = state.list?.channels.some(item => item.kind === 'wechat')
  const available = !!state.client && !!state.list?.kinds.includes('wechat')
  return <>
    <AppConnectionHero icon={<ChannelBrandIcon kind="wechat" size={56} />} description={t('connectors.wechatDescription')}
      loading={state.status === 'loading'} disabled={!available} label={t(connected ? 'connectors.manage' : 'connectors.connect')}
      onConnect={() => setConnecting(true)} />
    {state.status === 'failed' || !!state.error ? <SettingsNote role="alert">{state.error || t('connectors.loadFailed')}<Button variant="ghost" size="sm" onClick={() => void state.refresh()}>{t('machine.retry')}</Button></SettingsNote> : null}
    {connected && state.client && state.list ? <ConnectedChannels client={state.client} list={state.list} apply={state.apply} /> : null}
    {connecting && state.client && state.list ? <WechatConnectDialog client={state.client} list={state.list} refresh={state.refresh} apply={state.apply} onClose={() => setConnecting(false)} /> : null}
  </>
}
