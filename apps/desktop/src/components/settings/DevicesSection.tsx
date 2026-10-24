import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Device } from '@gugu/core/shared/types/chat'
import { formatBytes, type ServerMachineNotice } from '@gugu/core/cloud/serverMachineHealth'
import { REMOTE_TUNNEL_OPEN } from '@gugu/core/cloud/remoteTunnel'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'
import { formatRelativeTime } from '../../lib/relativeTime'
import {
  deviceRowModel,
  filterDevices,
  hasOtherMachines,
  type BoundAgentsState,
  type DeviceFilter,
  type DeviceRowModel,
} from '../../lib/deviceRowModel'
import { rendererLogger } from '../../lib/log'
import { useSshMachines } from '../../hooks/useSshMachines'
import { useSshSignInStates } from '../../hooks/useSshSignInStates'
import { useSshLinkProblems, useSshMachineIds, useSshUpgrades } from '../../hooks/useSshLinkProblems'
import { sshLinkFacts } from '../../lib/sshLinkOnline'
import { requestSshServerUpgrade, signInSshMachine } from '../../lib/sshLinkChannel'
import { retryServerVersionMatch } from '../../lib/serverVersionRetry'
import type { SshLinkFailure } from '../../lib/sshLink'
import type { SshSignInState } from '../../lib/serverSshMachines'
import { useDevicesStore } from '../../store/devicesContext'
import { platform } from '../../platform'
import { desktopIpc } from '../../platform/desktopIpc'
import { ChevronRight, Copy, ListChecks, MoreHorizontal, Pencil, Plus, RefreshCw, SquarePen, Trash2, Unplug } from '@/lib/icons'
import { canOpenNewSessionOnDevice, canReconnectDevice, openNewSessionOnDevice, reconnectDevice } from '../../lib/sessionpageNewSessionBridge'
import { useToast } from '../toastContext'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { IconButton } from '../ui/IconButton'
import { DropdownMenu, MenuItem, MenuSeparator } from '../ui/Menu'
import { PaneEmptyState } from '../ui/PaneEmptyState'
import { SearchField } from '../ui/SearchField'
import { SegmentedTabs } from '../ui/SegmentedTabs'
import { cn } from '../../lib/cn'
import { AddServerPanel, type AddServerMethod, type AddedServer } from './AddServerPanel'
import { InlineAction } from './addServer/InlineAction'
import { consumeAddServerIntent } from '../../lib/addServerIntent'
import { consumeDeviceActionsIntent } from '../../lib/deviceActionsIntent'
import { DeviceRemoveDialog } from './DeviceRemoveDialog'
import { ServerUninstallDialog } from './ServerUninstallDialog'
import { SettingsNote, SettingsPage, SettingsRow } from './SettingsPrimitives'
import { DeviceActionsPage } from './DeviceActionsPage'
import { deviceAcceptsWork } from '@gugu/core/cloud/cloudComputer'
import { withoutAssistantHome } from '../../lib/assistantHome'

// #1749 设备管理 → #6264 做成能上线的「设置 → 设备」:
//  · 每行:名字、是台什么机器(本机 / 电脑 / 服务器)、系统与架构、咕咕版本 + 升级状态、在线或「上次在线」、
//    怎么连着的(经 SSH:用户@主机 / 经云端);
//  · 每行一个「⋯」菜单,动作分组:改名、复制地址 | 移除这台机器、从这台机器上卸载咕咕 server;
//  · 机器多了能搜、能按在线状态筛;只有本机时说明「添加一台机器」能带来什么。
// 列表 ❌ 按「怎么装上的」分组:SSH 只是一种装法(product spec),「经 SSH」只是行内一格事实。
// store 为单一事实源(列表/排序/实时/动作),设计见 docs/devices-abstraction-design.md。
// 形态照 design.md 的 line budget:整张列表是一块密度面板,行靠节奏与 hover 填色分开,
// ❌ 每行一张带框卡片(四十行四十圈框是一只笼子);「是台什么机器」写成元信息里的一个词,
// ❌ 只靠一枚图标表达(icon standing in for a label)。

const log = rendererLogger('devices')

/** 行内元信息之间的分隔点:画在样式里,❌ 拼进译文(各语言的标点与间距不同)。 */
// 每一项前面一个 16px 的「·」格;整行往左挪 16px、外层裁掉 ⇒ 换行后落在行首的那一项,它的点在裁掉的那 16px 里,
// ❌ 出现「· 咕咕 0.2.51」那种孤零零挂在行首的分隔符。第一项(状态)用同宽的左内边距占位。
const META_SEP = "before:inline-block before:w-4 before:text-center before:content-['·']"

type DialogState =
  | { kind: 'remove'; device: Device; removing: boolean; failed: boolean }
  | { kind: 'uninstall'; device: Device }

