import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import type { AssistantMachine } from '@/session/renderer/features/assistant/assistant-machine-core'
import { AssistantEmpty } from '@/session/renderer/features/assistant/assistant-ui-parts'
import type { PhonePageProps } from './MobileAssistantApp'
import { PhoneMachineGate } from './PhoneMachineGate'
import type { PhoneMachineState, PhoneReadiness } from './phoneMachine'
import { errorText, type PhoneRead } from './usePhoneRead'

/** 门过了之后的页:工作区已经打开(❌ 再判 opening / error)。 */
export type OpenedPageProps = Omit<PhonePageProps, 'machine'> & { machine: AssistantMachine }

/**
 * 读它家里东西的那几页共用的一道门:在休息 / 正在醒 / 连不上(PhoneMachineGate)→ 找不到它的会话 / 工作区没打开(带重试)/ 正在打开,
 * 都过了才把打开的工作区交给 children。❌ 读不到时画一片空。
 */
export function PhoneMachineView({
  readiness,
  machine,
  name,
  children,
}: {
  readiness: PhoneReadiness
  machine: PhoneMachineState
  name: string
  children: (machine: AssistantMachine) => ReactNode
}) {
  const { t } = useTranslation('assistant')
  const inner = (() => {
    if (machine.state === 'no-workdir') return <AssistantEmpty>{t('machine.noWorkdir', { name })}</AssistantEmpty>
    if (machine.state === 'error') return <ReadFailed title={t('machine.openFailed', { name })} error={machine.error} onRetry={machine.retry} />
    if (machine.state === 'opening') return <ReadingNow />
    return children(machine.machine)
  })()
  return (
    <PhoneMachineGate readiness={readiness} name={name}>
      {inner}
    </PhoneMachineGate>
  )
}

/** 读的时候:只一个「在等」(全产品同一个样子)。 */
export function ReadingNow({ label }: { label?: string }) {
  const { t } = useTranslation('assistant')
  return (
    <AssistantEmpty>
      <span className="inline-flex items-center gap-2" role="status">
        <LoadingIndicator size="inline" />
        {label ?? t('library.loading')}
      </span>
    </AssistantEmpty>
  )
}

/** 读失败:标题说是哪一步没读到,下面一句原因,一个「重试」。 */
export function ReadFailed({ title, error, onRetry }: { title: string; error: unknown; onRetry: () => void }) {
  const { t } = useTranslation('assistant')
  return (
    <AssistantEmpty
      title={title}
      action={
        <Button variant="ghost" className="ta-pill-btn" onClick={onRetry} data-testid="assistant-read-retry">
          {t('machine.retry')}
        </Button>
      }
    >
      <span role="alert">{t('machine.readFailed', { message: errorText(error) })}</span>
    </AssistantEmpty>
  )
}

/** 一次读的三种结果:在读 / 读失败(说哪一步)/ 读到了交给 children。 */
export function ReadView<T>({ read, failedTitle, children }: { read: PhoneRead<T> & { reload: () => void }; failedTitle: string; children: (data: T) => ReactNode }) {
  if (read.state === 'loading') return <ReadingNow />
  if (read.state === 'error') return <ReadFailed title={failedTitle} error={read.error} onRetry={read.reload} />
  return <>{children(read.data)}</>
}
