import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from '../lib/icons'
import type { SshLinkFailure } from '../lib/sshLink'
import { pickSshLinkNotice, type SshLinkNotice } from '../lib/sshLinkNotice'
import {
  answerSshSignInPrompt,
  requestSshServerUpgrade,
  signInSshMachine,
  sshReinstallCommand,
  subscribeSshLinkProblems,
  subscribeSshSignInPrompts,
} from '../lib/sshLinkChannel'
import type { SshPrompt } from '../session/shared/ssh-prompt'
import { useDevicesStore } from '../store/devicesContext'
import { IconButton } from './ui/IconButton'
import { SshPromptCard } from './settings/addServer/SshPromptCard'
import { InlineAction } from './settings/addServer/InlineAction'
import { CommandBlock } from './settings/addServer/CommandBlock'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'

// #6264 远程 SSH 的机器:这台电脑与它之间只走 SSH(product spec「两种连法，处处能用」)。
// 连不上时 ❌ 退回咕咕云,各个模块照常报「问不到」;「怎么修」只在这一处说 —— 一张浮在窗口顶部中间的卡片
// (与远端终端上那张 SSH 提问卡片同一副浮层),照 VS Code Remote-SSH 连接要密码时在窗口顶上问:
//  · 要人回答(密码 / 口令 / 新主机指纹)才连得上:句子里一段「登录」,点了就在这张卡片里问;
//  · 版本太旧:这台电脑当场替它更新(照 VS Code Remote-SSH),卡片说「正在更新」,升完自动连上、卡片收起;
//    没更新成就说没成,句子里一段「重试」;老到没法自动更新的,给出在那台机器上重装的那一行命令;
//  · 指纹变了 / 被拒绝 / 没登这个账号 / 没装:如实说(被拒绝 ❌ 当成太旧去升级 —— 升级只因为版本)。
// 后台开的连接从不自己弹问(BatchMode),所以人不点就不会被突然问密码;收起之后同一台同一种原因不再出现。

export function SshLinkSignIn() {
  const { t } = useTranslation('settings')
  const { devices } = useDevicesStore()
  const [problems, setProblems] = useState<ReadonlyMap<string, SshLinkFailure>>(() => new Map())
  const [dismissed, setDismissed] = useState<ReadonlyMap<string, SshLinkFailure>>(() => new Map())
  const [signingIn, setSigningIn] = useState<string | null>(null)
  const [prompt, setPrompt] = useState<{ deviceId: string; prompt: SshPrompt } | null>(null)
  const [answered, setAnswered] = useState(false)

  useEffect(() => subscribeSshLinkProblems(setProblems), [])
  useEffect(
    () =>
      subscribeSshSignInPrompts((event) => {
        setAnswered(false)
        setPrompt(event.prompt ? { deviceId: event.deviceId, prompt: event.prompt } : null)
      }),
    [],
  )

  const notice = useMemo(() => pickSshLinkNotice({ problems, machines: devices, dismissed }), [problems, devices, dismissed])
  // 正在登录的那台优先(登录中它的原因会被清掉,卡片 ❌ 跳到别的机器上去)。
  const signingMachine = signingIn ? devices.find((d) => d.device_id === signingIn) : null
  const shown: SshLinkNotice | null = signingMachine
    ? { deviceId: signingMachine.device_id, name: signingMachine.label, reason: 'signInRequired' }
    : notice
  if (!shown) return null

  const startSignIn = () => {
    const deviceId = shown.deviceId
    setSigningIn(deviceId)
    void signInSshMachine(deviceId).finally(() => {
      setSigningIn(null)
      setPrompt(null)
      setAnswered(false)
    })
  }
  const dismiss = () => setDismissed((prev) => new Map(prev).set(shown.deviceId, shown.reason))
  const activePrompt = prompt && prompt.deviceId === shown.deviceId ? prompt.prompt : null
  const canSignIn = shown.reason === 'signInRequired' || shown.reason === 'hostKeyChanged'
  const reinstall = shown.reason === 'outdated' ? sshReinstallCommand(shown.deviceId) : null

  return (
    <div
      className={`pointer-events-none fixed inset-x-0 top-[calc(var(--titlebar-actions-lane)+8px)] z-[var(--z-toast)] flex justify-center px-4`}
      data-testid="ssh-link-sign-in"
    >
      <div className="pointer-events-auto w-full max-w-[440px] overflow-hidden rounded-[var(--radius-xl)] bg-background-quaternary text-foreground shadow-lift">
        {activePrompt ? (
          <SshPromptCard
            prompt={activePrompt}
            pending={answered}
            variant="floating"
            context={{ name: shown.name }}
            cancellable
            onAnswer={(value, extra) => {
              if (value !== null) setAnswered(true)
              answerSshSignInPrompt({
                deviceId: shown.deviceId,
                promptId: activePrompt.id,
                value,
                ...(extra?.installKey ? { installKey: true } : {}),
              })
            }}
          />
        ) : (
          <div className="flex items-start gap-2 px-4 py-3">
            <p className="min-w-0 flex-1 text-[length:var(--font-body)] leading-[1.5]">
              {signingIn || shown.reason === 'updating' ? (
                <span className="inline-flex items-center gap-2 text-muted-foreground" data-testid="ssh-link-busy">
                  <LoadingIndicator size="inline" />
                  {t(signingIn ? 'devices.link.connecting' : 'devices.link.updating', { name: shown.name })}
                </span>
              ) : reinstall ? (
                <span className="flex flex-col gap-2" data-testid="ssh-link-reinstall">
                  {t('devices.link.reinstall', { name: shown.name })}
                  <CommandBlock command={reinstall} testId="ssh-link-reinstall-command" />
                </span>
              ) : (
                <>
                  {t(`devices.link.${noticeKey(shown.reason)}`, { name: shown.name })}
                  {shown.reason === 'outdated' ? (
                    <>
                      {' '}
                      <InlineAction onClick={() => void requestSshServerUpgrade(shown.deviceId, { force: true })} testId="ssh-link-upgrade-retry">
                        {t('devices.link.retryUpdate')}
                      </InlineAction>
                    </>
                  ) : null}
                  {canSignIn ? (
                    <>
                      {' '}
                      <InlineAction onClick={startSignIn} testId="ssh-link-sign-in-action">
                        {t('devices.link.signIn')}
                      </InlineAction>
                    </>
                  ) : null}
                </>
              )}
            </p>
            {!signingIn ? (
              <IconButton aria-label={t('devices.link.dismiss')} size="sm" onClick={dismiss}>
                <X />
              </IconButton>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}

function noticeKey(reason: SshLinkFailure): 'signInNeeded' | 'hostKeyChanged' | 'outdated' | 'refused' | 'notSignedIn' | 'notInstalled' {
  switch (reason) {
    case 'refused':
      return 'refused'
    case 'hostKeyChanged':
      return 'hostKeyChanged'
    case 'outdated':
      return 'outdated'
    case 'notSignedIn':
      return 'notSignedIn'
    case 'notInstalled':
      return 'notInstalled'
    default:
      return 'signInNeeded'
  }
}
