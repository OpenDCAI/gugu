import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { publicAssetPath } from '@gugu/core/shared/ui/publicAssets'
import { useAuth } from '../store/auth'
import { useToast } from './toastContext'
import { Sheet } from './ui/Sheet'
import { Button } from './ui/Button'
import { Switch } from './ui/Switch'
import { platform } from '../platform'
import {
  FEEDBACK_MODULES,
  FEEDBACK_CONTENT_MAX,
  FEEDBACK_SCREENSHOT_MAX_COUNT,
  validateFeedbackDraft,
  validateFeedbackScreenshot,
  uploadFeedbackScreenshot,
  cleanupFeedbackScreenshot,
  submitFeedback,
  collectFeedbackDiagnostics,
  feedbackDiagnosticsWithLog,
  type FeedbackLogAttachment,
  type FeedbackModule,
  type FeedbackValidationCode,
} from '../lib/feedback'
import {
  loadFeedbackDraft,
  saveFeedbackDraft,
  clearFeedbackDraft,
  isFeedbackDraftEmpty,
  fileToDataUrl,
  dataUrlToFile,
  type FeedbackDraftImage,
} from '../lib/feedbackDraft'

declare const __APP_VERSION__: string

// @@@4326 致谢插画 —— 咕咕捧着刚寄到的那封反馈信。官网现役 mascot(gugu-edge-mascot)为参考图,
// 同一套黑描边 / 黄喙 / 鼠尾草绿挎包,所以它与产品其它咕咕是同一只鸟。透明底单张:白身子在深色主题上
// 自己就是剪影,黑描边在浅色主题上自己就是线稿 —— 两套主题共用一张,不做双版本。
const GUGU_THANKS_URL = publicAssetPath('/assets/feedback/gugu-thanks.webp')

// 插画的显示尺寸写死在两个轴上(宽 106 = 高 150 × 原图 298/420 比例):加载失败时 <img> 仍占住这个盒子,
// 下面的文案与按钮不会往上塌(issue 的降级要求)。❌ 不加 onError 兜底换图——那是假装成功。
const THANKS_ART_HEIGHT = 150
const THANKS_ART_WIDTH = 106

