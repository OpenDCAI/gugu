import { dataClient, identityDb } from './supabase'
import { recentErrors } from './errorRingBuffer'
import { uploadPublicMedia } from './publicMedia'

// @@@2037 问题反馈(Phase 1):校验 + 截图上传 + 落库。Phase 2(路由 agent 写 GitHub issue)
// 在服务端消费 identity.feedback,客户端只负责诚实落库——提交失败必须冒泡,禁静默。
// @@@2314 A 档诊断快照:仅在用户点提交那一刻采集(环境/现场/最近报错),随反馈落 diagnostics 列;
// 不提交不上传,非遥测。提交界面须注明会附带诊断信息(透明)。

export const FEEDBACK_MODULES = [
  { value: 'chat' },
  { value: 'agent' },
  { value: 'contacts' },
  { value: 'discover' },
  { value: 'account' },
  { value: 'billing' },
  { value: 'ui' },
  { value: 'other' },
] as const

export type FeedbackModule = (typeof FEEDBACK_MODULES)[number]['value']

export const FEEDBACK_CONTENT_MAX = 2000
export const FEEDBACK_SCREENSHOT_MAX_COUNT = 4
// 5MB 是反馈截图的产品上限(严于 chat-media 桶本身的 10MB file_size_limit),非桶策略同款。
export const FEEDBACK_SCREENSHOT_MAX_BYTES = 5 * 1024 * 1024

export type FeedbackValidationCode =
  | 'content-required'
  | 'content-too-long'
  | 'module-required'
  | 'screenshot-count'
  | 'screenshot-type'
  | 'screenshot-size'

export function validateFeedbackDraft(draft: { content: string; module: string }): FeedbackValidationCode | null {
  if (!draft.content.trim()) return 'content-required'
  if (draft.content.length > FEEDBACK_CONTENT_MAX) return 'content-too-long'
  if (!FEEDBACK_MODULES.some((m) => m.value === draft.module)) return 'module-required'
  return null
}

export function validateFeedbackScreenshot(
  file: { type: string; size: number },
  currentCount: number
): FeedbackValidationCode | null {
  if (currentCount >= FEEDBACK_SCREENSHOT_MAX_COUNT) return 'screenshot-count'
  if (!file.type.startsWith('image/')) return 'screenshot-type'
  if (file.size > FEEDBACK_SCREENSHOT_MAX_BYTES) return 'screenshot-size'
  return null
}

// 截图传 chat-media 公有桶(publicMedia.ts:路径 userId 打头 —— 桶的 RLS 按首段认上传者,feedback 归类放第二段);
// 返回 path 供未提交/失败时清理孤儿对象。
export function uploadFeedbackScreenshot(file: File, userId: string): Promise<{ url: string; path: string }> {
  return uploadPublicMedia(userId, 'feedback', file)
}

export async function cleanupFeedbackScreenshot(path: string): Promise<void> {
  const { error } = await dataClient.storage.from('chat-media').remove([path])
  if (error) console.warn('[feedback] failed to clean up orphaned screenshot:', path, error.message)
}

// 提交那一刻的一次性诊断快照(#2314 A 档字段清单)。纯读环境,无副作用。
export function collectFeedbackDiagnostics(): Record<string, unknown> {
  return {
    ua: navigator.userAgent,
    os_platform: navigator.platform,
    locale: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    screen: `${window.screen.width}x${window.screen.height}`,
    window: `${window.innerWidth}x${window.innerHeight}`,
    device_pixel_ratio: window.devicePixelRatio,
    location: `${window.location.pathname}${window.location.hash}`,
    title: document.title,
    online: navigator.onLine,
    uptime_seconds: Math.round(performance.now() / 1000),
    recent_errors: recentErrors(),
  }
}

/**
 * 用户勾选后附带的日志尾巴(#4899)。
 *
 * ⚠ **不走 chat-media 桶。** 截图走的是公有桶 + getPublicUrl —— 那意味着一条谁拿到链接谁
 * 都能读的公开 URL。截图是用户逐张看过才附上的,日志不是(owner 2026-09-03 定:不强制预览)。
 * 所以日志文本直接进 feedback 这一行,受该表 RLS 管,不产生任何公开 URL。
 */
export interface FeedbackLogAttachment {
  text: string
  lines: number
  truncated: boolean
}

export function feedbackDiagnosticsWithLog(
  diagnostics: Record<string, unknown>,
  log: FeedbackLogAttachment | null
): Record<string, unknown> {
  if (!log) return diagnostics
  return {
    ...diagnostics,
    log_tail: log.text,
    log_tail_lines: log.lines,
    log_tail_truncated: log.truncated,
  }
}

export async function submitFeedback(input: {
  userId: string
  content: string
  module: FeedbackModule
  screenshotUrls: string[]
  appVersion: string
  platform: string
  diagnostics: Record<string, unknown>
}): Promise<void> {
  const { error } = await identityDb.from('feedback').insert({
    user_id: input.userId,
    content: input.content.trim(),
    module: input.module,
    screenshot_urls: input.screenshotUrls,
    app_version: input.appVersion,
    platform: input.platform,
    diagnostics: input.diagnostics,
  })
  if (error) throw new Error(error.message)
}
