import { GUGU_ANDROID_DOWNLOAD_URL } from './appLinks'

// 分享邀请的承载基址。优先专用 web 落地页(VITE_GUGU_WEB_URL/invite);构建期未配置该 env 时,
// 退回 Android 下载页。这个函数只决定发出侧 URL，不参与接收侧 payload 识别。
export function inviteLandingBase(): string {
  const raw = ((import.meta.env.VITE_GUGU_WEB_URL as string | undefined) ?? '').trim().replace(/\/+$/, '')
  return raw ? `${raw}/invite` : GUGU_ANDROID_DOWNLOAD_URL
}
