/**
 * #7199 助理 App「能力 · 设备」底下的「连接更多设备」(Mac、Windows、Linux、安卓)。
 * 点一项就地展开那个平台怎么装、怎么连 ——
 * 下载按钮直接是正式通道的包(appLinks),登录用的是哪个账号写明白,装好登录后它自己出现在上面的列表里。
 * 只列已经能连接的平台,未实现的功能不放占位行。
 * 另加一项咕咕自己有的「添加一台服务器」(经 SSH 装咕咕 server),只在能这么装的桌面上出现,走设置里现成的那一步。
 */
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import QRCode from 'qrcode'
import { GUGU_DOWNLOAD_URLS } from '../../lib/appLinks'
import { requestAddServerOnOpen } from '../../lib/addServerIntent'
import { UI_EVENTS } from '../../lib/uiEvents'
import { cn } from '../../lib/cn'
import { useAuth } from '../../store/auth'
import { platform } from '../../platform'
import { desktopIpc } from '../../platform/desktopIpc'
import { ArrowDownToLine, ChevronDown, ChevronRight, Monitor, Server } from '@/lib/icons'
import { Button } from '../ui/Button'
import { SettingsGroup, SettingsRow } from '../settings/SettingsPrimitives'
import { PhoneGlyph } from './assistantDeviceUi'

type Platform = 'mac' | 'windows' | 'linux' | 'android'

/** 顺序:Mac、Windows、Linux、安卓。 */
const PLATFORMS: readonly Platform[] = ['mac', 'windows', 'linux', 'android']

const LINUX_FILE = 'gugu-linux-x86_64.AppImage'

function openDownload(url: string) {
  // 三端同一条路(同 appLinks.openBillingPage):Electron 交给系统浏览器,网页版开新标签,手机交给系统浏览器。
  window.open(url, '_blank', 'noopener,noreferrer')
}

export function ConnectMoreDevices() {
  const { t } = useTranslation('settings')
  const [open, setOpen] = useState<Platform | null>(null)
  const canAddServer = desktopIpc() !== null
  return (
    <SettingsGroup title={t('devices.connectMore.title')} data-testid="assistant-devices-connect-more">
      {PLATFORMS.map((key) => {
        const expanded = open === key
        return (
          <div key={key} data-testid={`assistant-connect-${key}`}>
            <SettingsRow
              leading={<PlatformGlyph platform={key} />}
              title={t(`devices.connectMore.${key}`)}
              description={t(`devices.connectMore.requirement.${key}`)}
              aria-expanded={expanded}
              control={<ChevronDown size={16} className={cn('transition-transform duration-[var(--dur-fast)] motion-reduce:transition-none', !expanded && '-rotate-90')} />}
              onClick={() => setOpen(expanded ? null : key)}
            />
            {expanded && <Guide platform={key} />}
          </div>
        )
      })}
      {canAddServer && (
        <SettingsRow
          data-testid="assistant-connect-server"
          leading={<Server size={18} />}
          title={t('devices.connectMore.server')}
          description={t('devices.connectMore.serverHint')}
          control={<ChevronRight size={16} />}
          onClick={() => {
            requestAddServerOnOpen()
            window.dispatchEvent(new CustomEvent(UI_EVENTS.openSettings, { detail: { section: 'devices' } }))
          }}
        />
      )}
    </SettingsGroup>
  )
}

function PlatformGlyph({ platform: key }: { platform: Platform }) {
  if (key === 'android') return <PhoneGlyph />
  return <Monitor size={18} />
}

