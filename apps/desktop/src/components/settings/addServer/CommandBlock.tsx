import { rendererLogger } from '@/lib/log';
import { toast } from '@renderer/lib/hooks/use-toast';
import { messageForUser } from '@/lib/userFacingError';
import { useCallback, useEffect, useRef, useState, type Ref } from 'react'
import { useTranslation } from 'react-i18next'
import { platform } from '../../../platform'
import { cn } from '../../../lib/cn'
import { Button } from '../../ui/Button'

// #6264 添加一台机器里要人复制去别处执行的命令(一行安装命令、给管理员的 linger 命令、删旧指纹的命令):
// 等宽、可横向滚动、右边一颗「复制」,复制后就地变「已复制」—— 反馈长在被点的东西上,❌ 飞到屏幕角的 toast。
// 命令是「印在页上的东西」(design.md 的 code sheet):密度面板(前景 2.5%/暗 4%)+ --radius-document,❌ 用 muted 实底当盒子。

export function CommandBlock({ command, testId, copyButtonRef }: {
  command: string
  testId?: string
  /** 要把焦点放到「复制」上的调用方(远程隧道那块展开时)拿这颗按钮。 */
  copyButtonRef?: Ref<HTMLButtonElement>
}) {
  const { t } = useTranslation('settings')
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])
  const copy = useCallback(async () => {
    try { await platform.writeClipboardText(command) } catch (error) { rendererLogger('actions/CommandBlock').error({ error: error }, 'action failed'); toast({ title: messageForUser(error), tier: 'error' }); return }
    setCopied(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 1500)
  }, [command])
  return (
    <div className="flex min-w-0 items-center gap-2" data-testid={testId}>
      <code
        className={cn(
          'min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-[var(--radius-document)] bg-foreground/[0.025] px-2 py-1 dark:bg-foreground/[0.04]',
          'font-mono text-[length:var(--font-caption)] leading-[1.6] text-[var(--fg)] select-all',
        )}
      >
        {command}
      </code>
      <Button ref={copyButtonRef} size="sm" className="shrink-0" onClick={() => void copy()}>
        {copied ? t('devices.addServer.copied') : t('devices.addServer.copy')}
      </Button>
    </div>
  )
}
