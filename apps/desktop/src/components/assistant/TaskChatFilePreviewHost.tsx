import { useMemo, useState, type ReactNode } from 'react'
import { FilePreviewHost } from '../chat/filePreviewHost'
import { cn } from '../../lib/cn'

/** Desktop files occupy the task pane, keeping its conversation and draft mounted underneath. Mobile uses the normal file sheet. */
export function TaskChatFilePreviewHost({ mobile, children }: { mobile: boolean; children: ReactNode }) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const host = useMemo(() => ({ target, onOpenChange: setOpen, chatNavigation: true }), [target])
  return <FilePreviewHost.Provider value={mobile ? null : host}>
    <div className={cn('task-chat-conversation min-h-0 min-w-0 flex-1 flex-col', open ? 'hidden' : 'flex')}>
      {children}
    </div>
    {!mobile && <div ref={setTarget} data-testid="task-chat-file-preview" className={cn('task-chat-file-preview min-h-0 min-w-0 flex-1', !open && 'hidden')} />}
  </FilePreviewHost.Provider>
}
