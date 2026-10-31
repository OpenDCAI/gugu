import { useChatPinSettings } from './useChatPinSettings'

export function useChatAppPins(chatId: string | null) {
  const pins = useChatPinSettings(chatId, true, 'header.appPinsSaveFailed')
  return {
    ...pins, ids: pins.appIds,
    set: ({ appId, pinned }: { appId: string; pinned: boolean }) => pins.set('pinnedAppIds', appId, pinned),
  }
}
