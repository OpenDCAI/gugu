import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy } from '@/lib/icons'
import { IconButton } from '@/components/ui/IconButton'
import { copyTextWithFeedback } from '@/lib/copyTextWithFeedback'

export function PlatformCopyButton({ text, kind }: { text: string | (() => string); kind: 'code' | 'table' }) {
  const { t } = useTranslation('common')
  const [copied, setCopied] = useState(false)
  const [pending, setPending] = useState(false)
  const generation = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    generation.current += 1
    return () => { generation.current += 1; clearTimeout(timer.current) }
  }, [])
  const copy = async () => {
    const current = generation.current
    setPending(true)
    try {
      await copyTextWithFeedback(text)
      if (current !== generation.current) return
      setCopied(true)
      timer.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      // The common writer has already reported the failure; success remains unset.
    } finally {
      if (current === generation.current) setPending(false)
    }
  }
  const Icon = copied ? Check : Copy
  return <>
    <IconButton size="sm"
      title={t('actions.copy')} aria-label={t('actions.copy')}
      className="cursor-pointer p-1 text-muted-foreground transition-all hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
      data-streamdown={`${kind === 'code' ? 'code-block' : 'table'}-copy-button`} data-copied={copied || undefined}
      disabled={pending || copied} onClick={() => { void copy() }}
    ><Icon aria-hidden="true" size={14} /></IconButton>
    {copied && <output aria-live="polite" className="sr-only">{t('agentShare.copied')}</output>}
  </>
}

