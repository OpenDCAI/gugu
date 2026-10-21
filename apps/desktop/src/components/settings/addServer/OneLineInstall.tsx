import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { SERVER_SSH_INSTALL_CHANNELS, type ServerSshInstallInfo } from '../../../lib/serverSshInstall'
import { canOpenNewSessionOnDevice, openNewSessionOnDevice } from '../../../lib/sessionpageNewSessionBridge'
import { useDevicesStore } from '../../../store/devicesContext'
import { cn } from '../../../lib/cn'
import { Button } from '../../ui/Button'
import type { MachineLimitRefusal } from '@gugu/core/cloud/machineLimit'
import { CommandBlock } from './CommandBlock'
import { MachineLimitNotice } from './MachineLimitNotice'
import { newlyAppearedDevices } from './addServerFormat'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { desktopIpc } from '../../../platform/desktopIpc'

// #6264 远程隧道(SSH 连不上的机器):「添加一台机器」菜单里的第二种装法,选了它就在那块里展开这一段。
// 照 Tailscale「Add device → Linux server」:那一行 + 复制 → 执行后终端打出链接和短码 → 网页上允许 → 几秒后上线;
// 就地等着新机器出现(订阅的就是设备列表本身),上线了当场翻成「✓ 已添加」,❌ 让人自己回列表里找。
// 那一行本身不带凭据、不会过期;有时效的是它打出来的短码(15 分钟)—— 过期了在那台机器上重新执行这一行就会给一个新的,
// 所以「重新生成」说成这句话,❌ 另摆一颗重新取同一行命令的假按钮。


const text = 'text-[length:var(--font-body)] leading-[1.5]'
const caption = 'text-[length:var(--font-caption)] leading-[1.5]'
const faint = 'text-[var(--faint-fg)]'

/** 就地等时多久问一次「刚才是不是因为机器上限没登上」。 */
export const MACHINE_LIMIT_CHECK_INTERVAL_MS = 5_000
/** 起点往前放一点:库的钟与这台电脑的钟差个几十秒也不漏。 */
const MACHINE_LIMIT_CHECK_SLACK_MS = 60_000

export function OneLineInstall({
  onAdded,
  onUpgrade,
  onRemoveMachine,
}: {
  /** 新机器上线后点「完成」(或「在这台机器上新建任务」)。还在等时的「取消」在外面那块的头上。 */
  onAdded: (deviceId: string) => void
  /** #6264 机器数到上限时句尾的「升级会员」。 */
  onUpgrade?: () => void
  /** #6264 机器数到上限时句尾的「移除一台机器」(收起这块,回到设备列表)。 */
  onRemoveMachine?: () => void
}) {
  const { t } = useTranslation('settings')
  const { devices, recentMachineLimitRefusal } = useDevicesStore()
  // #6264 那台机器在确认页点「允许」时、或领取登录结果时,库因为机器上限拒了它:这里就地停下说清楚,❌ 一直转圈等。
  const [refusal, setRefusal] = useState<(MachineLimitRefusal & { hostname: string | null }) | null>(null)
  const since = useRef<string | null>(null)
  if (since.current === null) since.current = new Date(Date.now() - MACHINE_LIMIT_CHECK_SLACK_MS).toISOString()
  const [info, setInfo] = useState<ServerSshInstallInfo | null>(null)
  const [useWget, setUseWget] = useState(false)
  // 这一段出现时已有的机器:之后新出现、且在线的那台就是照这一行装上的。
  const known = useRef<Set<string> | null>(null)
  if (known.current === null) known.current = new Set(devices.map((d) => d.device_id))

  useEffect(() => {
    const electron = desktopIpc()
    if (!electron) return
    let live = true
    void electron.invoke(SERVER_SSH_INSTALL_CHANNELS.info).then(
      (value) => { if (live) setInfo(value as ServerSshInstallInfo) },
      () => { if (live) setInfo(null) },
    )
    return () => { live = false }
  }, [])

  const appeared = newlyAppearedDevices(known.current, devices)[0] ?? null
  const waiting = !appeared && !refusal

  useEffect(() => {
    if (!waiting || !recentMachineLimitRefusal) return
    let live = true
    const check = () => {
      void recentMachineLimitRefusal(since.current!).then(
        (value) => { if (live && value) setRefusal(value) },
        () => undefined, // 问不到就接着等,下一拍再问;❌ 为这一格打断添加流程
      )
    }
    check()
    const timer = setInterval(check, MACHINE_LIMIT_CHECK_INTERVAL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [waiting, recentMachineLimitRefusal])
  const command = info ? (useWget ? info.installCommandWget : info.installCommand) : null

  // 命令一到就把焦点放到「复制」上 —— 这一块的第一件事就是复制它。只在焦点还停在这块本身(展开时放在那儿的)
  // 或掉到了 body 上时才挪,❌ 抢走人已经放到别处的焦点;只挪第一次,切 wget 不再挪。
  const rootRef = useRef<HTMLDivElement>(null)
  const copyRef = useRef<HTMLButtonElement>(null)
  const focusedCopy = useRef(false)
  useEffect(() => {
    const root = rootRef.current
    const button = copyRef.current
    if (!command || !root || !button || focusedCopy.current) return
    focusedCopy.current = true
    const doc = root.ownerDocument
    const active = doc.activeElement
    const panel = root.closest('[data-testid="settings-add-server-panel"]')
    if (!active || active === doc.body || active === panel) button.focus()
  }, [command])

  return (
    <div ref={rootRef} className="flex flex-col gap-3" data-testid="add-server-one-line">
      <div className={cn(text, 'text-[var(--fg)]')}>{t('devices.addServer.oneLine.runThis')}</div>
      {command && <CommandBlock command={command} testId="add-server-install-command" copyButtonRef={copyRef} />}
      <div className={cn(caption, faint)}>{t('devices.addServer.oneLine.next')}</div>
      {info?.installCommandWget && (
        <Button size="sm" variant="ghost" className={cn('-ml-2 self-start', caption)} onClick={() => setUseWget((v) => !v)}>
          {useWget ? t('devices.addServer.oneLine.curlToggle') : t('devices.addServer.oneLine.wgetToggle')}
        </Button>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className={cn(text, 'flex items-center gap-2')} aria-live="polite" data-testid="add-server-one-line-status">
          {appeared ? (
            // 「已添加」这句话自己说清了,❌ 再配一枚绿勾(装饰图标 + 装饰色)。
            <span className="text-[var(--fg)]">{t('devices.addServer.oneLine.appeared', { name: appeared.label })}</span>
          ) : refusal ? (
            <span className="text-[var(--fg)]" role="alert">
              <MachineLimitNotice refusal={refusal} onUpgrade={onUpgrade} onRemoveMachine={onRemoveMachine} />
            </span>
          ) : (
            <>
              {/* 在等那台机器连上来 = live(connecting)。 */}
              <LoadingIndicator size="inline" className="text-live" />
              <span className={faint}>{t('devices.addServer.oneLine.waiting')}</span>
            </>
          )}
        </div>
        <div className="ml-auto flex gap-2">
          {appeared ? (
            <>
              {canOpenNewSessionOnDevice() && (
                <Button size="sm" onClick={() => { onAdded(appeared.device_id); openNewSessionOnDevice(appeared.device_id) }}>
                  {t('devices.addServer.newTask')}
                </Button>
              )}
              <Button size="sm" variant="primary" onClick={() => onAdded(appeared.device_id)}>{t('devices.addServer.close')}</Button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}
