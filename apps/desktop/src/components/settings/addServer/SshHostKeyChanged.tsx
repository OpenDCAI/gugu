import { useTranslation } from 'react-i18next'
import { cn } from '../../../lib/cn'
import { CommandBlock } from './CommandBlock'
import { knownHostsRemoveCommand } from './addServerFormat'

// #6264 这台机器的指纹和上次记下的不一样:这是拒绝,不是提问 —— ❌ 问「要不要信任」。
// 说清为什么停、它现在的指纹、删掉旧记录的那条命令(复制去终端执行)。添加机器的失败卡片与直连终端共用。

const text = 'text-[length:var(--font-body)] leading-[1.5]'
const caption = 'text-[length:var(--font-caption)] leading-[1.5]'

export function SshHostKeyChanged({
  hostKey,
  explain = false,
}: {
  hostKey: { host: string; fingerprint: string | null }
  /** 带上「为什么停、下一步做什么」那段话(添加机器的失败卡片已经在上面说过了,不带)。 */
  explain?: boolean
}) {
  const { t } = useTranslation('settings')
  return (
    <>
      {explain && <div className={cn(text, 'text-[var(--fg)]')}>{t('devices.addServer.reasons.hostKeyChanged')}</div>}
      {hostKey.fingerprint && (
        <div className={cn(caption, 'break-all text-[var(--muted-fg)]')}>
          {t('devices.addServer.newFingerprint', { fingerprint: hostKey.fingerprint })}
        </div>
      )}
      {hostKey.host && <CommandBlock command={knownHostsRemoveCommand(hostKey.host)} testId="ssh-host-key-remove" />}
    </>
  )
}
