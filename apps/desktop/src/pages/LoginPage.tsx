import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { publicAssetPath } from '@gugu/core/shared/ui/publicAssets'
import { authService } from '../lib/auth'
import { sessionCoordinator } from '../lib/sessionCoordinator'
import { Trans, useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion'

// @@@packaged-file-assets - Packaged Electron loads dist/index.html via file://, so public assets must not start at filesystem root.
const APP_LOGO_URL = publicAssetPath('/assets/app/gugu-icon-512.png') // 应用标识只此一张(gen-app-icons.py 产出),与 Dock / 关于页同源

type Step = 'email' | 'otp'

/** 一步表单的进出:常态横移 10 + 淡入淡出 150ms;减弱动态时即时换上,没有位移、没有淡出。 */
function stepMotion(reduceMotion: boolean, enterFrom: number) {
  if (reduceMotion) return { initial: false as const, animate: { opacity: 1, x: 0 }, transition: { duration: 0 } }
  return {
    initial: { opacity: 0, x: enterFrom },
    animate: { opacity: 1, x: 0 },
    exit: { opacity: 0, x: -enterFrom },
    // @@@2322 framer-motion 数值 API 无法引用 CSS token(--dur-fast/--ease) → 字面值保留
    transition: { duration: 0.15, ease: 'easeOut' as const },
  }
}

// ─── Dark input field ─────────────────────────────────────────────────────────

interface DarkInputFieldProps {
  type?: string
  value: string
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  placeholder: string
  autoComplete?: string
  rightSlot?: React.ReactNode
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode']
  maxLength?: number
  inputStyle?: React.CSSProperties
}

function DarkInputField({ type = 'text', value, onChange, placeholder, autoComplete, rightSlot, inputMode, maxLength, inputStyle }: DarkInputFieldProps) {
  return (
    <div style={{ position: 'relative' }}>
      <input
        type={type}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        autoComplete={autoComplete}
        inputMode={inputMode}
        maxLength={maxLength}
        // @@@2322 P2.5 — focus 态 accent 描边已删:无焦点环定稿(光标即焦点指示)
        className="gg-input gg-pressable gugu-auth-input"
        style={{
          width: '100%',
          boxSizing: 'border-box',
          background: 'var(--auth-card-input-bg)',
          border: '1px solid var(--auth-card-input-border)',
          borderRadius: 'var(--radius-control)',
          padding: `0 ${rightSlot ? '40px' : '12px'} 0 12px`,
          fontSize: 'var(--font-body)',
          color: 'var(--auth-card-text-strong)',
          fontFamily: 'var(--font-family-system)',
          ...inputStyle,
        }}
      />
      {rightSlot && (
        <span style={{
          position: 'absolute',
          right: '12px',
          top: '50%',
          transform: 'translateY(-50%)',
          color: 'var(--auth-card-text-faint)',
          display: 'flex',
          alignItems: 'center',
        }}>
          {rightSlot}
        </span>
      )}
      <style>{`
        input::placeholder { color: var(--auth-card-placeholder); }
        /* #7333 与主按钮同高:突出入口 40,触控 44(同 ui/Button xl 的 max-[719px] 档) */
        .gugu-auth-input { height: var(--control-h-xl); }
        @media (max-width: 719px) { .gugu-auth-input { height: var(--control-h-touch); } }
      `}</style>
    </div>
  )
}

// ─── Primary submit button ────────────────────────────────────────────────────

// #7333 主按钮走 ui/Button primary:墨底 + 反相前景(--primary / --primary-fg,明暗两侧都对),悬停 .88 / 按下 .78 /
// 禁用 .58,键盘焦点环由全局规则给。原来手写的是 --accent 底 + --surface-white(= 卡片面)字、悬停换成写死的
// --accent-hover 灰。xl = 突出入口 40,触控 44。等待中是咕咕唯一的加载态(行内档,跟字色),名字留给读屏。
function PrimaryButton({ disabled, loading, label }: { disabled: boolean; loading: boolean; label: string }) {
  return (
    <Button type="submit" variant="primary" size="xl" disabled={disabled} style={{ marginTop: '8px', width: '100%' }}>
      {loading ? <LoadingIndicator size="inline" ariaLabel={label} /> : label}
    </Button>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export function LoginPage() {
  const { t } = useTranslation('main')
  const [step, setStep] = useState<Step>('email')
  const [email, setEmail] = useState('')
  const [otpCode, setOtpCode] = useState('')
  const [error, setError] = useState('')
  const [submitFailed, setSubmitFailed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [resendCountdown, setResendCountdown] = useState(0)
  const reduceMotion = usePrefersReducedMotion()

  useEffect(() => {
    if (resendCountdown <= 0) return
    const timer = setTimeout(() => setResendCountdown((v) => v - 1), 1000)
    return () => clearTimeout(timer)
  }, [resendCountdown])

  const handleRequestOtp = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email) { setError(t('auth.emailRequired')); return }
    setLoading(true)
    setSubmitFailed(false)
    const result = await authService.requestLoginOtp(email).finally(() => setLoading(false))
    if (!result.success) {
      setError(result.error ?? t('auth.sendFailed'))
      setSubmitFailed(true)
    } else {
      setStep('otp')
      setError('')
      setResendCountdown(60)
    }
  }

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setSubmitFailed(false)
    const attempt = sessionCoordinator.beginInteractiveLogin()
    const result = await authService.verifyLoginOtp(email, otpCode)
    if (result.success && result.session) await sessionCoordinator.acceptInteractiveSession(attempt, result.session)
    setLoading(false)
    if (!result.success) {
      setError(result.error ?? t('auth.verifyFailed'))
      setSubmitFailed(true)
    }
  }

  const handleChangeEmail = () => {
    setStep('email')
    setOtpCode('')
    setError('')
    setSubmitFailed(false)
  }

  const handleResendOtp = async () => {
    if (loading || resendCountdown > 0) return
    setLoading(true)
    const result = await authService.requestLoginOtp(email).finally(() => setLoading(false))
    if (!result.success) {
      setError(result.error ?? t('auth.sendFailed'))
      return
    }
    setError('')
    setResendCountdown(60)
  }

  return (
    <div
      className="gugu-auth-page"
      style={{
        position: 'relative',
        width: '100vw',
        height: '100vh',
        minHeight: '560px',
        overflow: 'hidden',
        // 2026-09-22 按 design.md 统一:「Decorative gradients, glows, blobs, textures, glass,
        // and ornamental shadows」—— 两团淡暖光晕删掉,背景只剩纯色面。
        // 原裁决:@@@1361 删背景插画底图;干净浅色 + 两团淡暖光晕(设计稿 v3b)。
        background: 'var(--bg-auth-page)',
        display: 'flex',
        alignItems: 'center',
        // @@@1361 — 删图后整体居中(原 right-anchor 是为躲插画)。
        justifyContent: 'center',
        boxSizing: 'border-box',
        padding: '48px clamp(24px, 6vw, 80px)',
        userSelect: 'none',
        WebkitAppRegion: 'drag',
      } as React.CSSProperties}
    >
      <style>{`
        /* 2026-09-22 按 design.md 统一。这里原来自建了 14 个 --auth-card-* 局部变量,
           全是 rgba(0,0,0,X) / rgba(255,255,255,X) —— 一套与全局语义色板完全平行的灰阶,
           踩「Never introduce a neutral outside that family」。现在映射到语义色板:
           八层文字灰压成三层(primary / secondary / tertiary),面与线走 --card / --border。
           ⇒ 登录页从此跟随主题,而不是恒定一张浅卡。 */
        .gugu-auth-card {
          --auth-card-bg: var(--card);
          --auth-card-border: var(--border);
          --auth-card-input-bg: var(--input-bg);
          --auth-card-input-border: var(--border-strong);
          --auth-card-text-strong: var(--text-primary);
          --auth-card-text-soft: var(--text-secondary);
          --auth-card-text-faint: var(--text-tertiary);
          --auth-card-text-dim: var(--text-tertiary);
          --auth-card-placeholder: var(--text-tertiary);
        }

        /* 2026-09-22 按 design.md 统一:「ornamental shadows」—— 卡背后那层带模糊的伪元素背衬
           整块删掉,卡只留一条发丝边。原裁决:@@@1361 立体卡片:偏移背衬伪元素 + 深浅双阴影
           = 不再单薄(设计稿 .card-wrap:before)。 */
        .gugu-auth-cardwrap { position: relative; width: 100%; }

        @media (max-width: 900px) {
          .gugu-auth-page { padding: 32px 24px !important; }
          .gugu-auth-col { width: min(300px, calc(100vw - 48px)) !important; }
        }
      `}</style>

      {/* 居中列:品牌标题(撑层次,治"单薄") + 卡片 */}
      <div
        className="gugu-auth-col"
        style={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          textAlign: 'center',
          gap: '24px',
          width: '300px',
          maxWidth: 'calc(100vw - 48px)',
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}
      >
        {/* @@@1361 品牌标题在卡上方(原卡内 tagline 上提为此) */}
        <div
          className="gugu-auth-headline"
          style={{
            // #7333 页面标题档 24/32 半粗
            fontSize: 'var(--font-size-xl)',
            lineHeight: 'var(--lh-page)',
            fontWeight: 600,
            // 标题在卡片外面:原来读卡片里才定义的 --warm-ink,在这里是无效值,只是碰巧继承到了页面字色。
            color: 'var(--text-primary)',
            fontFamily: 'var(--font-family-system)',
          }}
        >
          <Trans i18nKey="auth.headline" ns="main" components={{ break: <br /> }} />
        </div>

        <div className="gugu-auth-cardwrap">
          <div
            className="gugu-auth-card"
            style={{
              position: 'relative',
              zIndex: 'var(--z-raised)',
              width: '100%',
              // 2026-09-22 按 design.md 统一:登录卡是页面主体对象、不是浮层 ⇒
              // 去 backdrop-filter(glass)、去三层装饰阴影(远阴影 + 近阴影 + 内高光),
              // 只留一条发丝边;圆角落到 xl(12px)那一档,20px 不在刻度上。
              background: 'var(--auth-card-bg)',
              borderRadius: 'var(--radius-xl)',
              border: '1px solid var(--auth-card-border)',
              padding: 'var(--spacing-2xl)',
            }}
          >
            {/* Logo area — 无个人头像(#1361),仅品牌 logo */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--spacing-sm)', marginBottom: 'var(--spacing-2xl)' }}>
              <img
                src={APP_LOGO_URL}
                alt={t('brand.name')}
                draggable={false}
                style={{ width: 40, height: 40, objectFit: 'contain', display: 'block' }}
              />
              <span style={{
                fontSize: 'var(--font-size-lg)',
                lineHeight: 'var(--lh-heading)',
                fontWeight: 700,
                color: 'var(--auth-card-text-strong)',
                letterSpacing: '4px',
                fontFamily: 'var(--font-family-system)',
              }}>
                {t('brand.name')}
              </span>
            </div>

            {/* Forms — 邮箱 OTP-only 两步 */}
            <AnimatePresence mode="wait" initial={false}>
              {step === 'email' && (
                <motion.form
                  key="email"
                  {...stepMotion(reduceMotion, -10)}
                  onSubmit={handleRequestOtp}
                  style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)' }}
                >
                  <DarkInputField
                    type="email"
                    inputMode="email"
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value)
                      if (error) setError('')
                      if (submitFailed) setSubmitFailed(false)
                    }}
                    placeholder={t('auth.emailPlaceholder')}
                    autoComplete="email"
                  />

                  {error && (
                    <p role="alert" style={{ fontSize: 'var(--font-body)', lineHeight: 'var(--lh-body)', color: 'var(--text-error)', margin: 0 }}>{error}</p>
                  )}

                  <PrimaryButton disabled={loading || !email} loading={loading} label={t(submitFailed ? 'auth.retry' : 'auth.continue')} />

                  {/* @@@1419 服务条款 / 隐私政策 同意小字（owner 追加，链接 _blank） */}
                  <p style={{ fontSize: 'var(--font-caption)', lineHeight: 'var(--lh-caption)', color: 'var(--auth-card-text-dim)', textAlign: 'center', margin: '8px 0 0' }}>
                    <Trans
                      i18nKey="auth.legal"
                      ns="main"
                      components={{
                        terms: (
                          <a
                            href="https://gugu.nextmind.space/zh/terms.html"
                            target="_blank"
                            rel="noreferrer"
                            style={{ color: 'var(--auth-card-text-soft)', textDecoration: 'underline' }}
                          />
                        ),
                        privacy: (
                          <a
                            href="https://gugu.nextmind.space/zh/privacy.html"
                            target="_blank"
                            rel="noreferrer"
                            style={{ color: 'var(--auth-card-text-soft)', textDecoration: 'underline' }}
                          />
                        ),
                      }}
                    />
                  </p>
                </motion.form>
              )}

              {step === 'otp' && (
                <motion.form
                  key="otp"
                  {...stepMotion(reduceMotion, 10)}
                  onSubmit={handleVerifyOtp}
                  style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)' }}
                >
                  <p style={{ fontSize: 'var(--font-body)', color: 'var(--auth-card-text-soft)', margin: '0 0 4px', lineHeight: 'var(--lh-body)' }}>
                    {t('auth.otpSent', { email })}
                  </p>
                  <DarkInputField
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    placeholder={t('auth.otpPlaceholder')}
                    value={otpCode}
                    autoComplete="one-time-code"
                    onChange={(e) => {
                      setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))
                      if (error) setError('')
                      if (submitFailed) setSubmitFailed(false)
                    }}
                    inputStyle={{
                      fontFamily: 'var(--font-family-mono)',
                      fontSize: 'var(--font-size-xl)',
                      letterSpacing: '8px',
                      textAlign: 'center',
                      paddingLeft: '12px',
                    }}
                  />

                  {error && (
                    <p role="alert" style={{ fontSize: 'var(--font-body)', lineHeight: 'var(--lh-body)', color: 'var(--text-error)', margin: 0 }}>{error}</p>
                  )}

                  <PrimaryButton disabled={otpCode.length !== 6 || loading} loading={loading} label={t(submitFailed ? 'auth.retry' : 'auth.login')} />

                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '4px 0 0' }}>
                    {/* #7333 文字钮 = ui/Button ghost:次级字色,悬停 / 按下底色,禁用 .58(倒计时中),桌面 32 / 触控 44 */}
                    <Button variant="ghost" size="md" onClick={handleChangeEmail} style={{ paddingInline: '8px' }}>
                      {t('auth.changeEmail')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="md"
                      onClick={handleResendOtp}
                      disabled={loading || resendCountdown > 0}
                      style={{ paddingInline: '8px' }}
                    >
                      {resendCountdown > 0
                        ? t('auth.resendCountdown', { seconds: resendCountdown })
                        : t('auth.resend')}
                    </Button>
                  </div>
                </motion.form>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  )
}
