import { dataClient, identityDb } from './supabase'
import { recentErrors } from './errorRingBuffer'
import { FEEDBACK_SCREENSHOT_BUCKET } from './feedbackMedia'
import { mobileListDiagnostics } from '../mobile/mobileListDiagnostics'

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
// 反馈截图的产品上限与私有存储限制一致。
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

// 草稿保持在本机，只有明确提交时才上传到私有存储。
export async function uploadFeedbackScreenshot(file: File, userId: string): Promise<{ path: string }> {
  const safeName = file.name.replace(/[^A-Za-z0-9._-]+/g, '_') || 'screenshot'
  const path = `${userId}/${crypto.randomUUID()}-${safeName}`
  const { error } = await dataClient.storage.from(FEEDBACK_SCREENSHOT_BUCKET)
    .upload(path, file, { contentType: file.type, upsert: false })
  if (error) throw new Error(error.message)
  return { path }
}

export async function cleanupFeedbackScreenshot(path: string): Promise<void> {
  const { error } = await dataClient.storage.from(FEEDBACK_SCREENSHOT_BUCKET).remove([path])
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
    mobile_list_diagnostics: mobileListDiagnostics.recent(),
  }
}

/**
 * 用户勾选后附带的日志尾巴(#4899)。
 *
 * 日志直接进 feedback 这一行，受该表 RLS 管理；截图单独存于私有存储。
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
  screenshotPaths: string[]
  appVersion: string
  platform: string
  diagnostics: Record<string, unknown>
}): Promise<void> {
  const { error } = await identityDb.from('feedback').insert({
    user_id: input.userId,
    content: input.content.trim(),
    module: input.module,
    screenshot_paths: input.screenshotPaths,
    app_version: input.appVersion,
    platform: input.platform,
    diagnostics: input.diagnostics,
  })
  if (error) throw new Error(error.message)
}

/** Only objects from this failed submission are eligible for orphan cleanup. */
export async function submitFeedbackWithScreenshots(input: Omit<Parameters<typeof submitFeedback>[0], 'screenshotPaths'> & {
  screenshots: File[]
}): Promise<void> {
  const paths: string[] = []
  try {
    for (const file of input.screenshots) paths.push((await uploadFeedbackScreenshot(file, input.userId)).path)
    await submitFeedback({ ...input, screenshotPaths: paths })
  } catch (error) {
    await Promise.all(paths.map(cleanupFeedbackScreenshot))
    throw error
  }
}