/** 一个平台怎么装、怎么连:下载 → 装上 → 用这个账号登录(它就出现在上面)→ 要让助理调它还差哪一步。 */
function Guide({ platform: key }: { platform: Platform }) {
  const { t } = useTranslation('settings')
  const account = useAuth().user?.email ?? null
  const signIn = account ? t('devices.connectMore.signIn', { account }) : t('devices.connectMore.signInNoAccount')
  const downloads: Array<{ label: string; url: string }> =
    key === 'mac'
      ? [
          { label: t('devices.connectMore.download.macArm64'), url: GUGU_DOWNLOAD_URLS.macArm64 },
          { label: t('devices.connectMore.download.macX64'), url: GUGU_DOWNLOAD_URLS.macX64 },
        ]
      : key === 'windows'
        ? [{ label: t('devices.connectMore.download.windows'), url: GUGU_DOWNLOAD_URLS.windowsX64 }]
        : key === 'linux'
          ? [{ label: t('devices.connectMore.download.linux'), url: GUGU_DOWNLOAD_URLS.linuxX64 }]
          : [{ label: t('devices.connectMore.download.android'), url: GUGU_DOWNLOAD_URLS.android }]
  const steps: ReactNode[] =
    key === 'mac'
      ? [t('devices.connectMore.steps.mac1'), signIn, t('devices.connectMore.steps.mac3')]
      : key === 'windows'
        ? [t('devices.connectMore.steps.windows1'), signIn, t('devices.connectMore.steps.desktop3')]
        : key === 'linux'
          ? [
              <>
                {t('devices.connectMore.steps.linux1')}
                <code className="mt-1 block w-fit max-w-full overflow-x-auto rounded-[var(--radius-control)] bg-foreground/[0.05] px-2 py-1 font-mono text-[var(--fg)]">
                  chmod +x {LINUX_FILE} && ./{LINUX_FILE}
                </code>
                <span className="mt-1 block">{t('devices.connectMore.steps.linuxFuse')}</span>
              </>,
              signIn,
              t('devices.connectMore.steps.desktop3'),
            ]
          : [t('devices.connectMore.steps.android1'), signIn, t('devices.connectMore.steps.android3')]
  return (
    <div
      className="flex flex-col gap-3 border-t border-[var(--border)] px-4 pt-3 pb-4 text-[length:var(--font-body)] text-[var(--muted-fg)]"
      data-testid={`assistant-connect-guide-${key}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        {downloads.map((d) => (
          <Button key={d.url} size="sm" variant="secondary" onClick={() => openDownload(d.url)} data-testid={`assistant-connect-download-${key}`}>
            <ArrowDownToLine aria-hidden className="size-4" />
            {d.label}
          </Button>
        ))}
      </div>
      {/* 在电脑上看这一页:安卓包给一个二维码,拿手机扫了直接下(在手机上看就不用了)。 */}
      {key === 'android' && platform.kind !== 'capacitor' && <DownloadQr url={GUGU_DOWNLOAD_URLS.android} />}
      {/* 序号手写:全局样式把 ol 的 list-style 清掉了(list-decimal 画不出数字,截图实测)。 */}
      <ol className="flex flex-col gap-2 leading-[1.6]">
        {steps.map((step, i) => (
          <li key={i} className="flex gap-2">
            <span className="shrink-0 tabular-nums text-[var(--faint-fg)]">{i + 1}.</span>
            <span className="min-w-0">{step}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

function DownloadQr({ url }: { url: string }) {
  const { t } = useTranslation('settings')
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    QRCode.toDataURL(url, { width: 112, margin: 1, color: { dark: '#1f2933', light: '#ffffff' } }).then(
      (value) => { if (alive) setDataUrl(value) },
      () => { if (alive) setDataUrl(null) },
    )
    return () => { alive = false }
  }, [url])
  // 生成失败就不画这一块(下载按钮还在),❌ 画一个空框。
  if (!dataUrl) return null
  return (
    <div className="flex items-center gap-3" data-testid="assistant-connect-android-qr">
      <img src={dataUrl} alt="" width={112} height={112} className="rounded-[var(--radius-control)] border border-[var(--border)]" />
      <span>{t('devices.connectMore.scanToDownload')}</span>
    </div>
  )
}
