import { useEffect, useState } from 'react'
import { publicAssetPath } from '@gugu/core/shared/ui/publicAssets'
import { UI_EVENTS } from '../../lib/uiEvents'
import { ChevronRight } from '@/lib/icons'
import { platform } from '../../platform'
import { Button } from '../ui/Button'
import { SettingsGroup, SettingsNote, SettingsPage, SettingsRow } from './SettingsPrimitives'
import { Trans, useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'

const APP_ICON_URL = publicAssetPath('/assets/app/gugu-icon-512.png')

// @@@app-version - build-time constant injected from root package.json by vite (see vite.config.mts).
// Available on every target, so the version footer shows even on the web build where there is no
// app.getVersion() IPC bridge.
declare const __APP_VERSION__: string

/** 主进程那个状态值的形状(main.ts UpdateCheckResult),推来的与问来的是同一个东西。 */
type UpdateStatusDetail = { status?: unknown; messageKey?: unknown; message?: unknown; percent?: unknown }

// 主进程给的是词表 key(它不知道界面是哪种语言);只有 updater 自己吐的原始报错走 message。
// 'downloading' 不带 key:用横幅那一句「下载新版本中…」,百分比跟着状态值一起来(main.ts markDownloading)。
function updateStatusMessage(t: TFunction<'settings'>, detail: UpdateStatusDetail | null | undefined): string | null {
  if (detail?.status === 'downloading') {
    const title = t('shell.update.downloadingTitle', { ns: 'main' })
    return typeof detail.percent === 'number' ? `${title} ${Math.round(detail.percent)}%` : title
  }
  if (typeof detail?.messageKey === 'string') return t(detail.messageKey)
  return typeof detail?.message === 'string' ? detail.message : null
}

export function AboutSection() {
  const { t } = useTranslation('settings')
  const [updateReady, setUpdateReady] = useState(false)
  const [updateMessage, setUpdateMessage] = useState('')
  const [checking, setChecking] = useState(false)
  // Seed from the build-time version so it renders immediately on all platforms; Electron's IPC
  // path below refines it to the live app.getVersion() (identical value in practice).
  const [version, setVersion] = useState(__APP_VERSION__)
  const showAppCard = platform.capabilities.appVersion || platform.capabilities.appUpdates

  useEffect(() => {
    const readyHandler = () => {
      setUpdateReady(true)
      setUpdateMessage(t('about.updateDownloaded'))
    }
    // @@@5837 推来的状态和**问来的**状态走同一段逻辑,❌ 不各写一份。
    const applyStatus = (detail: UpdateStatusDetail | null | undefined) => {
      // 「重启以安装」只在宿主说「下好了」时出现:按下后宿主可能先去下 feed 上更新的一版,那时是 downloading。
      setUpdateReady(detail?.status === 'downloaded')
      const message = updateStatusMessage(t, detail)
      if (message !== null) setUpdateMessage(message)
    }
    const statusHandler = (event: Event) => applyStatus((event as CustomEvent<UpdateStatusDetail>).detail)
    // @@@5837 进设置页就**问一次**:包可能早在几小时前就下好了,而那条推送只发过一次。
    // 这一行是「重启以安装」那个按钮的保底来源 —— 横幅可以被关掉,这里不能没有。
    void Promise.resolve(platform.updateState?.())
      .then((state) => applyStatus(state as UpdateStatusDetail | null))
      .catch(() => {})
    window.addEventListener(UI_EVENTS.updateReady, readyHandler)
    window.addEventListener(UI_EVENTS.updateStatus, statusHandler)
    return () => {
      window.removeEventListener(UI_EVENTS.updateReady, readyHandler)
      window.removeEventListener(UI_EVENTS.updateStatus, statusHandler)
    }
  }, [t])

  useEffect(() => {
    if (!platform.capabilities.appVersion) return
    platform.getAppVersion().then(setVersion)
  }, [])

  async function handleCheckForUpdates() {
    setChecking(true)
    setUpdateMessage('')
    try {
      const result = await platform.checkForUpdates() as UpdateStatusDetail
      setUpdateReady(result.status === 'downloaded')
      const message = updateStatusMessage(t, result)
      if (message !== null) setUpdateMessage(message)
    } catch (err) {
      setUpdateMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setChecking(false)
    }
  }

  return (
    <SettingsPage>
      {showAppCard && (
        <SettingsGroup>
          {platform.capabilities.appVersion && (
            <SettingsRow
              title={t('about.currentVersion')}
              control={<span className="gg-settings-row-value">{version}</span>}
            />
          )}
          {/* @@@5813 更新说明在官网上那一页:装完新版第一次打开时会自己带他去一次,
              这一行是随时回头再看的入口(product spec)。这一行常驻 ——
              ❌ 不因为「这次没取到」把入口藏掉,那样用户会以为咕咕没这功能。 */}
          <SettingsRow
            data-testid="about-release-notes"
            title={t('about.releaseNotes')}
            control={<ChevronRight size={16} aria-hidden="true" className="gg-settings-row-chevron" />}
            onClick={() => window.dispatchEvent(new CustomEvent(UI_EVENTS.openReleaseNotes))}
          />
          <SettingsRow
            data-testid="about-reopen-product-tour"
            title={t('about.reopenProductTour')}
            control={<ChevronRight size={16} aria-hidden="true" className="gg-settings-row-chevron" />}
            onClick={() => window.dispatchEvent(new CustomEvent(UI_EVENTS.reopenProductTour))}
          />
          {platform.capabilities.appUpdates && (
            <SettingsRow>
              {updateReady ? (
                <Button variant="primary" size="md" onClick={() => { void platform.installUpdate() }} style={{ width: '100%' }}>
                  {t('about.restartToInstall')}
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  size="md"
                  onClick={handleCheckForUpdates}
                  disabled={checking}
                  // 检查更新 = 次级动作:#7333 母版的次级按钮(细边、8 圆角)原样用 Button,不再就地改成药丸 + 填充底。
                  style={{ width: '100%' }}
                >
                  {checking ? t('about.checking') : t('about.checkUpdates')}
                </Button>
              )}
              {updateMessage && <SettingsNote>{updateMessage}</SettingsNote>}
            </SettingsRow>
          )}
        </SettingsGroup>
      )}

      <SettingsGroup>
        <SettingsRow
          data-testid="about-feedback"
          title={t('shell.feedback', { ns: 'main' })}
          control={<ChevronRight size={16} aria-hidden="true" className="gg-settings-row-chevron" />}
          onClick={() => window.dispatchEvent(new Event(UI_EVENTS.sessionpageOpenFeedback))}
        />
      </SettingsGroup>

      {/* @@@1323-m6 about-wrap（对标 SSOT L886–890）：品牌 App 图标 + 名称 + tagline。
          图标 76/20 是品牌资产的固定几何(#2964 e2e 钉死 76×76),不进入通用头像/圆角梯——
          与气泡圆角同属「有专属 token 的例外」，不强收进 --r/--r-lg。 */}
      <div style={{ textAlign: 'center' }}>
        <img
          src={APP_ICON_URL}
          alt={t('about.iconAlt')}
          draggable={false}
          style={{
            width: 76,
            height: 76,
            borderRadius: 20,
            margin: 'var(--spacing-2xl) auto var(--spacing-md)',
            display: 'block',
            objectFit: 'cover',
          }}
        />
        {/* #7333 品牌名走页内标题档(20/28);标语、版本、署名是要读的字 ⇒ 次级色(第三档是装饰色,过不了 AA)。 */}
        <div style={{ fontSize: 'var(--font-heading)', lineHeight: 'var(--lh-heading)', fontWeight: 600, color: 'var(--text-primary)' }}>{t('about.brand')}</div>
        <div style={{ fontSize: 'var(--font-body)', color: 'var(--text-secondary)', marginTop: 'var(--spacing-xs)' }}>{t('about.tagline')}</div>
        {version && <div style={{ fontSize: 'var(--font-body)', color: 'var(--text-secondary)', marginTop: 2 }}>v{version}</div>}
        <div style={{ marginTop: 'var(--spacing-md)', fontSize: 'var(--font-caption)', color: 'var(--text-secondary)' }}>
          <Trans
            i18nKey="about.iconAttribution"
            ns="settings"
            components={{
              iconSet: (
                <a
                  href="https://github.com/480-Design/Solar-Icon-Set"
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: 'inherit', textDecoration: 'underline' }}
                />
              ),
            }}
          />
        </div>
      </div>
    </SettingsPage>
  )
}
