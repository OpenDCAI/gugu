import { useState } from 'react'
import type { ChatCommands } from '@gugu/session-chat-ui'
import { changeRejectedSessionInput, retrySessionInputs, useQueuedSessionInputs } from '@/lib/sessionInputOutboxBridge'
import { messageForUser } from '@/lib/userFacingError'
import { toast } from '@renderer/lib/hooks/use-toast'
import { translateSessionMessage } from '@renderer/localization/locale-store'

/** Bind sender-owned refusals to the transcript's existing editor and failed-message actions. */
export function useRejectedSessionInputCommands(sessionId: string): ChatCommands {
  const inputs = useQueuedSessionInputs(sessionId)
  const [edit, setEdit] = useState<{ itemId: string; text: string; pending: boolean } | null>(null)
  const rejected = (id: string) => inputs.find(input => input.id === id && input.admission === 'rejected')
  const report = (error: unknown) => toast({ title: translateSessionMessage('acpFailure.sendMessage'), description: messageForUser(error), variant: 'destructive' })
  return {
    canRevertMessage: id => !!rejected(id),
    canDiscardSend: id => !!rejected(id),
    onEditMessage: ({ itemId }) => { const input = rejected(itemId); if (input) setEdit({ itemId, text: input.text, pending: false }) },
    onDiscardSend: id => { void changeRejectedSessionInput(id, { kind: 'discard' }).catch(report) },
    onRetrySend: id => { void (rejected(id) ? changeRejectedSessionInput(id, { kind: 'retry' }) : retrySessionInputs()).catch(report) },
    editingMessage: edit && rejected(edit.itemId) ? {
      ...edit, canSubmit: !edit.pending && !!edit.text.trim(),
      onChange: text => setEdit({ ...edit, text }), onCancel: () => setEdit(null),
      onSubmit: () => {
        if (edit.pending || !edit.text.trim()) return
        setEdit({ ...edit, pending: true })
        void changeRejectedSessionInput(edit.itemId, { kind: 'edit', text: edit.text })
          .then(() => { setEdit(null); return changeRejectedSessionInput(edit.itemId, { kind: 'retry' }) })
          .catch(error => { setEdit({ ...edit, pending: false }); report(error) })
      },
    } : undefined,
  }
}