export function DevicesSection({
  onUpgrade,
}: {
  /** #6264 添加机器碰到机器上限时句尾的「升级会员」:切到「设置 → 会员与额度」。 */
  onUpgrade?: () => void
} = {}) {
  const { t } = useTranslation('settings')
  const { toast } = useToast()
  const { devices: allDevices, loading, error, refresh, rename, remove, listBoundAgents, cloudComputer } = useDevicesStore()
  // #7199 个人助理住的那台云端宿主不在这一页(owner 10-15:用户看不到它住在哪);开通、叫醒、关闭都在「助理」App 里。
  const cloudDeviceId = cloudComputer?.snapshot?.deviceId ?? null
  const devices = useMemo(() => withoutAssistantHome(allDevices, cloudDeviceId), [allDevices, cloudDeviceId])
  const { addresses, forget } = useSshMachines()

  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftLabel, setDraftLabel] = useState('')
  const [rowError, setRowError] = useState<string | null>(null)
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [agents, setAgents] = useState<BoundAgentsState>({ agents: [], loading: false, cascadeChecked: false })
  const canAddServer = desktopIpc() !== null
  // 从会话页新建框的「添加一台机器」进来时,直接把「选一种装法」的菜单打开(远程隧道没开放时只有一种,直接展开它)。
  const [addMenuFromIntent] = useState(() => consumeAddServerIntent() && canAddServer)
  // 正在用哪种装法添加(同一时间只展开一块)。
  const [addingServer, setAddingServer] = useState<AddServerMethod | null>(() =>
    addMenuFromIntent && !REMOTE_TUNNEL_OPEN ? 'ssh' : null
  )
  // #6264 设备行上点了「重新登录」的那台(经 SSH 走同一套装机流程;已装好的机器上就是只登录)。
  const [relogin, setRelogin] = useState<{ deviceId: string; address: string } | null>(null)
  const nameWhenAppears = useNameWhenAppears(devices, rename)
  const onServerAdded = useCallback((added: AddedServer) => {
    setAddingServer(null)
    if (added.deviceId && added.name) nameWhenAppears({ deviceId: added.deviceId, name: added.name })
  }, [nameWhenAppears])
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<DeviceFilter>('all')
  // #7199 第二步:正在看哪台设备「能做的事」(设备页里的一个内页:点设备进它的连接应用页)。
  // #7199 助理主页点了一台设备 = 一进来就是那台的「能做的事」(deviceActionsIntent)。
  const [actionsFor, setActionsFor] = useState<string | null>(() => consumeDeviceActionsIntent())
  const thisDevice = devices.find((d) => d.is_current_device) ?? null

  const addressOf = useCallback((deviceId: string) => addresses.get(deviceId) ?? null, [addresses])
  // 离线的 SSH 机器:问清是没开机 / 连不上,还是登录没了(照 VS Code Tunnels / Tailscale「Expired」)。
  const signIns = useSshSignInStates(devices, addressOf)
  // 远程 SSH 的机器:在线与否、要不要先登录,只看这台电脑到它的设备连接(与侧栏、顶上卡片同一个读数)。
  const linkProblems = useSshLinkProblems()
  const upgrades = useSshUpgrades()
  const sshMachineIds = useSshMachineIds()
  const showTools = hasOtherMachines(devices)
  const visible = useMemo(
    () => (showTools ? filterDevices(devices, { query, filter, sshAddress: addressOf }) : devices),
    [showTools, devices, query, filter, addressOf],
  )
  const onlineCount = devices.filter((d) => deviceAcceptsWork(d)).length
  const filterItems = useMemo(() => [
    { value: 'all' as const, label: t('devices.filter.all', { n: devices.length }) },
    { value: 'online' as const, label: t('devices.filter.online', { n: onlineCount }) },
    { value: 'offline' as const, label: t('devices.filter.offline', { n: devices.length - onlineCount }) },
  ], [t, devices.length, onlineCount])

  const startRename = useCallback((device: Device) => {
    setRowError(null)
    setEditingId(device.device_id)
    setDraftLabel(device.label)
  }, [])

  const commitRename = useCallback(async (device: Device) => {
    const next = draftLabel.trim()
    if (!next || next === device.label) { setEditingId(null); return }
    try {
      await rename(device.device_id, next)
      setEditingId(null)
    } catch (err) {
      log.error({ err: String((err as Error)?.message ?? err), deviceId: device.device_id }, 'rename device failed')
      setRowError(device.device_id)
    }
  }, [draftLabel, rename])

  const loadAgents = useCallback(async (device: Device) => {
    setAgents({ agents: [], loading: true, cascadeChecked: false })
    try {
      const list = await listBoundAgents(device.device_id)
      setAgents({ agents: list, loading: false, cascadeChecked: false })
    } catch (err) {
      // 列不出来 ⇒ 按「没有」走非级联移除:真有的话库会拦下(DEVICE_HAS_AGENTS),确认页报「没能移除」,
      // ❌ 不会在没让人看过清单的情况下把智能体一起删掉。
      log.error({ err: String((err as Error)?.message ?? err), deviceId: device.device_id }, 'list bound agents failed')
      setAgents({ agents: [], loading: false, cascadeChecked: false })
    }
  }, [listBoundAgents])

  const openRemove = useCallback((device: Device) => {
    setDialog({ kind: 'remove', device, removing: false, failed: false })
    void loadAgents(device)
  }, [loadAgents])

  const openUninstall = useCallback((device: Device) => {
    setDialog({ kind: 'uninstall', device })
    void loadAgents(device)
  }, [loadAgents])

  /** 移除 = 这个账号不再用这台机器;用 SSH 装上的,这台电脑也不再记得怎么连过去。 */
  const removeDevice = useCallback(async (device: Device): Promise<boolean> => {
    try {
      await remove(device.device_id, { cascade: agents.agents.length > 0 })
      await forget(device.device_id).catch(() => undefined)
      return true
    } catch (err) {
      log.error({ err: String((err as Error)?.message ?? err), deviceId: device.device_id }, 'remove device failed')
      return false
    }
  }, [remove, forget, agents.agents.length])

  const confirmRemove = useCallback(async () => {
    if (dialog?.kind !== 'remove') return
    const device = dialog.device
    setDialog({ kind: 'remove', device, removing: true, failed: false })
    const ok = await removeDevice(device)
    setDialog(ok ? null : { kind: 'remove', device, removing: false, failed: true })
  }, [dialog, removeDevice])

  const copyAddress = useCallback(async (address: string) => {
    await platform.writeClipboardText(address)
    toast(t('devices.copied'), 'success')
  }, [toast, t])

  const actionsDevice = actionsFor ? devices.find((d) => d.device_id === actionsFor) ?? null : null
  if (actionsDevice) {
    return <DeviceActionsPage device={actionsDevice} isThisDevice={actionsDevice.is_current_device === true} onBack={() => setActionsFor(null)} />
  }

  return (
    <SettingsPage data-testid={AUTOMATION_TEST_IDS.settingsDevicesPane}>
      {canAddServer && !addingServer && (
        <div className="flex justify-end">
          <AddServerMenu defaultOpen={addMenuFromIntent} onPick={setAddingServer} testId="settings-add-server-button" />
        </div>
      )}

      {addingServer && (
        <AddServerPanel
          key={relogin?.deviceId ?? 'add'}
          method={addingServer}
          onMethodChange={setAddingServer}
          onClose={() => { setAddingServer(null); setRelogin(null) }}
          onAdded={(added) => { setRelogin(null); onServerAdded(added) }}
          onUpgrade={onUpgrade}
          relogin={relogin ?? undefined}
        />
      )}

      {error && (
        <SettingsNote tone="danger">
          {t('devices.listFailed')}
          <Button variant="ghost" size="sm" onClick={() => void refresh()} style={{ marginLeft: 'var(--spacing-sm)' }}>{t('devices.retry')}</Button>
        </SettingsNote>
      )}

      {loading && devices.length === 0 && <SettingsNote>{t('devices.loading')}</SettingsNote>}

      {thisDevice && canAddServer && (
        <div className="gg-settings-card window-no-drag-region">
          <SettingsRow
            data-testid="settings-device-actions-entry"
            leading={<ListChecks size={18} />}
            title={t('devices.deviceActions.entryTitle')}
            description={t('devices.deviceActions.entryHint')}
            control={<ChevronRight size={16} />}
            onClick={() => setActionsFor(thisDevice.device_id)}
          />
        </div>
      )}

      {showTools && (
        <div className="flex flex-wrap items-center gap-2">
          <SearchField
            className="min-w-[180px] flex-1"
            value={query}
            placeholder={t('devices.search')}
            onChange={(e) => setQuery(e.currentTarget.value)}
            clearLabel={t('devices.cancel')}
            onClear={() => setQuery('')}
            data-testid="settings-devices-search"
          />
          <SegmentedTabs items={filterItems} value={filter} onChange={setFilter} variant="underline" ariaLabel={t('devices.filter.label')} />
        </div>
      )}

      <div
        className={cn('flex flex-col rounded-[var(--radius-document)] bg-foreground/[0.025] p-1 dark:bg-foreground/[0.04]', visible.length === 0 && 'hidden')}
        role="list"
      >
        {visible.map((device) => (
          <DeviceRow
            key={device.device_id}
            device={device}
            model={deviceRowModel(device, addressOf(device.device_id), cloudDeviceId)}
            editing={editingId === device.device_id}
            draftLabel={draftLabel}
            renameFailed={rowError === device.device_id}
            onDraftChange={setDraftLabel}
            onStartRename={() => startRename(device)}
            onCommitRename={() => void commitRename(device)}
            onCancelRename={() => setEditingId(null)}
            onCopyAddress={(address) => void copyAddress(address)}
            onRemove={() => openRemove(device)}
            onUninstall={() => openUninstall(device)}
            onOpenActions={() => setActionsFor(device.device_id)}
            signIn={signIns.get(device.device_id) ?? null}
            sshLink={sshMachineIds.has(device.device_id) ? (linkProblems.get(device.device_id) ?? null) : undefined}
            onSshSignIn={() => void signInSshMachine(device.device_id)}
            upgradePercent={upgrades.get(device.device_id) ?? null}
            onRetryUpdate={() => void requestSshServerUpgrade(device.device_id, { force: true })}
            onRetryVersionMatch={() => retryServerVersionMatch(device.device_id)}
            onRelogin={canAddServer && addressOf(device.device_id)
              ? () => {
                  setRelogin({ deviceId: device.device_id, address: addressOf(device.device_id)! })
                  setAddingServer('ssh')
                }
              : undefined}
          />
        ))}
      </div>

      {showTools && visible.length === 0 && (
        <div className="text-[length:var(--font-body)] text-[var(--muted-fg)]" data-testid="settings-devices-no-match">{t('devices.noMatch')}</div>
      )}

      {!loading && !error && !showTools && !addingServer && (
        <div className="flex flex-col items-center gap-3 py-5" data-testid="settings-devices-empty">
          <PaneEmptyState caption={devices.some((d) => d.is_current_device) ? t('devices.empty.title') : t('devices.empty.none')} hint={t('devices.empty.hint')} />
          {canAddServer && <AddServerMenu primary onPick={setAddingServer} />}
        </div>
      )}

      {dialog?.kind === 'remove' && (
        <DeviceRemoveDialog
          device={dialog.device}
          model={deviceRowModel(dialog.device, addressOf(dialog.device.device_id))}
          agents={agents}
          onCascadeChange={(value) => setAgents((s) => ({ ...s, cascadeChecked: value }))}
          removing={dialog.removing}
          failed={dialog.failed}
          onCancel={() => setDialog(null)}
          onConfirm={() => void confirmRemove()}
        />
      )}

      {dialog?.kind === 'uninstall' && (
        <ServerUninstallDialog
          device={dialog.device}
          address={addressOf(dialog.device.device_id) ?? dialog.device.label}
          agents={agents}
          onCascadeChange={(value) => setAgents((s) => ({ ...s, cascadeChecked: value }))}
          onRemove={() => removeDevice(dialog.device)}
          onRemoveOnly={() => setDialog({ kind: 'remove', device: dialog.device, removing: false, failed: false })}
          onClose={() => setDialog(null)}
        />
      )}
    </SettingsPage>
  )
}

