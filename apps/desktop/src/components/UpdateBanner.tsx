// 全局更新提示：桌面挂在 Sidebar 栏底，手机挂在 MainLayout，任一时刻只有一份。
// @@@5576 起主路是**静默下载**:main.ts 发现新版后自己在后台下,期间不发 'available'。'downloading'
// 状态照发(关于页要显示下载进度),但本组件只在用户自己从「更新」/「重试」进来时才跟着它走 ——
// 用户没要求的下载不弹浮层,这条路上本组件从 idle **直接跳到 ready**,第一次看见浮层就是「可以重启了」。
//   ready(update-downloaded/update-ready) → 「新版本已就绪」+「立即重启更新」(installUpdate=quitAndInstall)/「稍后」
// 安装始终由用户按下(autoInstallOnAppQuit 关着),下载才是静默的那一半。
//
// 另一条路留给下不动的包(mac 上的 ad-hoc 存量老包,走 #663 dmg 半自动):照旧先问后下 ——
//   available → 「发现新版本 [vX.Y.Z]」+「更新」/「稍后」(用户选);点「更新」→ platform.downloadUpdate()
//   downloading(宿主状态值 'downloading',百分比也在里面) → 「下载新版本中…」(由 update-downloaded 收尾)
//   manual-install(downloaded-manual) → 「安装包已打开」+拖装指引,无重启按钮(系统接管)
// 静默下载失败也回到 available(用户点一次走手动路径,那条路失败会显式报错)。
// not-available/error 不弹(自动 check 不打扰)。桌面栏底、手机浮层，克制不阻断。
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, CheckCircle2, AlertTriangle, X } from '@/lib/icons'
import { UI_EVENTS } from '../lib/uiEvents'
import { platform } from '../platform'
import { AUTOMATION_TEST_IDS } from '../lib/automationDom'
import { classifyUpdateError, type UpdateErrorReason } from '../lib/updateError'
import { rendererLogger } from '../lib/log'
import { useMobileShell } from '../hooks/useMobileShell'
import { UpdateRailButton } from './UpdateRailButton'

// manual-install(#663): mac 无签名走 dmg 半自动——安装包已下载并自动打开,提示用户拖装,无重启按钮。
// failed(#2126): 下载/更新失败 → 显式失败态(人话原因 + 重试),❌ 静默 revert 成「可更新」诱导反复点。
type UpdatePhase = 'idle' | 'available' | 'downloading' | 'ready' | 'manual-install' | 'failed'

/** 主进程那个状态值的形状(main.ts UpdateCheckResult),推来的与问来的是同一个东西。 */
type UpdateStatusDetail = { status?: unknown; updateInfo?: { version?: unknown } | null; message?: unknown; percent?: unknown }

const updateLog = rendererLogger('update-banner')

