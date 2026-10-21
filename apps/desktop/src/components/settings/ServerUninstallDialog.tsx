import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Device } from '@gugu/core/shared/types/chat'
import {
  SERVER_SSH_MACHINES_CHANNELS,
  type ServerUninstallStartResponse,
  type ServerUninstallState,
} from '../../lib/serverSshMachines'
import { rendererLogger } from '../../lib/log'
import { desktopIpc } from '../../platform/desktopIpc'
import { Button } from '../ui/Button'
import { Sheet } from '../ui/Sheet'
import { boundAgentsBlock, type BoundAgentsState } from '../../lib/deviceRowModel'
import { BoundAgentsConfirm } from './DeviceRemoveDialog'
import { SshPromptCard } from './addServer/SshPromptCard'

// #6264「从这台机器上卸载咕咕 server」(只给这台电脑用 SSH 装上的机器)。
// 经 SSH 连过去停服务、删安装。
// 两段式:先连上去看清楚装了什么、谁登着,摆在确认页上(卸载会让同机的其他账号一起用不了,要点名);
// 人确认后才卸;卸完把这台机器从你的列表里移除。连不上时给退路:改为只移除。

const api = desktopIpc
const log = rendererLogger('devices')

const body = 'text-[length:var(--font-body)] leading-[1.5]'
const muted = 'text-[var(--muted-fg)]'

/** 失败原因 → 一句人话。SSH 那几种与「添加一台机器」同一套说法。 */
function reasonKey(reason: NonNullable<ServerUninstallState['failure']>['reason']): string {
  return reason === 'uninstallFailed' ? 'devices.uninstall.uninstallFailed' : `devices.addServer.reasons.${reason}`
}

