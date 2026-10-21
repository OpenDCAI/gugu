import { REMOTE_TUNNEL_OPEN } from '@gugu/core/cloud/remoteTunnel'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  SERVER_SSH_INSTALL_CHANNELS,
  type ServerSshInstallAnswer,
  type ServerSshInstallStartRequest,
  type ServerSshInstallStartResponse,
  type ServerSshInstallState,
  type SshConfigHost,
} from '../../lib/serverSshInstall'
import { canOpenNewSessionOnDevice, openNewSessionOnDevice } from '../../lib/sessionpageNewSessionBridge'
import { useDevicesStore } from '../../store/devicesContext'
import { Button } from '../ui/Button'
import { Field } from '../ui/Field'
import {
  menuRowClassName,
  menuRowLabelClassName,
  menuSurfaceClassName,
} from '../ui/Menu'
import { Popover } from '../ui/Popover'
import { cn } from '../../lib/cn'
import { InstallProgress, type InstallLanding } from './addServer/InstallProgress'
import { OneLineInstall } from './addServer/OneLineInstall'
import { filterSshConfigHosts, landedDevice } from './addServer/addServerFormat'
import { desktopIpc } from '../../platform/desktopIpc'

// #6264 设置 → 设备 → 添加一台机器:在设备列表顶上就地展开的一块,❌ 再叠一层弹窗。
// 两种装法是两个动作(照 VS Code 把 Remote - SSH 与 Remote - Tunnels 分开),「添加一台机器」的菜单里先挑一种,
// 这块只装那一种,头上写着是哪种:
//  · 远程 SSH:能 SSH 登录的机器,这台电脑替你装好,终端和文件直接走 SSH —— 天然成本低,排第一;
//  · 远程隧道:SSH 连不上时,在那台机器上运行一行命令,经咕咕云连接(addServer/OneLineInstall)。
// 远程 SSH 这一种照抄同类成熟产品,不自己发明:
//  · 一个输入框收 ssh 命令 / 用户@主机 / ~/.ssh/config 别名,打字时下面给匹配的配置主机
//    (Zed「Connect New Server」、VS Code Remote-SSH 的 quick pick:↑↓ 选、回车就连);
//  · 连上之后同一块原地变成五步进度(SSH 的提问就地问、查看日志、失败说原因 + 重试);装好就收起,新机器出现在列表里;
//  · 不要名字框:从配置里挑的主机默认叫那个别名,之后在行的「⋯」里改名;
//  · 网络到不了那台机器时,失败原因那句话里直接给「改用远程隧道」。
// SSH 只是一种装法:装好的机器出现在同一个设备列表里,❌ 不标「SSH 机器」。
// 形态(design.md 的 line budget):这一块是**密度面板**(前景 2.5%/暗 4%),❌ 四边框卡片 ——
// 它下面就是设备列表,里面还有失败/提醒那几段 callout,框套框就是 box inside a box。



type InputProblem = { key: 'invalidTarget' | 'unsupportedOption' | 'targetHasCommand'; option?: string }

/** 两种装法:远程 SSH / 远程隧道。 */
export type AddServerMethod = 'ssh' | 'tunnel'

/** 添加完成:哪台机器,以及要不要给它起名(只在从 ~/.ssh/config 挑了别名、且是这次新出现的机器时才有)。 */
export type AddedServer = { deviceId: string | null; name: string | null }