/**
 * 「添加一台机器」:先挑装法,两个动作(照 VS Code 的 Remote - SSH / Remote - Tunnels 分成两条)。
 * 远程 SSH 排第一:SSH 能连就用它,天然成本低;连不上才用远程隧道。菜单同设备行的「⋯」,键盘可达。
 */
function AddServerMenu({
  onPick,
  primary,
  defaultOpen = false,
  testId,
}: {
  onPick: (method: AddServerMethod) => void
  primary?: boolean
  defaultOpen?: boolean
  testId?: string
}) {
  const { t } = useTranslation('settings')
  const [open, setOpen] = useState(defaultOpen)
  // 挑了一种装法 ⇒ 这颗按钮随即卸掉、那一块接手焦点(它自己把焦点放进输入框 / 复制按钮)。
  // 菜单关上时❌ 再「归还焦点」:触发按钮已不在,Base UI 会退回它记着的上一个焦点元素 —— 可能是设置窗口背后会话页的输入框,
  // 接着打的字就进了那里(2026-09-24 实测:打的 ssh 命令在背后开了一条真会话)。没挑(Esc / 点外面)照常回到按钮上。
  const pickedRef = useRef(false)
  // 远程隧道暂不开放(REMOTE_TUNNEL_OPEN):只剩远程 SSH 一种,按钮点了直接展开它,❌ 弹一个只有一项的菜单。
  if (!REMOTE_TUNNEL_OPEN) {
    return (
      <Button
        data-testid={testId}
        size="sm"
        variant={primary ? 'primary' : 'secondary'}
        className="shrink-0"
        onClick={() => onPick('ssh')}
      >
        <Plus aria-hidden className="size-4" />
        {t('devices.addServer.open')}
      </Button>
    )
  }
  const item = (method: AddServerMethod) => (
    <MenuItem data-testid={`settings-add-server-${method}`} onClick={() => { pickedRef.current = true; onPick(method) }}>
      <span className="flex flex-col gap-[2px]">
        <span className="text-[var(--fg)]">{t(`devices.addServer.method.${method}`)}</span>
        <span className="text-[length:var(--font-caption)] leading-[1.4] whitespace-normal text-[var(--muted-fg)]">
          {t(`devices.addServer.method.${method}Hint`)}
        </span>
      </span>
    </MenuItem>
  )
  return (
    <DropdownMenu.Root open={open} modal={false} onOpenChange={(next) => { if (next) pickedRef.current = false; setOpen(next) }}>
      <DropdownMenu.Trigger
        data-testid={testId}
        aria-haspopup="menu"
        render={(
          <Button size="sm" variant={primary ? 'primary' : 'secondary'} className="shrink-0">
            <Plus aria-hidden className="size-4" />
            {t('devices.addServer.open')}
          </Button>
        )}
      />
      {open && (
        <DropdownMenu.Content
          side="bottom"
          align="end"
          sideOffset={4}
          zIndex="var(--z-settings-modal)"
          aria-label={t('devices.addServer.method.label')}
          className="w-[320px]"
          finalFocus={() => !pickedRef.current}
        >
          {item('ssh')}
          {item('tunnel')}
        </DropdownMenu.Content>
      )}
    </DropdownMenu.Root>
  )
}

