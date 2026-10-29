import { rendererLogger } from '@/lib/log';
import { messageForUser } from '@/lib/userFacingError';
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChatChannel, ChatChannelKind, ChatChannelList, ChatChannelsClient } from '@gugu/core/cloud/chatChannels'
import { Check, ChevronDown } from '@/lib/icons'
import { Button } from '../../ui/Button'
import { DropdownMenu, MenuItem } from '../../ui/Menu'
import { Sheet } from '../../ui/Sheet'
import { SettingsGroup, SettingsNote, SettingsRow } from '../SettingsPrimitives'
import { ChannelAgentPicker } from './ChannelAgentPicker'
import { useOwnedAgents } from './channelAgents'
import { ChannelBrandIcon } from './ChannelBrandIcon'

const body = 'text-[length:var(--font-body)] leading-[1.5]'

function useTimeLabel() {
  const { i18n } = useTranslation()
  return (ts: number) => {
    const date = new Date(ts)
    const sameDay = new Date().toDateString() === date.toDateString()
    return new Intl.DateTimeFormat(i18n.language, sameDay ? { hour: '2-digit', minute: '2-digit' } : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
  }
}

function HealthLine({ channel }: { channel: ChatChannel }) {
  const { t } = useTranslation('settings')
  const time = useTimeLabel()
  const health = channel.health
  const lastAt = Math.max(channel.lastInboundAt ?? 0, channel.lastOutboundAt ?? 0)
  const text =
    health.state === 'running' ? (lastAt ? t('channels.health.lastMessage', { time: time(lastAt) }) : t('channels.health.running'))
      : health.state === 'starting' ? t('channels.health.starting')
        : health.state === 'retrying' ? t('channels.health.retrying')
          : health.state === 'paused' ? t('channels.health.paused', { time: time(health.until) })
            : t('channels.health.broken')
  const tone = health.state === 'running' ? 'bg-[var(--ok)]' : health.state === 'starting' ? 'bg-[var(--muted-fg)]' : 'bg-[var(--danger)]'
  return (
    <span className="inline-flex items-center gap-2" data-testid="wechat-channel-health" data-state={health.state}>
      <span aria-hidden className={`inline-block size-1.5 rounded-full ${tone}`} />
      {text}
    </span>
  )
}

function DisconnectDialog({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => Promise<void> }) {
  const { t } = useTranslation('settings')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState('')
  return (
    <Sheet onClose={onCancel} desktopWidth="400px" desktopMaxHeight="80vh" mobileFitContent ariaLabel={t('channels.disconnectConfirm.title')} testId="wechat-disconnect-dialog" zIndex="var(--z-settings-modal)">
      <div className="flex flex-col gap-3 p-[18px]">
        <div className="text-[length:var(--font-title)] font-semibold text-[var(--fg)]">{t('channels.disconnectConfirm.title')}</div>
        <div className={`${body} text-[var(--muted-fg)]`}>{t('channels.disconnectConfirm.body')}</div>
        {failed ? <div className={`${body} text-[var(--danger-fg)]`}>{failed}</div> : null}
        <div className="flex justify-end gap-2">
          <Button size="sm" onClick={onCancel}>{t('channels.disconnectConfirm.cancel')}</Button>
          <Button
            size="sm"
            variant="danger"
            disabled={busy}
            data-testid="wechat-disconnect-confirm"
            onClick={() => {
              setBusy(true)
              setFailed('')
              onConfirm().then(
                () => setBusy(false),
                (error: unknown) => {
                  setBusy(false)
                  rendererLogger('actions/ChatChannelsPanel').error({ error }, 'action failed'); setFailed(messageForUser(error))
                },
              )
            }}
          >
            {t('channels.disconnectConfirm.confirm')}
          </Button>
        </div>
      </div>
    </Sheet>
  )
}

/** 默认聊天工具:agent 主动找你(到点提醒等)推到哪一个;选项 = 已连接的 + 不要默认。 */
function DefaultChannelPicker({ channels, onPick }: { channels: ChatChannel[]; onPick: (kind: ChatChannelKind | null) => void }) {
  const { t } = useTranslation('settings')
  const [open, setOpen] = useState(false)
  const current = channels.find((c) => c.isDefault) ?? null
  const options: Array<{ kind: ChatChannelKind | null; label: string }> = [
    ...channels.map((c) => ({ kind: c.kind, label: t(`channels.${c.kind}`) })),
    { kind: null, label: t('channels.noDefaultChannel') },
  ]
  return (
    <DropdownMenu.Root open={open} modal={false} onOpenChange={setOpen}>
      <DropdownMenu.Trigger
        data-testid="channels-default-picker"
        aria-haspopup="menu"
        render={(
          <Button size="sm" variant="secondary" className="max-w-[220px] shrink-0">
            {current ? <ChannelBrandIcon kind={current.kind} size={16} /> : null}
            <span className="truncate">{current ? t(`channels.${current.kind}`) : t('channels.noDefaultChannel')}</span>
            <ChevronDown aria-hidden className="size-3.5 shrink-0 opacity-60" />
          </Button>
        )}
      />
      {open && (
        <DropdownMenu.Content side="bottom" align="end" sideOffset={4} zIndex="var(--z-settings-modal)" aria-label={t('channels.defaultChannel')} className="w-[220px]">
          {options.map((option) => (
            <MenuItem
              key={option.kind ?? 'none'}
              data-testid={`channels-default-option-${option.kind ?? 'none'}`}
              onClick={() => {
                setOpen(false)
                if (option.kind !== (current?.kind ?? null)) onPick(option.kind)
              }}
            >
              <span className="flex min-w-0 items-center gap-2">
                {option.kind ? <ChannelBrandIcon kind={option.kind} size={16} /> : null}
                <span className="truncate">{option.label}</span>
                {option.kind === (current?.kind ?? null) ? <Check aria-hidden className="ml-auto size-4 shrink-0 text-[var(--muted-fg)]" /> : null}
              </span>
            </MenuItem>
          ))}
        </DropdownMenu.Content>
      )}
    </DropdownMenu.Root>
  )
}

export function ConnectedChannels({ client, list, apply }: { client: ChatChannelsClient; list: ChatChannelList; apply: (next: ChatChannelList) => void }) {
  const { t } = useTranslation('settings')
  const agents = useOwnedAgents()
  const time = useTimeLabel()
  const [confirmDisconnect, setConfirmDisconnect] = useState<ChatChannelKind | null>(null)
  const [failed, setFailed] = useState('')
  const run = (action: Promise<ChatChannelList>) => {
    setFailed('')
    action.then(apply, (error: unknown) => { rendererLogger('actions/ChatChannelsPanel').error({ error }, 'action failed'); setFailed(messageForUser(error)) })
  }
  const wechat = list.channels.find((c) => c.kind === 'wechat') ?? null
  if (!wechat) return null
  const agentName = wechat.agentId ? (agents.find((agent) => agent.id === wechat.agentId)?.display_name ?? null) : null
  return (
    <>
      <SettingsGroup title={t('channels.connected')} footer={failed ? <SettingsNote tone="danger">{failed}</SettingsNote> : undefined}>
        <SettingsRow
          data-testid="wechat-channel-connected"
          leading={<ChannelBrandIcon kind="wechat" size={28} />}
          title={t('channels.wechat')}
          description={(
            <span className="flex flex-col gap-1">
              <span>{agentName ? t('channels.wechatChatWith', { name: agentName }) : t('channels.wechatNoAgent')}</span>
              <span className="flex flex-wrap items-center gap-x-3">
                <HealthLine channel={wechat} />
                <span>{t('channels.connectedSince', { time: time(Date.parse(wechat.connectedAt)) })}</span>
              </span>
            </span>
          )}
          control={(
            <Button size="sm" onClick={() => setConfirmDisconnect('wechat')} data-testid="wechat-channel-disconnect">
              {t('channels.disconnect')}
            </Button>
          )}
        />
        <SettingsRow
          title={t('channels.agentLabel')}
          description={t('channels.agentHint')}
          control={<ChannelAgentPicker agentId={wechat.agentId} onPick={(id) => run(client.setAgent('wechat', id))} testId="wechat-channel-agent-picker" />}
        />
      </SettingsGroup>
      <SettingsGroup>
        <SettingsRow
          data-testid="channels-default-row"
          title={t('channels.defaultChannel')}
          description={t('channels.defaultChannelHint')}
          control={<DefaultChannelPicker channels={list.channels} onPick={(kind) => run(client.setDefault(kind))} />}
        />
      </SettingsGroup>
      {confirmDisconnect ? (
        <DisconnectDialog
          onCancel={() => setConfirmDisconnect(null)}
          onConfirm={async () => {
            apply(await client.disconnect(confirmDisconnect))
            setConfirmDisconnect(null)
          }}
        />
      ) : null}
    </>
  )
}
