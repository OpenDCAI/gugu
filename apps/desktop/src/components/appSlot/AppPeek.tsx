import { lazy, Suspense, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, Maximize2, X } from '@/lib/icons'
import { sessionPeek } from '../../session/renderer/app/session-peek'
import { APP_OPEN_WITH_EVENT, type AppOpenWithDetail, type PeekTarget } from '../../session/shared/extensions/app-runtime-protocol'
import type { FileOpenerCandidate } from '../../session/shared/extensions/file-openers'
import { useMobileShell } from '../../hooks/useMobileShell'
import { platform } from '../../platform'
import { MessageFilePreview } from '../chat/MessageFilePreview'
import { IconButton } from '../ui/IconButton'
import { PaneHeader } from '../ui/Pane'
import { ClaimedPage } from './ClaimedPage'
import { PhoneAppFrame } from './PhoneAppFrame'
import { OpenWithPick } from './OpenWithPick'

// Desktop-only and phone-only halves, loaded where they are drawn.
const PeekLocalFile = lazy(() => import('../../session/renderer/features/extensions/peek-local-file').then((m) => ({ default: m.PeekLocalFile })))
const PeekSessionTimeline = lazy(() => import('../../mobile/agent-watch/PeekSessionTimeline').then((m) => ({ default: m.PeekSessionTimeline })))

export function AppPeek({ target, slotKey, beside, onClose }: { target: PeekTarget; slotKey: string; beside: boolean; onClose: () => void }) {
  const { t } = useTranslation('messaging')
  const mobile = useMobileShell()
  // A chat file nobody here opens is the host's own preview, header and all (its back closes the peek).
  if (target.kind === 'chat' && target.detail.choice.kind === 'none') {
    const { detail } = target
    return <MessageFilePreview key={`${detail.itemId}:${detail.file.version}`} fill mobile={mobile} file={{ kind: 'file', document: detail.file.document, fileName: detail.name, mimeType: detail.file.contentType, sizeBytes: detail.file.size, source: { kind: 'item', itemId: detail.itemId, version: detail.file.version } }} onClose={onClose} />
  }
  const title = target.kind === 'chat' ? target.detail.name : target.kind === 'local' ? target.name : t('chatArea.peek.session')
  const full = openFull(target)
  return (
    <>
      <PaneHeader
        title={title}
        divider
        {...(mobile ? { mobile: true } : {})}
        leading={beside ? undefined : (
          <IconButton size={mobile ? 'lg' : 'sm'} data-testid="app-peek-back" onClick={onClose} aria-label={t('chatArea.openWith.back')}>
            <ChevronLeft />
          </IconButton>
        )}
        actions={
          <>
            {full ? (
              <IconButton size={mobile ? 'lg' : 'sm'} data-testid="app-peek-full" onClick={() => (full(), onClose())} aria-label={t('chatArea.peek.openFull')} title={t('chatArea.peek.openFull')}>
                <Maximize2 />
              </IconButton>
            ) : null}
            {beside ? (
              <IconButton size="sm" data-testid="app-peek-close" onClick={onClose} aria-label={t('common.close')}>
                <X />
              </IconButton>
            ) : null}
          </>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col bg-[var(--bg-primary)]">
        <Suspense fallback={null}>
          {target.kind === 'chat' ? (
            <ChatFileOpener detail={target.detail} slotId={`${slotKey}#peek`} />
          ) : target.kind === 'local' ? (
            <PeekLocalFile target={target} tabId={`peek:${slotKey}`} />
          ) : platform.kind === 'electron' ? (
            <SessionPeekBox sessionId={target.sessionId} projectId={target.projectId} />
          ) : (
            <PeekSessionTimeline sessionId={target.sessionId} onBack={onClose} />
          )}
        </Suspense>
      </div>
    </>
  )
}

/** Where the peek's 「open in full」 goes: where the thing lives, the way it opens without a peek; none for a project's file. */
function openFull(target: PeekTarget): (() => void) | null {
  if (target.kind === 'chat') return () => window.dispatchEvent(new CustomEvent<AppOpenWithDetail>(APP_OPEN_WITH_EVENT, { detail: target.detail }))
  if (target.kind === 'session' && platform.kind === 'electron') {
    return () => void import('./peekFullSession').then(({ openSessionInFull }) => openSessionInFull(target))
  }
  return null
}

/** A chat file an App here opens: that App's page made for the file (as 「用 X 打开」 makes it); several, the person picks. */
function ChatFileOpener({ detail, slotId }: { detail: AppOpenWithDetail; slotId: string }) {
  const [picked, setPicked] = useState<FileOpenerCandidate | null>(detail.choice.kind === 'one' ? detail.choice.candidate : null)
  if (!picked) {
    return detail.choice.kind === 'choose' ? (
      <div className="!p-4"><OpenWithPick detail={{ ...detail, choice: detail.choice }} onPick={setPicked} testId="app-peek-open-with" /></div>
    ) : null
  }
  return platform.kind === 'electron' ? (
    <ClaimedPage slotId={slotId} chatId={detail.chatId} kind={picked.tabKind} itemId={detail.itemId} />
  ) : (
    <PhoneAppFrame
      kind={picked.tabKind}
      tabId={slotId}
      chatId={detail.chatId}
      itemId={detail.itemId}
      onOpenWith={(asked) => window.dispatchEvent(new CustomEvent<AppOpenWithDetail>(APP_OPEN_WITH_EVENT, { detail: asked }))}
      testId="app-peek-frame"
      missingTestId="app-peek-missing"
    />
  )
}

/**
 * Desktop: the box a session's own page is drawn over (`sessionPeek`, workspace.tsx) — the same page, conversation and
 * composer as its row opens, never a second one. Held while this box is up.
 */
function SessionPeekBox({ sessionId, projectId }: { sessionId: string; projectId: string }) {
  const [box, setBox] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!box) return undefined
    sessionPeek.open({ sessionId, projectId, box })
    return () => sessionPeek.close(sessionId)
  }, [box, sessionId, projectId])
  return <div ref={setBox} className="min-h-0 flex-1" data-testid="app-peek-session" />
}
