import { UI_EVENTS } from '@/lib/uiEvents'

/** Every phone permission entry targets the single My → Permissions page. */
export function openPhonePermissions(): void {
  window.dispatchEvent(new CustomEvent(UI_EVENTS.openSettings, { detail: { section: 'permissions' } }))
}