/** 等多久:装好到它自己上线注册,通常几秒;一分钟还没出现就不等了(名字随时能在「⋯」里改)。 */
const NAME_WAIT_MS = 60_000

/**
 * 从 ~/.ssh/config 挑别名装上的新机器,默认就叫那个别名:装好时它可能还没出现在列表里,
 * 所以记下「这台叫什么」,等它出现就改一次名。添加那一块已经收起了,这件事由设备页接着做完。
 * 改名失败只记日志 —— 行上照常是默认名,随时能改。
 */
function useNameWhenAppears(devices: readonly Device[], rename: (deviceId: string, label: string) => Promise<void>) {
  const [pending, setPending] = useState<{ deviceId: string; name: string } | null>(null)
  const started = useRef<string | null>(null)
  const target = pending ? devices.find((d) => d.device_id === pending.deviceId) ?? null : null
  const targetLabel = target?.label ?? null

  useEffect(() => {
    if (!pending) return
    const timer = setTimeout(() => setPending((current) => (current === pending ? null : current)), NAME_WAIT_MS)
    return () => clearTimeout(timer)
  }, [pending])

  useEffect(() => {
    if (!pending || targetLabel === null) return
    if (targetLabel === pending.name) { setPending(null); return }
    if (started.current === pending.deviceId) return
    started.current = pending.deviceId
    rename(pending.deviceId, pending.name).then(
      () => setPending(null),
      (err: unknown) => {
        log.error({ err: String((err as Error)?.message ?? err), deviceId: pending.deviceId }, 'name new server failed')
        setPending(null)
      },
    )
  }, [pending, targetLabel, rename])

  return useCallback((next: { deviceId: string; name: string }) => {
    started.current = null
    setPending(next)
  }, [])
}