export function UpdateBanner({ placement = 'floating' }: { placement?: 'floating' | 'rail' }) {
  const { t } = useTranslation('main')
  const mobile = useMobileShell()
  const [phase, setPhase] = useState<UpdatePhase>('idle')
  const [version, setVersion] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(false)
  // 按下「立即重启更新」之后:宿主先查一次 feed(checking,这次调用还没回来),查完要么去下更新的一版
  // (横幅跟着变成下载中),要么开始安装(restarting)。❌ 一按就写「正在重启」—— 查 feed 可能要几十秒。
  const [installing, setInstalling] = useState<false | 'checking' | 'restarting'>(false)
  const installInFlight = useRef(false)
  // @@@1961 下载进度百分比(0–100),取自宿主的 'downloading' 状态值;null = 还没有第一条进度(准备中)。
  const [percent, setPercent] = useState<number | null>(null)
  // @@@2126 失败原因(人话);仅 failed 态显示。
  const [failReason, setFailReason] = useState<UpdateErrorReason | null>(null)
  // error 事件处理器在 [] effect 里绑定一次 → 用 ref 读最新 phase(只在下载中才转 failed;
  // 避免在 setState updater 里做副作用,防 StrictMode 双调重复副作用,#2062 教训)。
  const phaseRef = useRef<UpdatePhase>('idle')
  phaseRef.current = phase

  useEffect(() => {
    // 下载就绪：可一键重启更新。即便之前 dismiss 过，这是新的 actionable 状态 → 重新弹。
    const onReady = () => { setPhase('ready'); setDismissed(false) }
    // @@@5837 推来的状态和**问来的**状态走同一段逻辑 —— 两条路各写一份迟早分叉,而分叉的
    // 表现正是这次出的事:某一条路上「包已下好」根本到不了界面。
    const applyStatus = (detail: UpdateStatusDetail | null | undefined) => {
      if (detail?.status === 'downloaded') { setPhase('ready'); setDismissed(false) }
      else if (detail?.status === 'downloading') {
        // 「下载中」只有宿主这一个来源。横幅已经在眼前时才跟进:点过「更新」/「重试」(available/failed),
        // 或者按了「立即重启更新」而宿主发现 feed 上还有更新的一版、先去下它(ready)。
        // idle 时的静默下载不弹手机浮层；桌面只在栏底显示进度。
        const prev = phaseRef.current
        if (placement === 'rail' || prev === 'available' || prev === 'failed' || prev === 'downloading' || prev === 'ready') {
          setPhase('downloading')
          setFailReason(null)
          setPercent(typeof detail.percent === 'number' && Number.isFinite(detail.percent) ? detail.percent : null)
        }
      }
      else if (detail?.status === 'downloaded-manual') { setPhase('manual-install'); setDismissed(false) }
      else if (detail?.status === 'available') {
        const v = typeof detail.updateInfo?.version === 'string' ? detail.updateInfo.version : null
        setVersion(v)
        // 仅在尚未进入下载/就绪/待拖装/失败时回到「选择」态：避免重复 check 事件把进行中/已完成/失败的
        // 状态打回选择按钮。@@@2126 failed 也必须纳入保护——否则用户看到「更新失败:404」后,下一次后台
        // 周期 check 命中的 available 会无声把错误改回「发现新版本」= 仍是 #2126 禁止的 silent revert。
        // failed 粘住直到用户「重试」(→downloading)或「稍后/关闭」(dismiss);不无条件清掉错误。
        setPhase((prev) =>
          prev === 'downloading' || prev === 'ready' || prev === 'manual-install' || prev === 'failed' ? prev : 'available',
        )
        // failed 态下不 un-dismiss(不让周期 available 把已失败的横幅重新"激活"成选择态语义);其余照常。
        if (phaseRef.current !== 'failed') setDismissed(false)
      } else if (detail?.status === 'error') {
        // @@@2126 fail-loud:仅下载中失败 → 显式「更新失败」态(人话原因 + 重试),❌ 静默 revert 成
        // 「可更新」(旧行为=用户看不到原因、一失败就诱导反复点 → 玄学循环)。error 已带 message
        // (main.ts autoUpdater.on('error') / mac dmg .catch)。非下载中(idle 的自动 check 失败)
        // 不弹不打扰——只在用户主动发起的下载失败时报错。
        if (phaseRef.current === 'downloading') {
          const msg = typeof detail.message === 'string' ? detail.message : ''
          setFailReason(classifyUpdateError(msg))
          setPhase('failed')
          // 按过「重启更新」后的那次下载失败:宿主已把「下好就装」作废,按钮放回来。
          setInstalling(false)
          installInFlight.current = false
          setDismissed(false)
        }
      }
      // not-available：自动 check 不打扰，不改 phase(About 页负责手动反馈)。
    }
    const onStatus = (event: Event) => applyStatus((event as CustomEvent<UpdateStatusDetail>).detail)
    // @@@5837 挂载时**问一次**宿主:更新状态是主进程的事实,不是几条事件攒出来的。
    // 整窗重载会把这里的 state 清空,而那时包可能早就下好在等人按 —— 唯一的安装入口不能就这么没了。
    void Promise.resolve(platform.updateState?.())
      .then((state) => applyStatus(state as UpdateStatusDetail | null))
      .catch(() => {})
    window.addEventListener(UI_EVENTS.updateReady, onReady)
    window.addEventListener(UI_EVENTS.updateStatus, onStatus)
    return () => {
      window.removeEventListener(UI_EVENTS.updateReady, onReady)
      window.removeEventListener(UI_EVENTS.updateStatus, onStatus)
    }
  }, [placement])

  // @@@2126 「更新」/「重试」共用:交给宿主下载;进不进「下载中」看宿主的
  // 'downloading' 状态(唯一来源),❌ 在这里自己记一份。async 下载失败经 'error' 事件转 failed;
  // 同步启动失败(平台不支持等)在此 fail-loud 转 failed,❌ 静默回退到「可更新」。
  const startDownload = () => {
    void Promise.resolve(platform.downloadUpdate()).catch((err) => {
      setFailReason(classifyUpdateError(err instanceof Error ? err.message : String(err)))
      setPhase('failed')
    })
  }

  const install = () => {
    if (installInFlight.current) return
    installInFlight.current = true
    setInstalling('checking')
    void Promise.resolve(platform.installUpdate())
      .then(() => setInstalling('restarting'))
      .catch(() => { installInFlight.current = false; setInstalling(false) })
  }

  // @@@4891 状态码/原始报错进日志不进横幅:HTTP 码对客服定位有用、对用户没有意义(owner 拍板)。
  // rendererLogger 会回传主进程,落 userData/logs/gugu-main.log —— 用户报问题时可随反馈勾选一并上传(#4899)。
  // 必须在任何 early return 之前调用:hook 的调用顺序不许随渲染分支变。
  useEffect(() => {
    if (phase !== 'failed' || !failReason) return
    updateLog.error({
      code: failReason.code,
      ...(failReason.code === 'server' ? { status: failReason.status } : {}),
      ...(failReason.code === 'raw' ? { message: failReason.message } : {}),
    }, '更新失败')
  }, [phase, failReason])

  // web/不支持更新的平台不渲染(事件也不会来，双保险)。
  if (!platform.capabilities.appUpdates) return null
  if (phase === 'idle' || (placement === 'floating' && dismissed)) return null

  const ready = phase === 'ready'
  const downloading = phase === 'downloading'
  const manualInstall = phase === 'manual-install'
  const failed = phase === 'failed'
  const failReasonText = !failReason
    ? t('shell.update.errorFallback')
    : failReason.code === 'packageNotFound'
      ? t('shell.update.errors.packageNotFound')
      : failReason.code === 'integrity'
        ? t('shell.update.errors.integrity')
        : failReason.code === 'network'
          ? t('shell.update.errors.network')
          : failReason.code === 'server'
            ? t('shell.update.errors.server')
            : failReason.code === 'raw'
              ? failReason.message
              : t('shell.update.errors.unknown')
  const title = failed
    ? t('shell.update.failedTitle')
    : manualInstall
      ? t('shell.update.manualTitle')
      : ready
        ? t('shell.update.readyTitle')
        : downloading
          ? t('shell.update.downloadingTitle')
          : version
            ? t('shell.update.availableVersion', { version: version.replace(/^v/, '') })
            : t('shell.update.availableTitle')
  const sub = failed
    ? failReasonText
    : manualInstall
      ? t('shell.update.manualDescription')
      : ready
        ? t('shell.update.readyDescription')
        : downloading
          ? t('shell.update.downloadingDescription')
          : t('shell.update.availableDescription')

  if (placement === 'rail') {
    const label = downloading
      ? `${title}${percent === null ? '' : ` ${Math.round(percent)}%`}`
      : installing === 'checking'
        ? t('about.checking', { ns: 'settings' })
        : installing === 'restarting'
          ? t('shell.update.restarting')
          : ready ? t('shell.update.restartNow') : failed ? t('shell.update.retry') : manualInstall ? title : t('shell.update.download')
    return (
      <UpdateRailButton
        label={label}
        description={failed ? failReasonText : manualInstall ? sub : phase === 'available' && version ? title : ''}
        progress={downloading ? percent : undefined}
        busy={downloading || installing !== false}
        failed={failed}
        onClick={manualInstall ? undefined : ready ? install : startDownload}
      />
    )
  }

  return (
    <div
      data-testid={AUTOMATION_TEST_IDS.updateBanner}
      data-phase={phase}
      style={{
        position: 'fixed', zIndex: 'var(--z-banner)',
        // 手机壳底部是常驻的 tab 栏,贴底会把它盖住(安卓应用内更新 #6188 模拟器实拍);
        // 手机上改贴顶、左右各留 16px,桌面照旧右下角。
        ...(mobile
          ? { top: 'calc(env(safe-area-inset-top) + 12px)', left: 16, right: 16 }
          : { right: 18, bottom: 18, width: 320 }),
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-strong)',
        borderRadius: 'var(--radius-xl)',
        boxShadow: 'var(--shadow-lift)',
        padding: '14px 16px',
        display: 'flex', flexDirection: 'column', gap: 10,
        pointerEvents: 'auto',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div
          style={{
            width: 32, height: 32, borderRadius: 'var(--radius-surface)', flexShrink: 0,
            display: 'grid', placeItems: 'center',
            background: failed
              ? 'var(--danger-tint)'
              : 'var(--accent-tint-row)',
            color: failed ? 'var(--danger)' : 'var(--text-primary)',
          }}
        >
          {failed ? <AlertTriangle size={18} /> : ready || manualInstall ? <CheckCircle2 size={18} /> : <Download size={18} />}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 'var(--font-body)', fontWeight: 600, color: 'var(--text-primary)' }}>
            {title}
          </div>
          <div style={{ fontSize: 'var(--font-caption)', color: 'var(--text-secondary)' }}>
            {sub}
          </div>
        </div>
        <button
          type="button"
          aria-label={t('shell.update.close')}
          onClick={() => setDismissed(true)}
          style={{
            width: 24, height: 24, flexShrink: 0, display: 'grid', placeItems: 'center',
            borderRadius: 'var(--radius-document)', border: 'none', background: 'transparent', cursor: 'pointer',
            color: 'var(--text-secondary)',
          }}
        >
          <X size={15} />
        </button>
      </div>

      {/* @@@1961 downloading：进度条 + 百分比。percent=null(尚无进度事件)→「准备下载…」不确定态。 */}
      {downloading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ height: 6, borderRadius: 'var(--radius-capsule)', overflow: 'hidden', background: 'var(--border-strong)' }}>
            <div
              data-testid="update-download-progress-bar"
              style={{
                height: '100%',
                width: `${percent === null ? 0 : Math.round(percent)}%`,
                background: 'var(--accent)',
                // @@@4323 这里的 width 就是数据本身(下载进度),不是布局收放。保留动 width,只把时长收编回 token。
                transition: 'width var(--transition-normal)',
              }}
            />
          </div>
          <div style={{ fontSize: 'var(--font-caption)', textAlign: 'right', color: 'var(--text-secondary)' }}>
            {percent === null ? t('shell.update.preparing') : `${Math.round(percent)}%`}
          </div>
        </div>
      )}

      {/* available：用户选择「更新」(下载)/「稍后」 */}
      {phase === 'available' && (
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            data-testid={AUTOMATION_TEST_IDS.updateDownloadButton}
            onClick={() => startDownload()}
            style={primaryBtnStyle(false)}
          >
            {t('shell.update.download')}
          </button>
          <button type="button" onClick={() => setDismissed(true)} style={laterBtnStyle}>
            {t('shell.update.later')}
          </button>
        </div>
      )}

      {/* @@@2126 failed:显失败原因 + 重试(不静默 revert 成「可更新」诱导反复点) */}
      {failed && (
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            data-testid={AUTOMATION_TEST_IDS.updateRetryButton}
            onClick={() => startDownload()}
            style={primaryBtnStyle(false)}
          >
            {t('shell.update.retry')}
          </button>
          <button type="button" onClick={() => setDismissed(true)} style={laterBtnStyle}>
            {t('shell.update.later')}
          </button>
        </div>
      )}

      {/* ready：一键重启更新 */}
      {ready && (
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            data-testid={AUTOMATION_TEST_IDS.updateInstallButton}
            disabled={installing !== false}
            onClick={install}
            style={primaryBtnStyle(installing !== false)}
          >
            {installing === 'checking'
              ? t('about.checking', { ns: 'settings' })
              : installing === 'restarting'
                ? t('shell.update.restarting')
                : t('shell.update.restartNow')}
          </button>
          <button type="button" onClick={() => setDismissed(true)} style={laterBtnStyle}>
            {t('shell.update.later')}
          </button>
        </div>
      )}
    </div>
  )
}

function primaryBtnStyle(busy: boolean): React.CSSProperties {
  return {
    flex: 1, height: 32, borderRadius: 'var(--radius-control)', border: 'none',
    cursor: busy ? 'default' : 'pointer',
    background: 'var(--accent)', color: 'var(--text-on-accent)',
    fontSize: 'var(--font-body)', fontWeight: 600, opacity: busy ? 0.6 : 1,
  }
}

const laterBtnStyle: React.CSSProperties = {
  height: 32, padding: '0 12px', borderRadius: 'var(--radius-control)',
  border: '1px solid var(--border-strong)', background: 'transparent',
  cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 'var(--font-body)',
}
