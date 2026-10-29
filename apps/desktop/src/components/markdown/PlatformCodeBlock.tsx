import { useEffect, useRef, useState, type ComponentProps } from 'react'
import { useTranslation } from 'react-i18next'
import { CodeBlock, defaultComponents, useIsCodeFenceIncomplete } from 'streamdown'
import { Check, Copy } from '@/lib/icons'
import { copyTextWithFeedback } from '@/lib/copyTextWithFeedback'

function CodeCopyButton({ code }: { code: string }) {
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
      await copyTextWithFeedback(code)
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
    <button
      type="button" title={t('actions.copy')} aria-label={t('actions.copy')}
      className="cursor-pointer p-1 text-muted-foreground transition-all hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
      data-streamdown="code-block-copy-button" data-copied={copied || undefined}
      disabled={pending || copied} onClick={() => { void copy() }}
    ><Icon aria-hidden="true" size={14} /></button>
    {copied && <output aria-live="polite" className="sr-only">{t('agentShare.copied')}</output>}
  </>
}

const DefaultCode = defaultComponents.code

/** Use Streamdown's code container/highlighter and action placement with the host's clipboard transport. */
export function PlatformCodeBlock({ children, node, className, ...props }: ComponentProps<typeof DefaultCode>) {
  const incomplete = useIsCodeFenceIncomplete()
  const language = /language-([^\s]+)/.exec(className ?? '')?.[1] ?? ''
  // Inline spans and the custom Mermaid renderer retain Streamdown's original pipeline.
  if (!('data-block' in props) || language === 'mermaid') {
    return <DefaultCode {...props} node={node} className={className}>{children}</DefaultCode>
  }
  const { 'data-block': _block, ...rest } = props
  const code = typeof children === 'string' ? children : ''
  return <CodeBlock {...rest} code={code} language={language} className={className} isIncomplete={incomplete} lineNumbers={false}>
    <CodeCopyButton key={code} code={code} />
  </CodeBlock>
}
