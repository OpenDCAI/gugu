import { useActionBarCopy } from '@assistant-ui/core/react'
import { Check, Copy } from '@/lib/icons'
import { copyTextWithFeedback } from '@/lib/copyTextWithFeedback'
import { useAuiCopy } from './copy'
import { TooltipIconButton } from './tooltip-icon-button'

/** The official hook retains editing text, scoped copied state and its cleanup timer. */
export function MessageCopyButton() {
  const c = useAuiCopy()
  const { copy, disabled, isCopied } = useActionBarCopy({ copyToClipboard: copyTextWithFeedback })
  return (
    <TooltipIconButton tooltip={c.copy} onClick={copy} disabled={disabled} data-copied={isCopied || undefined}>
      {isCopied
        ? <Check className="animate-in zoom-in-50 fade-in duration-200 ease-out" />
        : <Copy className="animate-in zoom-in-75 fade-in duration-150" />}
    </TooltipIconButton>
  )
}