export function ServerUninstallDialog({
  device,
  address,
  agents,
  onCascadeChange,
  onRemove,
  onRemoveOnly,
  onClose,
}: {
  device: Device
  address: string
  agents: BoundAgentsState
  onCascadeChange: (value: boolean) => void
  /** 卸完之后把它从列表移除;返回是否成功。 */
  onRemove: () => Promise<boolean>
  /** 连不上 / 已经没装:改走「只移除」。 */
  onRemoveOnly: () => void
  onClose: () => void
}) {
  const { t } = useTranslation('settings')
  const [runId, setRunId] = useState<string | null>(null)
  const [states, setStates] = useState<Record<string, ServerUninstallState>>({})
  const [unknownMachine, setUnknownMachine] = useState(false)
  const [removed, setRemoved] = useState<boolean | null>(null)
  const runIdRef = useRef<string | null>(null)
  const removeStarted = useRef(false)

  useEffect(() => {
    const electron = api()
    if (!electron) return
    let live = true
    // 状态可能先于 start 的返回值到达:按 runId 全收着,展示时再按当前这次取。
    const off = electron.eventOn(SERVER_SSH_MACHINES_CHANNELS.uninstallState, (value) => {
      const state = value as ServerUninstallState
      if (state?.runId) setStates((prev) => ({ ...prev, [state.runId]: state }))
    })
    void (electron.invoke(SERVER_SSH_MACHINES_CHANNELS.uninstallStart, { deviceId: device.device_id }) as Promise<ServerUninstallStartResponse>).then(
      (response) => {
        if (!live) return
        if ('error' in response) {
          setUnknownMachine(true)
          return
        }
        runIdRef.current = response.runId
        setStates((prev) => ({ [response.runId]: prev[response.runId] ?? response.state }))
        setRunId(response.runId)
      },
      (error: unknown) => {
        log.error({ err: String((error as Error)?.message ?? error) }, 'uninstall start failed')
        if (live) setUnknownMachine(true)
      },
    )
    return () => {
      live = false
      off()
      // 关掉窗口时还没开始删 ⇒ 当作不卸了,❌ 让它在看不见的地方继续问密码。
      const id = runIdRef.current
      if (id) void api()?.invoke(SERVER_SSH_MACHINES_CHANNELS.uninstallCancel, id)
    }
  }, [device.device_id])

  const state = runId ? states[runId] ?? null : null
  const phase = state?.phase ?? (unknownMachine ? null : 'inspecting')

  // 那台机器吐出来的原文只进日志,界面只说发生了什么、下一步怎么办。
  useEffect(() => {
    if (state?.failure) log.warn({ reason: state.failure.reason, detail: state.failure.detail ?? null, target: state.target }, 'server uninstall failed')
  }, [state?.failure, state?.target])

  // 卸完 ⇒ 从列表移除(带上智能体的级联选择)。
  useEffect(() => {
    if (phase !== 'done' || removeStarted.current) return
    removeStarted.current = true
    void onRemove().then(setRemoved, () => setRemoved(false))
  }, [phase, onRemove])

  const answer = useCallback((value: string | null) => {
    if (!state?.prompt) return
    void api()?.invoke(SERVER_SSH_MACHINES_CHANNELS.uninstallAnswer, { runId: state.runId, promptId: state.prompt.id, value })
  }, [state])

  const confirm = useCallback(() => {
    if (runId) void api()?.invoke(SERVER_SSH_MACHINES_CHANNELS.uninstallConfirm, runId)
  }, [runId])

  const inspection = state?.inspection ?? null
  const othersSignedIn = inspection?.accounts.some((account) => !account.you && account.signedIn) ?? false
  const uninstalling = phase === 'uninstalling' || (phase === 'done' && removed === null)
  const finished = phase === 'failed' || phase === 'cancelled' || (phase === 'done' && removed !== null)

  return (
    <Sheet
      onClose={uninstalling ? () => undefined : onClose}
      desktopWidth="440px"
      desktopMaxHeight="80vh"
      mobileFitContent
      ariaLabel={t('devices.uninstall.label', { name: device.label })}
      testId="settings-device-uninstall-dialog"
      zIndex="var(--z-settings-modal)"
    >
      <div className="flex flex-col gap-3 overflow-y-auto p-[18px]">
        <div className="text-[length:var(--font-title)] font-semibold text-[var(--fg)]">{t('devices.uninstall.title', { name: device.label })}</div>

        {unknownMachine && <div className={`${body} ${muted}`}>{t('devices.uninstall.unknownMachine')}</div>}

        {phase === 'inspecting' && !state?.prompt && (
          <div className={`${body} ${muted}`}>{t('devices.uninstall.connecting', { target: state?.target ?? address })}</div>
        )}
        {state?.prompt && <SshPromptCard prompt={state.prompt} onAnswer={answer} />}

        {phase === 'confirm' && inspection && !inspection.installed && (
          <div className={`${body} ${muted}`}>{t('devices.uninstall.notInstalled')}</div>
        )}

        {phase === 'confirm' && inspection?.installed && (
          <>
            <div className="flex flex-col gap-1">
              <div className={`${body} text-[var(--fg)]`}>{t('devices.uninstall.willDelete')}</div>
              <ul className={`${body} ${muted} m-0 list-disc pl-5`}>
                <li>{inspection.version ? t('devices.uninstall.deleteProgramVersion', { version: inspection.version }) : t('devices.uninstall.deleteProgram')}</li>
                <li>{t('devices.uninstall.deleteData')}</li>
              </ul>
              <div className={`${body} ${muted}`}>{t('devices.uninstall.keep')}</div>
            </div>
            {inspection.accounts.length > 0 && (
              <div className="flex flex-col gap-1">
                <div className={`${body} text-[var(--fg)]`}>{t('devices.uninstall.accounts')}</div>
                <ul className={`${body} ${muted} m-0 list-disc pl-5`} data-testid="settings-device-uninstall-accounts">
                  {inspection.accounts.map((account, index) => (
                    <li key={`${account.email ?? 'unknown'}-${index}`}>
                      {account.email ?? t('devices.uninstall.unknownAccount')}
                      {account.you && t('devices.uninstall.you')}
                      {!account.signedIn && t('devices.uninstall.signedOut')}
                    </li>
                  ))}
                </ul>
                {othersSignedIn && <div className={`${body} text-[var(--warn)]`}>{t('devices.uninstall.othersWarning')}</div>}
              </div>
            )}
          </>
        )}

        {(phase === 'confirm' || uninstalling) && (
          <BoundAgentsConfirm state={agents} onCascadeChange={onCascadeChange} />
        )}

        {uninstalling && <div className={`${body} ${muted}`}>{t('devices.uninstall.uninstalling')}</div>}

        {phase === 'done' && removed !== null && (
          <div className={`${body} text-[var(--fg)]`}>
            {removed ? t('devices.uninstall.done', { target: state?.target ?? address }) : t('devices.uninstall.doneButNotRemoved', { target: state?.target ?? address })}
          </div>
        )}

        {phase === 'failed' && state?.failure && (
          <div className={`${body} text-[var(--danger)]`}>
            {t('devices.uninstall.failed', { reason: t(reasonKey(state.failure.reason)) })}
          </div>
        )}

        <div className="flex justify-end gap-2">
          {!finished && !uninstalling && <Button size="sm" onClick={onClose}>{t('devices.cancel')}</Button>}
          {phase === 'confirm' && inspection?.installed && (
            <Button size="sm" variant="danger" disabled={boundAgentsBlock(agents)} onClick={confirm}>{t('devices.uninstall.confirm')}</Button>
          )}
          {((phase === 'confirm' && inspection && !inspection.installed) || phase === 'failed' || unknownMachine) && (
            <Button size="sm" variant={phase === 'failed' ? 'secondary' : 'danger'} onClick={onRemoveOnly}>
              {phase === 'failed' ? t('devices.uninstall.removeOnly') : t('devices.uninstall.removeFromList')}
            </Button>
          )}
          {finished && <Button size="sm" variant={phase === 'done' ? 'primary' : 'secondary'} onClick={onClose}>{t('devices.uninstall.close')}</Button>}
        </div>
      </div>
    </Sheet>
  )
}