function DeviceRow({
  device,
  model,
  editing,
  draftLabel,
  renameFailed,
  onDraftChange,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onCopyAddress,
  onRemove,
  onUninstall,
  onOpenActions,
  signIn,
  sshLink,
  onSshSignIn,
  upgradePercent,
  onRetryUpdate,
  onRetryVersionMatch,
  onRelogin,
}: {
  device: Device
  model: DeviceRowModel
  editing: boolean
  draftLabel: string
  renameFailed: boolean
  onDraftChange: (value: string) => void
  onStartRename: () => void
  onCommitRename: () => void
  onCancelRename: () => void
  onCopyAddress: (address: string) => void
  onRemove: () => void
  onUninstall: () => void
  /** #7199 这台设备能做的事(能被助理调用的动作)。 */
  onOpenActions: () => void
  /** 离线的 SSH 机器上这个账号还登着没有(问不到 = null / unknown,照旧只说离线)。 */
  signIn: SshSignInState | null
  /** #6264 远程 SSH 那台此刻设备连接的问题(没有 = 连着);其它机器 null。 */
  sshLink?: SshLinkFailure | null
  /** 设备连接要先登录时,句中的「登录」:经 SSH 登录(问密码 / 口令)。 */
  onSshSignIn?: () => void
  /** 正在替它升级时的进度百分比(不知道总量 = null)。 */
  upgradePercent?: number | null
  /** 替它升级没成时,句中的「重试」。 */
  onRetryUpdate?: () => void
  /** #6264 那台机器换成和桌面匹配的版本没成(心跳报 server_update.failed):请它再试一次。 */
  onRetryVersionMatch?: () => Promise<boolean>
  /** 经 SSH 重新登录(只有这台桌面记着怎么 SSH 过去的机器有)。 */
  onRelogin?: () => void
}) {
  const { t } = useTranslation('settings')
  const [menuOpen, setMenuOpen] = useState(false)
  // 「改名」同「添加一台机器」:点了它这颗「⋯」随即卸掉、改名框自己接焦点,菜单关上时❌ 再归还焦点(理由见 AddServerMenu)。
  const renamingRef = useRef(false)
  const sshAddress = model.connection.via === 'ssh' ? model.connection.address : null
  const lastSeen = device.is_online ? null : formatRelativeTime(device.last_seen_at, { dateAfterDays: 30 })
  // 「登录已失效」「那台机器上已退出登录」替掉「上次在线」:机器是离线的,但真正的原因是这个,下一步是重新登录。
  const link = sshLink === undefined ? null : sshLinkFacts(true, sshLink, device.is_online).sshLink ?? null
  // 点了「重试」、那台机器的心跳还没报回新状态之前:先说「正在更新」;报回来(不再是这一次失败)就让位给它。
  const failedUpdate = model.update?.state === 'failed' ? model.update.version : null
  const [retriedFor, setRetriedFor] = useState<string | null>(null)
  const retrying = failedUpdate !== null && retriedFor === failedUpdate
  const signedOutText = sshLink === 'notSignedIn'
    ? t('devices.loginState.signedOut')
    : device.is_online || !signIn
    ? null
    : signIn.state === 'expired'
      ? t('devices.loginState.expired', { time: formatRelativeTime(signIn.at, { dateAfterDays: 30 }) })
      : signIn.state === 'signedOut' || signIn.state === 'removed'
        ? t('devices.loginState.signedOut')
        : null
  const version = model.kind === 'cloud'
    ? null
    : model.version
      ? t(model.kind === 'server' ? 'devices.serverVersion' : 'devices.appVersion', { version: model.version })
      : t('devices.versionUnknown')
  const acceptsWork = deviceAcceptsWork(device)

  return (
    <div
      role="listitem"
      data-testid={AUTOMATION_TEST_IDS.settingsDeviceRow}
      data-device-id={device.device_id}
      data-kind={model.kind}
      className="flex items-start gap-3 rounded-[var(--radius-control)] px-3 py-[10px] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--hover)] motion-reduce:transition-none"
    >
      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="flex items-center gap-[6px]">
            <input
              autoFocus
              value={draftLabel}
              onChange={(e) => onDraftChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onCommitRename()
                if (e.key === 'Escape') onCancelRename()
              }}
              aria-label={t('devices.menu.rename')}
              // @@@ui-ruler 与同一行的 Button size="sm" 同高:两者都取 --control-h-sm(28)。
              className="box-border min-h-[var(--control-h-sm)] min-w-0 flex-1 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--bg)] px-2 text-[length:var(--font-body)] text-[var(--fg)]"
            />
            <Button size="sm" variant="primary" onClick={onCommitRename}>{t('devices.save')}</Button>
            <Button size="sm" onClick={onCancelRename}>{t('devices.cancel')}</Button>
          </div>
        ) : (
          <div className="flex min-w-0 items-center gap-[7px]">
            <span className="truncate text-[length:var(--font-body)] font-semibold text-[var(--fg)]">{device.label}</span>
            {model.kind === 'this' && <Chip tone="accent">{t('devices.current')}</Chip>}
            {model.update && model.update.state !== 'failed' && (
              <Chip
                tone={model.update.state === 'ready' ? 'accent' : 'default'}
                title={t(model.update.state === 'ready' ? 'devices.update.readyHint' : 'devices.update.downloadingHint', { version: model.update.version })}
                data-testid="settings-device-update"
              >
                {t(model.update.state === 'ready' ? 'devices.update.ready' : 'devices.update.downloading')}
              </Chip>
            )}
            {model.notices
              // 远程 SSH 的机器太旧:状态那一行已说「正在更新 / 更新没成功」,❌ 再挂一颗说「空闲时会自动更新」的标签。
              .filter((notice) => !(notice.kind === 'server-too-old' && (link === 'updating' || link === 'outdated')))
              .map((notice) => (
                <DeviceNoticeChip key={notice.kind} notice={notice} />
              ))}
          </div>
        )}

        <div className="mt-[3px] overflow-hidden">
        <div className="-ml-4 flex flex-wrap items-center gap-y-[2px] text-[length:var(--font-caption)] text-[var(--faint-fg)]">
          <span className="inline-flex items-center gap-[5px] pl-4">
            {/* 状态点:在线 = connected = live 蓝(design.md 唯一的 accent);离线退成墨色最淡一档。 */}
            <span
              aria-hidden
              className={cn('size-[7px] shrink-0 rounded-[var(--radius-circle)]', device.is_online ? 'bg-live' : 'bg-[var(--faint-fg)]')}
            />
            {link === 'signInRequired' ? (
              <span className="text-[var(--danger)]" data-testid="settings-device-ssh-sign-in">
                {t('devices.loginState.sshSignIn')}
                {onSshSignIn && <>{' '}<InlineAction onClick={onSshSignIn} testId="settings-device-ssh-sign-in-action">{t('devices.loginState.sshSignInAction')}</InlineAction></>}
              </span>
            ) : link === 'updating' ? (
              // 版本太旧、这台电脑正在替它升级(远程 SSH):说真实状态与进度,❌「重连中」。
              <span data-testid="settings-device-updating">
                {upgradePercent !== null && upgradePercent !== undefined
                  ? t('devices.loginState.updatingPercent', { percent: upgradePercent })
                  : t('devices.loginState.updating')}
              </span>
            ) : link === 'outdated' ? (
              <span className="text-[var(--danger)]" data-testid="settings-device-outdated">
                {t('devices.loginState.updateFailed')}
                {onRetryUpdate && <>{' '}<InlineAction onClick={onRetryUpdate} testId="settings-device-update-retry">{t('devices.loginState.retryUpdate')}</InlineAction></>}
              </span>
            ) : link === 'unreachable' ? (
              t('devices.loginState.reconnecting')
            ) : failedUpdate !== null ? (
              <span className={retrying ? undefined : 'text-[var(--danger)]'} data-testid="settings-device-match-failed">
                {retrying ? t('devices.loginState.matchRetrying') : t('devices.loginState.matchFailed')}
                {!retrying && onRetryVersionMatch && (
                  <>{' '}<InlineAction
                    onClick={() => {
                      setRetriedFor(failedUpdate)
                      // 一分钟后还报同一次失败(又没成)= 重新给「重试」;心跳 30 秒一次,够它报回「正在下载」。
                      const reset = () => setRetriedFor((current) => (current === failedUpdate ? null : current))
                      void onRetryVersionMatch().then((ok) => (ok ? void setTimeout(reset, 60_000) : reset()))
                    }}
                    testId="settings-device-match-retry"
                  >{t('devices.loginState.retryUpdate')}</InlineAction></>
                )}
              </span>
            ) : device.is_online ? (
              t('devices.online')
            ) : signedOutText ? (
              <span className="text-[var(--danger)]" data-testid="settings-device-signed-out">{signedOutText}</span>
            ) : (
              <span title={model.kind === 'server' ? t('devices.loginState.offlineHint') : undefined}>
                {lastSeen ? t('devices.lastSeen', { time: lastSeen }) : t('devices.offline')}
              </span>
            )}
            {signedOutText && onRelogin && (
              <span title={t('devices.loginState.reloginHint')}>
                <InlineAction onClick={onRelogin} testId="settings-device-relogin">{t('devices.loginState.relogin')}</InlineAction>
              </span>
            )}
          </span>
          {/* 本机那一行名字旁已有「本机」标签,❌ 再说一遍。 */}
          {model.kind !== 'this' && <span className={META_SEP} data-testid="settings-device-kind">{t(`devices.kind.${model.kind}`)}</span>}
          {model.system && <span className={META_SEP}>{model.system}</span>}
          {version && <span className={META_SEP}>{version}</span>}
          {/* #6264 root 跑的 server:上面的智能体能改整台机器,如实写出来(隧道装的也看得到)。 */}
          {model.kind === 'server' && device.capabilities?.runs_as_root && (
            <span className={META_SEP} title={t('devices.runsAsRootHint')} data-testid="settings-device-runs-as-root">{t('devices.runsAsRoot')}</span>
          )}
          {/* 连法(远程 SSH / 远程隧道)只标在咕咕 server 上:那是「添加一台机器」的两种装法;
              另一台登着同一账号的咕咕桌面不是这么加进来的,只有「电脑」这个类别,❌ 标连法。 */}
          {model.kind === 'server' && model.connection.via === 'ssh' && (
            <span title={t('devices.via.sshHint')} className={`${META_SEP} min-w-0 truncate`}>{t('devices.via.ssh', { address: model.connection.address })}</span>
          )}
          {model.kind === 'server' && model.connection.via === 'sshElsewhere' && (
            <span title={t('devices.via.sshElsewhereHint')} className={META_SEP}>{t('devices.via.sshElsewhere')}</span>
          )}
          {model.kind === 'server' && model.connection.via === 'cloud' && (
            <span title={t('devices.via.tunnelHint')} className={META_SEP}>{t('devices.via.tunnel')}</span>
          )}
        </div>
        </div>
        {renameFailed && (
          <div className="mt-1 text-[length:var(--font-caption)] text-[var(--danger)]">{t('devices.renameFailed')}</div>
        )}
      </div>

      {!editing && (
        <DropdownMenu.Root
          open={menuOpen}
          modal={false}
          onOpenChange={(open) => { if (open) renamingRef.current = false; setMenuOpen(open) }}
        >
          <DropdownMenu.Trigger
            data-testid="settings-device-menu-button"
            aria-haspopup="menu"
            render={(
              <IconButton size="sm" on={menuOpen || undefined} aria-label={t('devices.actions')}>
                <MoreHorizontal />
              </IconButton>
            )}
          />
          {menuOpen && (
            <DropdownMenu.Content
              side="bottom"
              align="end"
              sideOffset={4}
              zIndex="var(--z-settings-modal)"
              className="min-w-[200px]"
              finalFocus={() => !renamingRef.current}
            >
              <MenuItem
                data-testid={AUTOMATION_TEST_IDS.settingsDeviceRenameButton}
                icon={<Pencil size={16} />}
                onClick={() => { renamingRef.current = true; onStartRename() }}
              >
                {t('devices.menu.rename')}
              </MenuItem>
              {model.kind !== 'this' && model.kind !== 'cloud' && acceptsWork && canOpenNewSessionOnDevice() && (
                <MenuItem data-testid="settings-device-new-session" icon={<SquarePen size={16} />} onClick={() => openNewSessionOnDevice(device.device_id)}>
                  {t('devices.addServer.newTask')}
                </MenuItem>
              )}
              {model.kind !== 'this' && model.kind !== 'cloud' && device.is_online && canReconnectDevice() && (
                <MenuItem data-testid="settings-device-reconnect" icon={<RefreshCw size={16} />} onClick={() => reconnectDevice(device.device_id)}>
                  {t('devices.menu.reconnect')}
                </MenuItem>
              )}
              <MenuItem data-testid="settings-device-open-actions" icon={<ListChecks size={16} />} onClick={onOpenActions}>
                {t('devices.deviceActions.menu')}
              </MenuItem>
              {sshAddress && (
                <MenuItem data-testid="settings-device-copy-address" icon={<Copy size={16} />} onClick={() => onCopyAddress(sshAddress)}>
                  {t('devices.menu.copyAddress')}
                </MenuItem>
              )}
              {model.kind !== 'this' && (
                <>
                  <MenuSeparator />
                  <MenuItem
                    danger
                    data-testid={AUTOMATION_TEST_IDS.settingsDeviceRemoveButton}
                    icon={<Unplug size={16} />}
                    onClick={onRemove}
                  >
                    {t('devices.menu.remove')}
                  </MenuItem>
                  {sshAddress && model.kind === 'server' && (
                    <MenuItem danger data-testid="settings-device-uninstall-button" icon={<Trash2 size={16} />} onClick={onUninstall}>
                      {t('devices.menu.uninstall')}
                    </MenuItem>
                  )}
                </>
              )}
            </DropdownMenu.Content>
          )}
        </DropdownMenu.Root>
      )}
    </div>
  )
}

