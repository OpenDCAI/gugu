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
import { useChatChannels } from './useChatChannels'
import { WechatConnectDialog } from './WechatConnectDialog'

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
  const [failed, setFailed] = useState(false)
  return (
    <Sheet onClose={onCancel} desktopWidth="400px" desktopMaxHeight="80vh" mobileFitContent ariaLabel={t('channels.disconnectConfirm.title')} testId="wechat-disconnect-dialog" zIndex="var(--z-settings-modal)">
      <div className="flex flex-col gap-3 p-[18px]">
        <div className="text-[length:var(--font-title)] font-semibold text-[var(--fg)]">{t('channels.disconnectConfirm.title')}</div>
        <div className={`${body} text-[var(--muted-fg)]`}>{t('channels.disconnectConfirm.body')}</div>
        {failed ? <div className={`${body} text-[var(--danger)]`}>{t('channels.disconnectConfirm.failed')}</div> : null}
        <div className="flex justify-end gap-2">
          <Button size="sm" onClick={onCancel}>{t('channels.disconnectConfirm.cancel')}</Button>
          <Button
            size="sm"
            variant="danger"
            disabled={busy}
            data-testid="wechat-disconnect-confirm"
            onClick={() => {
              setBusy(true)
              setFailed(false)
              onConfirm().then(
                () => setBusy(false),
                () => {
                  setBusy(false)
                  setFailed(true)
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

function ComingSoonRow({ kind }: { kind: 'feishu' | 'dingtalk' }) {
  const { t } = useTranslation('settings')
  return (
    <SettingsRow
      leading={<ChannelBrandIcon kind={kind} size={28} />}
      title={t(`channels.${kind}`)}
      control={<span className="gg-chip">{t('channels.comingSoon')}</span>}
    />
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

function ConnectedChannels({ client, list, apply }: { client: ChatChannelsClient; list: ChatChannelList; apply: (next: ChatChannelList) => void }) {
  const { t } = useTranslation('settings')
  const agents = useOwnedAgents()
  const time = useTimeLabel()
  const [confirmDisconnect, setConfirmDisconnect] = useState<ChatChannelKind | null>(null)
  const [failed, setFailed] = useState(false)
  const run = (action: Promise<ChatChannelList>) => {
    setFailed(false)
    action.then(apply, () => setFailed(true))
  }
  const wechat = list.channels.find((c) => c.kind === 'wechat') ?? null
  if (!wechat) return null
  const agentName = wechat.agentId ? (agents.find((agent) => agent.id === wechat.agentId)?.display_name ?? null) : null
  return (
    <>
      <SettingsGroup title={t('channels.connected')} footer={failed ? <SettingsNote tone="danger">{t('channels.actionFailed')}</SettingsNote> : undefined}>
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

/**
 * 聊天渠道的整块内容(「连接聊天工具」):已连接 / 默认聊天工具 / 可用,点「连接」弹扫码框。
 * 收发由云电脑管家替用户挂着(#7199),电脑关着也能聊;这一块只是管家 /channels 的界面,桌面、网页、手机都能用。
 *
 * 挂载合同(「助理」App 的「能力 · 聊天工具」页、设置 →「聊天渠道」兼容入口都用它):
 *  · 无 props,自己读数据(管家 /channels,10 秒刷新一次)、自己弹扫码框与断开确认;外壳只给页框(标题、滚动)。
 *  · 依赖:登录态(`getRendererAccessToken`)、`ContactsProvider`(列自己名下的 agent);弹层用 `--z-settings-modal`。
 *  · 根节点 data-testid = `chat-channels-panel`;这个环境没开放时整块只有一句「聊天渠道暂未开放」(`channels-not-open`)。
 */
export function ChatChannelsPanel() {
  const { t } = useTranslation('settings')
  const { client, list, status, refresh, apply } = useChatChannels()
  const [connecting, setConnecting] = useState(false)

  if (status === 'not_open' || !client) {
    return (
      <div className="gg-settings-page" data-testid="chat-channels-panel">
        <SettingsNote data-testid="channels-not-open">{t('channels.notOpen')}</SettingsNote>
      </div>
    )
  }

  const wechatConnected = list?.channels.some((c) => c.kind === 'wechat') ?? false
  return (
    <div className="gg-settings-page" data-testid="chat-channels-panel">
      <SettingsNote>{t('channels.intro')}</SettingsNote>
      {status === 'failed' ? (
        <SettingsNote tone="danger" data-testid="channels-load-failed">
          {t('channels.loadFailed')}{' '}
          <Button size="sm" variant="ghost" onClick={() => void refresh()}>{t('channels.reload')}</Button>
        </SettingsNote>
      ) : null}

      {list ? <ConnectedChannels client={client} list={list} apply={apply} /> : null}

      <SettingsGroup title={t('channels.available')}>
        {wechatConnected ? null : (
          <SettingsRow
            data-testid="wechat-channel-available"
            leading={<ChannelBrandIcon kind="wechat" size={28} />}
            title={t('channels.wechat')}
            description={t('channels.wechatHint')}
            control={(
              <Button size="sm" variant="primary" disabled={!list} onClick={() => setConnecting(true)} data-testid="wechat-channel-connect">
                {t('channels.connect')}
              </Button>
            )}
          />
        )}
        <ComingSoonRow kind="feishu" />
        <ComingSoonRow kind="dingtalk" />
      </SettingsGroup>

      {connecting && list ? (
        <WechatConnectDialog client={client} list={list} refresh={refresh} apply={apply} onClose={() => setConnecting(false)} />
      ) : null}
    </div>
  )
}