// @@@2062 问题反馈弹窗:截图改「提交才上传」——草稿期图只以 dataURL 留本地(粘贴 Ctrl/Cmd+V 或选文件),
// 关窗(X / 取消 / Esc / 背景点击)保留草稿到 IndexedDB、重开续填,提交时才上传进桶(未提交绝不进公有桶,
// 隐私红线天然满足)。单张删走缩略图右上角 ×(与关弹窗的 × 正交)。成功/失败/边界都有明确 toast,禁静默。
export function FeedbackModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('settings')
  const { user } = useAuth()
  const { toast } = useToast()

  const [content, setContent] = useState('')
  const [module, setModule] = useState<FeedbackModule>('chat')
  const [shots, setShots] = useState<FeedbackDraftImage[]>([])
  const [submitting, setSubmitting] = useState(false)
  // @@@4899 勾上那一刻就去读日志,❌ 不等到提交:读不到要当场取消勾选并说明,
  // 而不是提交时静默漏掉(用户以为给了线索,排查方以为用户没日志)。
  const [attachedLog, setAttachedLog] = useState<FeedbackLogAttachment | null>(null)
  const [readingLog, setReadingLog] = useState(false)
  // 提交成功后停在致谢态(而不是立刻关窗):感谢发生在用户已经付出之后,这一刻本来是空的。
  const [submitted, setSubmitted] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const validationMessage = (code: FeedbackValidationCode): string => ({
    'content-required': t('feedback.validation.contentRequired'),
    'content-too-long': t('feedback.validation.contentTooLong', { max: FEEDBACK_CONTENT_MAX }),
    'module-required': t('feedback.validation.moduleRequired'),
    'screenshot-count': t('feedback.validation.screenshotCount', { max: FEEDBACK_SCREENSHOT_MAX_COUNT }),
    'screenshot-type': t('feedback.validation.screenshotType'),
    'screenshot-size': t('feedback.validation.screenshotSize'),
  })[code]

  // 版本:构建期常量打底,Electron 上用主进程实时值刷新(同 AboutSection,拒不吞错)。
  const [version, setVersion] = useState(__APP_VERSION__)
  useEffect(() => {
    if (!platform.capabilities.appVersion) return
    void platform.getAppVersion().then(setVersion)
  }, [])

  // 把当前表单快照进 ref,供关窗写草稿 + 载入时判「是否仍为空态」(避免闭包读到旧值)。
  const submittedRef = useRef(false)
  const draftRef = useRef({ content, module, shots })
  draftRef.current = { content, module, shots }

  // 开窗:载入上次未提交的草稿(文字 + 模块 + 图),续填。仅在表单仍是初始空态时回填——新挂载(重开)
  // 是空态 → 续填;若 user 引用变化(owner token resync)重跑时用户可能正在编辑(非空)→ 不覆盖。
  // ❌ 不用 loadedRef「只载一次」守卫:它与 React StrictMode 双调用 + alive 清理相冲——run1 置 ref 后被
  // 自身 cleanup 设 alive=false 吞掉回填,run2 又被 ref 挡掉 → 重开草稿彻底丢(e2e 实测)。
  useEffect(() => {
    if (!user) return
    let alive = true
    void loadFeedbackDraft(user.id).then((draft) => {
      if (!alive || !draft) return
      const cur = draftRef.current
      if (cur.content !== '' || cur.shots.length > 0) return // 用户在编辑 → 别覆盖
      setContent(draft.content)
      if (FEEDBACK_MODULES.some((m) => m.value === draft.module)) setModule(draft.module as FeedbackModule)
      setShots(draft.images)
    })
    return () => { alive = false }
  }, [user])

  // 校验 + 追加图(粘贴 / 选文件共用)。fail loud:非图 / 超大 / 超 4 张 明确提示。
  const addImages = async (files: File[]) => {
    if (files.length === 0) return
    let count = draftRef.current.shots.length
    for (const file of files) {
      const invalid = validateFeedbackScreenshot(file, count)
      if (invalid) {
        toast(validationMessage(invalid), 'error')
        continue
      }
      try {
        const dataUrl = await fileToDataUrl(file)
        count += 1
        setShots((prev) => [...prev, { id: crypto.randomUUID(), dataUrl, name: file.name || 'screenshot.png' }])
      } catch (err) {
        toast(t('feedback.screenshotReadFailed', { error: (err as Error).message }), 'error')
      }
    }
  }

  // Ctrl/Cmd+V 粘贴:从 clipboardData 提图片文件(同 InputArea 范式);有图才拦截,纯文本粘贴照常落输入框。
  const handlePaste = (e: React.ClipboardEvent) => {
    const imgs = Array.from(e.clipboardData.items)
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter((f): f is File => f !== null)
    if (imgs.length > 0) {
      e.preventDefault()
      void addImages(imgs)
    }
  }

  const removeShot = (id: string) => {
    // 草稿图从没进桶,删除只是移出本地状态——无孤儿可清(隐私红线)。
    setShots((prev) => prev.filter((s) => s.id !== id))
  }

  // 关窗 = 保留草稿(X 图标 / Esc / 背景点击):未提交且非空 → 存草稿续填;空草稿 → 清残留。
  // (语义假设,issue「点 X(非取消)保留」:X/Esc/背景=「暂离,回头补」保留;取消按钮=「弃稿」→ handleCancel。
  //  owner 评论区若要取消也保留,把 handleCancel 换成 handleClose 即可。)
  const handleClose = () => {
    if (user && !submittedRef.current) {
      const d = draftRef.current
      const draft = { content: d.content, module: d.module, images: d.shots }
      if (isFeedbackDraftEmpty(draft)) void clearFeedbackDraft(user.id)
      else void saveFeedbackDraft(user.id, draft)
    }
    onClose()
  }

  // 取消 = 弃稿:清掉本地草稿(从没进桶,无孤儿)并关闭。取消按钮直接调本函数(不经 Sheet.onClose),
  // 故不会再触发 handleClose 把状态写回草稿。
  const handleCancel = () => {
    if (user) void clearFeedbackDraft(user.id)
    onClose()
  }

  const handleAttachLogChange = async (next: boolean) => {
    if (!next) { setAttachedLog(null); return }
    setReadingLog(true)
    try {
      const tail = await platform.readLogTail()
      setAttachedLog({ text: tail.text, lines: tail.lines, truncated: tail.truncated })
    } catch {
      // 读不到就保持未勾选。原因对用户没有可操作性(路径、权限码),所以不往这句里拼。
      setAttachedLog(null)
      toast(t('feedback.attachLog.unavailable'), 'error')
    } finally {
      setReadingLog(false)
    }
  }

  const handleSubmit = async () => {
    if (!user) return
    const invalid = validateFeedbackDraft({ content, module })
    if (invalid) {
      toast(validationMessage(invalid), 'info')
      return
    }
    setSubmitting(true)
    const uploaded: { url: string; path: string }[] = []
    try {
      // 提交才上传:草稿 dataURL → File → 桶。全成功后才落库。
      for (const shot of shots) {
        const u = await uploadFeedbackScreenshot(dataUrlToFile(shot.dataUrl, shot.name), user.id)
        uploaded.push({ url: u.url, path: u.path })
      }
      await submitFeedback({
        userId: user.id,
        content,
        module,
        screenshotUrls: uploaded.map((u) => u.url),
        appVersion: version,
        platform: platform.kind,
        diagnostics: feedbackDiagnosticsWithLog(collectFeedbackDiagnostics(), attachedLog),
      })
      submittedRef.current = true
      await clearFeedbackDraft(user.id)
      toast(t('feedback.submitted'), 'success')
      setSubmitted(true)
    } catch (err) {
      // 落库/上传失败:清掉本次刚传上去的孤儿(它们已无引用),草稿仍在本地可重试(不清)。fail loud。
      for (const u of uploaded) void cleanupFeedbackScreenshot(u.path)
      toast(t('feedback.submitFailed', { error: (err as Error).message }), 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const fieldLabel: React.CSSProperties = { fontSize: 'var(--font-body)', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }
  const required = <span style={{ color: 'var(--badge-red)' }}> *</span>

  return (
    <Sheet onClose={handleClose} desktopWidth="min(440px, 100%)" desktopMaxHeight="min(88vh, calc(100dvh - 32px))" testId="feedback-modal" ariaLabel={t('feedback.title')}>
      <div onPaste={handlePaste} style={{ position: 'relative', padding: '22px 22px 20px', display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1, overflow: 'hidden' }}>
        <button
          type="button"
          onClick={handleClose}
          title={t('feedback.close')}
          aria-label={t('feedback.close')}
          style={{ position: 'absolute', top: 18, right: 18, border: 'none', background: 'transparent', color: 'var(--faint-fg)', cursor: 'pointer', padding: 0, display: 'grid', placeItems: 'center' }}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="10" /><path strokeLinecap="round" d="m14.5 9.5l-5 5m0-5l5 5" /></g></svg>
        </button>

        {submitted ? (
          // 致谢态:表单让位给咕咕。进场沿用 Sheet 那条已调好的 pop-in —— 时长曲线读 token,
          // 与 sheetMotion.ts 里桌面卡片那条同源(#4323);reduced-motion 下退化为静止。
          <div
            data-testid="feedback-thanks"
            className="animate-[gg-sheet-pop-in_var(--dur-med)_var(--ease-spring)] motion-reduce:animate-none"
            style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '18px 6px 4px', gap: 0 }}
          >
            <img
              src={GUGU_THANKS_URL}
              alt={t('feedback.thanks.illustrationAlt')}
              width={THANKS_ART_WIDTH}
              height={THANKS_ART_HEIGHT}
              draggable={false}
              style={{ width: THANKS_ART_WIDTH, height: THANKS_ART_HEIGHT, objectFit: 'contain', display: 'block' }}
            />
            <div style={{ fontSize: 'var(--font-heading)', fontWeight: 600, color: 'var(--text-primary)', marginTop: 16 }}>{t('feedback.thanks.title')}</div>
          </div>
        ) : (
        <>
        <h3 style={{ fontSize: 'var(--font-heading)', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 16 }}>{t('feedback.title')}</h3>

        <div style={{ overflowY: 'auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {/* 问题描述(必填,限长计数) */}
          <div style={fieldLabel}>{t('feedback.description')}{required}</div>
          <div style={{ position: 'relative', marginBottom: 14 }}>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              maxLength={FEEDBACK_CONTENT_MAX}
              rows={4}
              placeholder={t('feedback.descriptionPlaceholder')}
              style={{ width: '100%', resize: 'vertical', minHeight: 88, padding: '9px 11px 22px', borderRadius: 'var(--radius-control)', border: '1px solid var(--border-strong)', background: 'var(--muted)', fontSize: 'var(--font-body)', color: 'var(--text-primary)', outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit' }}
            />
            <span style={{ position: 'absolute', right: 10, bottom: 8, fontSize: 'var(--font-caption)', color: 'var(--faint-fg)' }}>
              {content.length}/{FEEDBACK_CONTENT_MAX}
            </span>
          </div>

          {/* 问题模块(下拉) */}
          <div style={fieldLabel}>{t('feedback.module')}{required}</div>
          <select
            value={module}
            onChange={(e) => setModule(e.target.value as FeedbackModule)}
            style={{ width: '100%', padding: '8px 11px', borderRadius: 'var(--radius-control)', border: '1px solid var(--border-strong)', background: 'var(--muted)', fontSize: 'var(--font-body)', color: 'var(--text-primary)', outline: 'none', marginBottom: 14, boxSizing: 'border-box' }}
          >
            {FEEDBACK_MODULES.map((m) => (
              <option key={m.value} value={m.value}>{t(`feedback.modules.${m.value}`)}</option>
            ))}
          </select>

          {/* 截图(可选,多张;粘贴或选文件;提交才上传) */}
          <div style={fieldLabel}>
            {t('feedback.screenshots')}
            <span style={{ fontWeight: 400, color: 'var(--faint-fg)' }}>
              {shots.length > 0
                ? t('feedback.screenshotsAdded', { count: shots.length })
                : t('feedback.screenshotsOptional')}
            </span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
            {shots.map((s) => (
              <div key={s.id} style={{ position: 'relative', width: 64, height: 64 }}>
                <img src={s.dataUrl} alt={s.name} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'var(--radius-control)', border: '1px solid var(--border-strong)' }} />
                <button
                  type="button"
                  onClick={() => removeShot(s.id)}
                  title={t('feedback.removeScreenshot')}
                  aria-label={t('feedback.removeScreenshotLabel', { name: s.name })}
                  style={{ position: 'absolute', top: -6, right: -6, width: 18, height: 18, borderRadius: 'var(--radius-capsule)', border: 'none', background: 'var(--text-primary)', color: 'var(--bg)', fontSize: 'var(--font-caption)', lineHeight: 1, cursor: 'pointer', display: 'grid', placeItems: 'center' }}
                >
                  ×
                </button>
              </div>
            ))}
            {shots.length < FEEDBACK_SCREENSHOT_MAX_COUNT && (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                title={t('feedback.addScreenshot')}
                aria-label={t('feedback.addScreenshot')}
                style={{ width: 64, height: 64, borderRadius: 'var(--radius-control)', border: '1.5px dashed var(--border-strong)', background: 'transparent', color: 'var(--faint-fg)', fontSize: 22, cursor: 'pointer', display: 'grid', placeItems: 'center' }}
              >
                +
              </button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={(e) => { void addImages(Array.from(e.target.files ?? [])); if (fileInputRef.current) fileInputRef.current.value = '' }}
              style={{ display: 'none' }}
            />
          </div>

          {/* @@@4899 附带日志:opt-in。web / 移动壳没有本地日志文件,整块不渲染(❌ 渲染一个点不动的框) */}
          {platform.capabilities.logTail && (
            <div data-testid="feedback-attach-log" className="mb-2.5 flex items-start gap-2">
              <Switch
                checked={attachedLog !== null}
                disabled={readingLog}
                onCheckedChange={(next) => void handleAttachLogChange(next)}
                aria-label={t('feedback.attachLog.label')}
              />
              <span className="text-xs leading-relaxed text-[var(--faint-fg)]">
                {t('feedback.attachLog.label')}
                {/* 不强制预览(owner 2026-09-03 定),但**附带了多少**要如实摆出来 */}
                {attachedLog && (
                  <span data-testid="feedback-attach-log-size" className="block text-[var(--text-primary)]">
                    {t('feedback.attachLog.attached', { lines: attachedLog.lines })}
                  </span>
                )}
              </span>
            </div>
          )}

          {/* 自动附带信息提示 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', borderRadius: 'var(--radius-control)', background: 'var(--muted)', fontSize: 'var(--font-body)', color: 'var(--faint-fg)', marginBottom: 16 }}>
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" style={{ flexShrink: 0 }}><g fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="10" /><path strokeLinecap="round" d="M12 17v-6" /><circle cx="12" cy="7.5" r="0.5" fill="currentColor" /></g></svg>
            {t('feedback.diagnostics', { version })}
          </div>
        </div>

        {/* 底部:取消 / 提交 */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleCancel}
          >
            {t('feedback.cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void handleSubmit()}
            disabled={submitting}
          >
            {submitting ? t('feedback.submitting') : t('feedback.submit')}
          </Button>
        </div>
        </>
        )}

        {submitted && (
          <div style={{ display: 'flex', justifyContent: 'center', marginTop: 20 }}>
            <Button variant="primary" size="sm" onClick={onClose}>
              {t('feedback.thanks.done')}
            </Button>
          </div>
        )}
      </div>
    </Sheet>
  )
}