export function AddServerPanel({
  method,
  onMethodChange,
  onClose,
  onAdded,
  onUpgrade,
  relogin,
}: {
  method: AddServerMethod
  onMethodChange: (method: AddServerMethod) => void
  onClose: () => void
  onAdded: (added: AddedServer) => void
  /** 机器数到上限(#6264)时的「升级会员」;「移除一台机器」= 收起这块,回到下面的设备列表。 */
  onUpgrade?: () => void
  /**
   * #6264 设备行上的「重新登录」:这台桌面记着怎么 SSH 过去的那台机器,展开就直接开始。
   * 已经装好的机器上,同一套流程跳过下载与注册、只做登录(behavior:SSH 机器可一键重登)。
   */
  relogin?: { deviceId: string; address: string }
}) {
  const { t } = useTranslation('settings')
  const { devices } = useDevicesStore()
  const [target, setTarget] = useState(relogin?.address ?? '')
  const [hosts, setHosts] = useState<SshConfigHost[]>([])
  const [runId, setRunId] = useState<string | null>(null)
  const [states, setStates] = useState<Record<string, ServerSshInstallState>>({})
  const [inputProblem, setInputProblem] = useState<InputProblem | null>(null)
  const runIdRef = useRef<string | null>(null)
  /** 这次要给新机器起的名字(从配置里挑的别名);填的是地址就不起,照默认的「Linux 1」这类名字。 */
  const nameRef = useRef<string | null>(null)
  const finishedRef = useRef(false)
  // 展开时已有的机器:装好的那台不在其中 = 这次新加的(给它起别名);在其中 = 重新接上的老机器(名字不动)。
  const knownDeviceIds = useRef<Set<string> | null>(null)
  if (knownDeviceIds.current === null) knownDeviceIds.current = new Set(devices.map((d) => d.device_id))

  // 展开(或换一种装法)就把焦点放进这一块:远程 SSH 落在地址框上,远程隧道先落在这块本身、命令到了再落到「复制」上
  // (OneLineInstall)。❌ 指望「添加一台机器」的菜单关上时把焦点还回来 —— 那颗按钮已经卸掉了,焦点会掉到 body,
  // 甚至被还到设置窗口背后的会话页输入框上。焦点已在这块里(比如 autoFocus 先到了)就不动。
  const regionRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const region = regionRef.current
    if (!region || region.contains(region.ownerDocument.activeElement)) return
    const initial = region.querySelector<HTMLElement>('[data-add-server-initial-focus]')
    ;(initial ?? region).focus()
  }, [method])

  useEffect(() => {
    const electron = desktopIpc()
    if (!electron) return
    void electron.invoke(SERVER_SSH_INSTALL_CHANNELS.listHosts).then(
      (value) => setHosts(Array.isArray(value) ? (value as SshConfigHost[]) : []),
      () => setHosts([]),
    )
    // 状态可能先于 start 的返回值到达:按 runId 全收着,展示时再按当前这次取。
    return electron.eventOn(SERVER_SSH_INSTALL_CHANNELS.state, (value) => {
      const state = value as ServerSshInstallState
      if (state?.runId) setStates((prev) => ({ ...prev, [state.runId]: state }))
    })
  }, [])

  const state = runId ? states[runId] ?? null : null
  const result = state?.result ?? null
  // 装好 ≠ 出现:登录成功之后,那台机器上的 server 接上账号、发出第一下心跳才有设备行(实测约 6 秒)。
  // 这段时间里就在这块里等着说「正在等它上线」,❌ 一装好就收起 —— 那样列表里几秒钟什么都没有,看着像没加上。
  const landed = result ? landedDevice(result.deviceId, knownDeviceIds.current, devices) : null
  const awaitingLanding = Boolean(state?.finished && result && !landed)
  const [landingSlow, setLandingSlow] = useState(false)
  useEffect(() => {
    setLandingSlow(false)
    if (!awaitingLanding) return
    const timer = setTimeout(() => setLandingSlow(true), LANDING_SLOW_MS)
    return () => clearTimeout(timer)
  }, [awaitingLanding])
  const landing: InstallLanding | null = !result ? null : landed ? 'online' : landingSlow ? 'slow' : 'waiting'

  // 收起时还在装 ⇒ 当作取消,❌ 让它在看不见的地方继续问密码。
  useEffect(() => () => {
    const id = runIdRef.current
    if (id) void desktopIpc()?.invoke(SERVER_SSH_INSTALL_CHANNELS.cancel, id)
  }, [])

  const finish = useCallback(() => {
    if (finishedRef.current || !result) return
    finishedRef.current = true
    runIdRef.current = null
    const deviceId = result.deviceId ?? landed?.device_id ?? null
    const fresh = Boolean(deviceId && !knownDeviceIds.current?.has(deviceId))
    onAdded({ deviceId, name: fresh ? nameRef.current : null })
  }, [result, landed, onAdded])

  // 装好、它已经出现在列表里并在线、没有要人处理的提醒 ⇒ 当场收起。有提醒(比如要管理员开 linger)就留着让人看完再点「完成」。
  // 「下次免密」还在装 ⇒ 等它;没做成 ⇒ 同提醒一样留着(说清为什么、下次还会问密码)。
  const keyInstall = state?.keyInstall?.status ?? null
  useEffect(() => {
    if (keyInstall === 'working' || keyInstall === 'failed') return
    if (state?.finished && result && landed && state.warnings.length === 0) finish()
  }, [state?.finished, state?.warnings.length, result, landed, finish, keyInstall])

  const start = useCallback(async (value: string, remembered?: string) => {
    const electron = desktopIpc()
    if (!electron || !value.trim()) return
    setInputProblem(null)
    finishedRef.current = false
    const alias = value.trim()
    nameRef.current = !remembered && hosts.some((host) => host.alias === alias) ? alias : null
    const request: ServerSshInstallStartRequest = remembered ? { deviceId: remembered } : { target: value }
    const response = (await electron.invoke(SERVER_SSH_INSTALL_CHANNELS.start, request)) as ServerSshInstallStartResponse
    if ('error' in response) {
      setInputProblem(
        response.problem === 'unsupportedOption'
          ? { key: 'unsupportedOption', option: response.option }
          : response.problem === 'command'
            ? { key: 'targetHasCommand' }
            : { key: 'invalidTarget' },
      )
      return
    }
    runIdRef.current = response.runId
    setStates((prev) => ({ [response.runId]: prev[response.runId] ?? response.state }))
    setRunId(response.runId)
  }, [hosts])

  // 「重新登录」:展开就开始,一次。
  const reloginStarted = useRef(false)
  useEffect(() => {
    if (!relogin || reloginStarted.current) return
    reloginStarted.current = true
    void start(relogin.address, relogin.deviceId)
  }, [relogin, start])

  const answer = useCallback((value: string | null, extra?: { installKey?: boolean }) => {
    if (!state?.prompt) return
    const request: ServerSshInstallAnswer = {
      runId: state.runId,
      promptId: state.prompt.id,
      value,
      ...(extra?.installKey ? { installKey: true } : {}),
    }
    void desktopIpc()?.invoke(SERVER_SSH_INSTALL_CHANNELS.answer, request)
  }, [state])

  const cancel = useCallback(() => {
    if (runId) void desktopIpc()?.invoke(SERVER_SSH_INSTALL_CHANNELS.cancel, runId)
  }, [runId])

  const backToInput = useCallback(() => {
    runIdRef.current = null
    setRunId(null)
  }, [])

  const problemText = inputProblem
    ? inputProblem.key === 'unsupportedOption'
      ? t('devices.addServer.unsupportedOption', { option: inputProblem.option ?? '' })
      : t(`devices.addServer.${inputProblem.key}`)
    : null

  return (
    <div
      ref={regionRef}
      tabIndex={-1}
      className={cn('flex flex-col gap-3 rounded-[var(--radius-document)] bg-foreground/[0.025] p-[13px] outline-none dark:bg-foreground/[0.04]')}
      data-testid="settings-add-server-panel"
      data-method={method}
      role="region"
      aria-label={t(`devices.addServer.method.${method}`)}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="text-[length:var(--font-body)] font-semibold text-[var(--fg)]" data-testid="add-server-method-title">
          {t(`devices.addServer.method.${method}`)}
        </div>
        {/* 装着的时候由进度里的「取消」负责(它会真的停下那台机器上的安装)。 */}
        {!(state && !state.finished) && (
          <Button size="sm" variant="ghost" className="-mr-2" onClick={onClose} data-testid="add-server-close">{t('devices.cancel')}</Button>
        )}
      </div>
      {method === 'tunnel' ? (
        <OneLineInstall
          onAdded={(deviceId) => onAdded({ deviceId, name: null })}
          onUpgrade={onUpgrade}
          onRemoveMachine={onClose}
        />
      ) : state ? (
        <InstallProgress
          state={state}
          landing={landing}
          canOpenNewSession={Boolean(landed) && canOpenNewSessionOnDevice()}
          onAnswer={answer}
          onCancel={cancel}
          onRetry={() => void start(target)}
          onBack={backToInput}
          onDone={finish}
          onNewSession={() => {
            const deviceId = landed?.device_id ?? null
            finish()
            if (deviceId) openNewSessionOnDevice(deviceId)
          }}
          onSwitchToTunnel={REMOTE_TUNNEL_OPEN ? () => { backToInput(); onMethodChange('tunnel') } : undefined}
          onUpgrade={onUpgrade}
          onRemoveMachine={onClose}
        />
      ) : (
        <SshTargetForm
          target={target}
          hosts={hosts}
          problem={problemText}
          onTargetChange={(value) => { setTarget(value); setInputProblem(null) }}
          onSubmit={(value) => { setTarget(value); void start(value) }}
          onClose={onClose}
        />
      )}
    </div>
  )
}