/**
 * #6264 一台 server 有件事要人知道:标签说是什么,悬停说后果与怎么办(与 update 那颗标签同一个形态)。
 * 版本对不上、磁盘快满会让操作失败 → warn;升级被退回已经自愈,只是告知 → default。
 */
function DeviceNoticeChip({ notice }: { notice: ServerMachineNotice }) {
  const { t } = useTranslation('settings')
  switch (notice.kind) {
    case 'desktop-too-old':
      return <Chip tone="warn" title={t('devices.notice.desktopTooOldHint')} data-testid="settings-device-notice">{t('devices.notice.desktopTooOld')}</Chip>
    case 'server-too-old':
      return <Chip tone="warn" title={t('devices.notice.serverTooOldHint')} data-testid="settings-device-notice">{t('devices.notice.serverTooOld')}</Chip>
    case 'disk-low':
      return (
        <Chip tone="warn" title={t('devices.notice.diskLowHint', { free: formatBytes(notice.freeBytes) })} data-testid="settings-device-notice">
          {t('devices.notice.diskLow')}
        </Chip>
      )
    case 'rolled-back':
      return (
        <Chip title={t('devices.notice.rolledBackHint', { version: notice.version, restored: notice.restored })} data-testid="settings-device-notice">
          {t('devices.notice.rolledBack')}
        </Chip>
      )
  }
}
