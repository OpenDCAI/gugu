import { GUGU_ANDROID_DOWNLOAD_URL } from './appLinks'

/** Configured invitation web page. An installer download cannot accept a referral. */
export function webInviteLandingBase(): string | null {
  const raw = ((import.meta.env.VITE_GUGU_WEB_URL as string | undefined) ?? '').trim().replace(/\/+$/, '')
  return raw ? `${raw}/invite` : null
}

// Existing group QR payloads also support the install-and-scan flow.
export function inviteLandingBase(): string {
  return webInviteLandingBase() ?? GUGU_ANDROID_DOWNLOAD_URL
}