/** 装好之后等多久还没上线,就改口说「还没上线,可以先关掉;一直不出现怎么查」。 */
export const LANDING_SLOW_MS = 30_000

/** 配置主机的第二行:`alice@10.0.0.9:2222`。 */
function hostAddress(host: SshConfigHost): string {
  return [host.user ? `${host.user}@` : '', host.hostname ?? '', host.port ? `:${host.port}` : ''].join('')
}


/**
 * 一个输入框 + 打字时出现的配置主机建议(照 VS Code Remote-SSH 的 quick pick):
 * 建议只在输入框有焦点、且打了字(或按 ↓)时出现;第一条默认就是当前项,↑↓ 移动,回车 / 点一下就直接连;
 * Esc 先收起建议,再收起整块。
 * 建议浮层与「添加一台机器」那类菜单是同一个东西:portal 出去、锚在输入框下沿、同宽,同一张浮层、同一种行(ui/Menu)。
 * ❌ 画在面板里 —— 下面设备列表的行会盖上来,看着像没有底、行和列表混在一起。
 */
function SshTargetForm({
  target,
  hosts,
  problem,
  onTargetChange,
  onSubmit,
  onClose,
}: {
  target: string
  hosts: readonly SshConfigHost[]
  problem: string | null
  onTargetChange: (value: string) => void
  onSubmit: (value: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation('settings')
  const listId = useId()
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(-1)
  const suggestions = useMemo(() => (open ? filterSshConfigHosts(hosts, target) : []), [open, hosts, target])
  const showList = suggestions.length > 0
  const listRef = useRef<HTMLUListElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (highlight < 0) return
    listRef.current?.querySelector<HTMLElement>(`[data-index="${highlight}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }, [highlight])

  const pick = (host: SshConfigHost) => {
    setOpen(false)
    setHighlight(-1)
    onSubmit(host.alias)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (!open) { setOpen(true); setHighlight(0); return }
      if (suggestions.length) setHighlight((h) => (h + 1) % suggestions.length)
    } else if (event.key === 'ArrowUp' && showList) {
      event.preventDefault()
      setHighlight((h) => (h <= 0 ? suggestions.length - 1 : h - 1))
    } else if (event.key === 'Enter' && showList && highlight >= 0 && suggestions[highlight]) {
      event.preventDefault()
      pick(suggestions[highlight])
    } else if (event.key === 'Escape') {
      // 只收起自己这一层,❌ 连设置窗口一起关掉。
      event.preventDefault()
      event.stopPropagation()
      if (showList) { setOpen(false); setHighlight(-1) } else onClose()
    }
  }

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); if (target.trim()) onSubmit(target) }}
      className="flex flex-col gap-3"
      data-testid="add-server-ssh"
    >
      <Field.Root invalid={Boolean(problem)}>
        <div className="relative">
          <Field.Input
            ref={inputRef}
            autoFocus
            data-add-server-initial-focus=""
            value={target}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={showList}
            aria-controls={listId}
            aria-activedescendant={showList && highlight >= 0 ? `${listId}-${highlight}` : undefined}
            aria-label={t('devices.addServer.targetPlaceholder')}
            placeholder={t('devices.addServer.targetPlaceholder')}
            onChange={(e) => {
              const value = e.currentTarget.value
              onTargetChange(value)
              setOpen(Boolean(value.trim()))
              // 第一条就是当前项:打完字直接回车 = 连最像的那台(同 VS Code quick pick)。
              setHighlight(0)
            }}
            onKeyDown={onKeyDown}
            onBlur={() => { setOpen(false); setHighlight(-1) }}
            data-testid="add-server-target"
          />
          <Popover.Root open={showList} modal={false} onOpenChange={(next) => { if (!next) { setOpen(false); setHighlight(-1) } }}>
            <Popover.Portal>
              <Popover.Positioner
                anchor={inputRef}
                side="bottom"
                align="start"
                sideOffset={4}
                collisionPadding={8}
                positionMethod="fixed"
                // 设置面板在 --z-settings 上,浮层要在它之上(同设置里的「⋯」菜单)。
                className="window-no-drag-region z-[var(--z-settings-modal)]"
              >
                {/* 浮层 portal 到 body:那条全局重置本来就把它的 padding 清成 0,❌ 再内联一遍。 */}
                <Popover.Popup
                  initialFocus={false}
                  finalFocus={false}
                  className={cn(menuSurfaceClassName, 'w-[var(--anchor-width)]')}
                >
                  <ul
                    ref={listRef}
                    id={listId}
                    role="listbox"
                    aria-label={t('devices.addServer.configHosts')}
                    data-testid="add-server-suggestions"
                    data-menu-surface=""
                    // 最多露 5 行,再多就在浮层里滚:5 × 行高(菜单行 min-h-9 = 36px)+ 上下内边距(p-1 = 4px)= 188px。
                    className="m-0 max-h-[188px] list-none overflow-y-auto p-1"
                  >
                    {suggestions.map((host, index) => {
                      const address = hostAddress(host)
                      return (
                        <li
                          key={host.alias}
                          id={`${listId}-${index}`}
                          role="option"
                          data-index={index}
                          data-menu-row=""
                          aria-selected={index === highlight}
                          data-highlighted={index === highlight ? '' : undefined}
                          className={cn(menuRowClassName, 'px-[10px] py-[6px]')}
                          // mousedown 而不是 click:click 之前输入框先失焦,建议就被收掉了。
                          onMouseDown={(event) => { event.preventDefault(); pick(host) }}
                          onMouseMove={() => setHighlight(index)}
                        >
                          {/* ❌ 每行摆同一枚「服务器」图标:十行一样的图标不携带任何信息,只是装饰。 */}
                          <span className={cn(menuRowLabelClassName, 'truncate')}>{host.alias}</span>
                          {address && (
                            // 用户@主机:端口 是要敲的东西 ⇒ mono(design.md:mono 只给命令、路径、标识符)。
                            <span className="max-w-[55%] shrink-0 truncate font-mono text-[length:var(--font-caption)] text-[var(--muted-fg)]">
                              {address}
                            </span>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                </Popover.Popup>
              </Popover.Positioner>
            </Popover.Portal>
          </Popover.Root>
        </div>
        {problem && <Field.Error match>{problem}</Field.Error>}
      </Field.Root>

      <div className="flex justify-end gap-2">
        <Button size="sm" variant="primary" type="submit" disabled={!target.trim()} data-testid="add-server-connect">
          {t('devices.addServer.connect')}
        </Button>
      </div>
    </form>
  )
}
