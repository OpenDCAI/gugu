import type { Device } from '@gugu/core/shared/types/chat'
import { APP_OPEN_WITH_EVENT, type AppOpenWithDetail } from '../../session/shared/extensions/app-runtime-protocol'
import { AppPeekSlot } from './AppPeekSlot'
import { PhoneAppFrame } from './PhoneAppFrame'
import { useTaskConversation } from '@/lib/taskConversation'

/**
 * owner 10-16 An App's tab on the phone's session page: its page here (the phone draws it, as a desktop does), its program on
 * the computer the session is on — `callProgram` goes there (`app_call`), and what that program sends comes back through
 * that computer's window (`extensions.program.notified`). The same frame and host as a chat's App (PhoneAppFrame).
 * With no session, the App's page of its own, opened from the phone's 「App」 page: in no chat and no session, as the
 * desktop's rail opens it — every call names its target.
 */
export function SessionAppFrame({ kind, device, session }: { kind: string; device?: Device; session?: { id: string; projectId?: string } }) {
  const tabId = session ? `session-app:${session.id}:${kind}` : `app-page:${kind}`
  // A session's tab is in the person's private chat with its agent (`AppWhere`), as on the desktop.
  const conversation = useTaskConversation(session?.id, device?.device_id)
  return (
    // What the page opens beside it (G1) goes over it, with its back first (AppPeekSlot).
    <AppPeekSlot sessionId={null} tabId={tabId} narrow>
      <PhoneAppFrame
        kind={kind}
        tabId={tabId}
        chatId={session ? conversation : null}
        {...(session && device
          ? { session: { id: session.id, deviceId: device.device_id, deviceLabel: device.label, online: device.is_online, ...(session.projectId ? { projectId: session.projectId } : {}) } }
          : {})}
        // A chat file it names opens in that chat: the chat shell brings it up (MainLayout), as a link to it does.
        onOpenWith={(detail) => window.dispatchEvent(new CustomEvent<AppOpenWithDetail>(APP_OPEN_WITH_EVENT, { detail }))}
        testId={session ? 'session-app-frame' : 'app-page-frame'}
        missingTestId="session-app-missing"
      />
    </AppPeekSlot>
  )
}
