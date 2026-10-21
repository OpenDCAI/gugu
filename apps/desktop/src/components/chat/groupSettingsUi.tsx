import type { CSSProperties, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { motion } from 'framer-motion'
import { DUR_FAST_MS, tween } from '@/styles/motion'
import { ChevronLeft, ChevronRight } from '@/lib/icons'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { useBackLayer } from '../ui/sheetStack'
import { Switch } from '../ui/Switch'
import { useToast } from '../toastContext'
import { Copy } from '@/lib/icons'
import {
  settingsRowStyle,
  settingsCenteredRowStyle,
  settingsRowTitleStyle,
  settingsRowSubtitleStyle,
} from './groupSettingsStyles'

// @@@6418 群设置抽屉各页共用的小件(页头 / 导航行 / 开关行 / 邀请链接)。几何在 groupSettingsStyles.ts。

const headStyle: CSSProperties = {
  padding: '34px 24px 14px', fontSize: 'var(--font-heading)', fontWeight: 600, borderBottom: '1px solid var(--border)',
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4, flexShrink: 0, color: 'var(--text-primary)',
}
const subpageHeadStyle: CSSProperties = { ...headStyle, padding: '30px 24px 12px 14px' }
// 移动壳:与其它手机页面同一条页头(#1787)—— 44px 返回贴左、紧凑上下距、无桌面抽屉的 34px 顶距。
const mobileHeadStyle: CSSProperties = { ...headStyle, padding: '6px 12px 6px 4px', gap: 2, borderBottom: '1px solid var(--border)' }
// 标题区撑满返回与动作之间:成员页的话题改名框(flex:1)要住得下。
const headTitleStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0 }
const headTitleTextStyle: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const headActionsStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }
const closeStyle: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
  color: 'var(--text-secondary)', width: 24, height: 24, borderRadius: 'var(--radius-document)',
}
const navRowStyle: CSSProperties = {
  ...settingsCenteredRowStyle, cursor: 'pointer', margin: '0 -8px', padding: '13px 8px', borderRadius: 'var(--radius-control)',
}
const navTitleStyle: CSSProperties = { ...settingsRowTitleStyle, flexShrink: 0 }
const navValueStyle: CSSProperties = {
  flex: 1, minWidth: 0, display: 'flex', justifyContent: 'flex-end', alignItems: 'center',
  fontSize: 'var(--font-body)', color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
}
const navValueTextStyle: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const chevronStyle: CSSProperties = { color: 'var(--text-tertiary)', flexShrink: 0 }
const switchStyle: CSSProperties = { marginTop: 2 }
const pageStyle: CSSProperties = { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }
// 二级页从 x:16 滑入,这段位移要裁在栈里:外层抽屉是滚动容器(overflowY:auto ⇒ x 也是 auto),不裁则每进一次
// 二级页抽屉底部都闪一条横向滚动条。clip 不形成滚动容器;竖向照旧由各页 body 自己滚。
const pageViewportStyle: CSSProperties = { ...pageStyle, overflowX: 'clip' }

/** 抽屉页面栈里当前那一页。换页(page 变)即重挂:二级页从右滑入,回一级页只淡入。 */
export function SettingsPageFrame({ page, children }: { page: string; children: ReactNode }) {
  return (
    <div style={pageViewportStyle}>
      <motion.div key={page} data-group-settings-page={page} initial={{ opacity: 0, x: page === 'main' ? 0 : 16 }} animate={{ opacity: 1, x: 0 }} transition={tween(DUR_FAST_MS)} style={pageStyle}>
        {children}
      </motion.div>
    </div>
  )
}

/**
 * 抽屉页头。一级页只有标题 + 关闭;二级页左侧多一个返回,右侧可放一个动作(如「完成」)。
 * 右栏里的群公告 / 成员名册从页头开时也用它(没有上一层:桌面只有 ⊗,手机左上返回 = 关)。
 */
export function SettingsPageHead({ title, onBack, onClose, action, mobile }: {
  /** 字符串按一行省略;其余(带计数、带改名框)由调用方自己排。 */
  title: ReactNode
  onBack?: () => void
  onClose?: () => void
  action?: ReactNode
  /**
   * 移动壳(#1787):页面出口 = 左上返回箭头,触控 44px。群设置在手机上**只有这一个**页头 ——
   * 外层 SettingsDrawer 不再画「← 群设置」,否则二级页会出现两个意思相反的返回。
   */
  mobile?: boolean
}) {
  const { t } = useTranslation('messaging')
  // 手机上这是一整页,出口只有左上返回:二级页回一级,没有上一层的页(一级页、页头开的右栏)= 关。
  // 安卓返回键同它,❌ 越过去退到会话列表。
  const back = onBack ?? (mobile ? onClose : undefined)
  useBackLayer(back, mobile)
  return (
    <div style={mobile ? mobileHeadStyle : onBack ? subpageHeadStyle : headStyle}>
      <div style={headTitleStyle}>
        {back ? <IconButton size={mobile ? 'lg' : 'sm'} aria-label={t('common.back')} onClick={back}><ChevronLeft /></IconButton> : null}
        {typeof title === 'string' ? <span style={headTitleTextStyle}>{title}</span> : title}
      </div>
      <div style={headActionsStyle}>
        {action}
        {/* 移动壳只有左上返回这一个出口(#1787),二级页也不再画右上 ⊗。 */}
        {onClose && !mobile ? (
          <span role="button" aria-label={t('common.close')} onClick={onClose} style={closeStyle}>
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="10" /><path strokeLinecap="round" d="m14.5 9.5l-5 5m0-5l5 5" /></g></svg>
          </span>
        ) : null}
      </div>
    </div>
  )
}

/** 进入下一层的行:标题 + 右侧摘要 + chevron。 */
export function SettingsNavRow({ title, value, onClick, testId }: {
  title: string
  value?: ReactNode
  onClick: () => void
  testId?: string
}) {
  return (
    <div className="gg-row" role="button" tabIndex={0} data-testid={testId} style={navRowStyle} onClick={onClick}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onClick() } }}>
      <span style={navTitleStyle}>{title}</span>
      <span style={navValueStyle}>{typeof value === 'string' ? <span style={navValueTextStyle}>{value}</span> : value}</span>
      <ChevronRight size={16} style={chevronStyle} />
    </div>
  )
}

export function SettingsToggleRow({ title, description, ariaLabel, checked, onChange, disabled }: {
  title: string
  description?: string
  ariaLabel: string
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
}) {
  return (
    <div style={settingsRowStyle}>
      <div>
        <div style={settingsRowTitleStyle}>{title}</div>
        {description ? <div style={settingsRowSubtitleStyle}>{description}</div> : null}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={ariaLabel} disabled={disabled} style={switchStyle} />
    </div>
  )
}

const linkBlockStyle: CSSProperties = { padding: '0 0 12px' }
const linkBoxStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, border: '1px solid var(--border-strong)', borderRadius: 'var(--radius-control)', padding: '9px 11px',
}
const linkTextStyle: CSSProperties = {
  flex: 1, minWidth: 0, fontSize: 'var(--font-body)', color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
}
const linkHintStyle: CSSProperties = { fontSize: 'var(--font-body)', color: 'var(--text-tertiary)', marginTop: 6, lineHeight: 1.5 }
const posterButtonStyle: CSSProperties = { marginTop: 10, width: '100%' }

/**
 * 邀请链接 + 复制 + 生成海报(#1164-G2 / #445)。开关是群主/管理员的事(在「群管理」里),
 * 但**链接本身所有成员都能拿来分享**(改版前的抽屉就是这样),所以这一块两处都用:
 * 群管理页给管理者、一级页给普通成员。开关关掉时调用方不渲染它 —— 那时链接对加入无效。
 */
export function GroupInviteLinkBlock({ inviteLink, onOpenPoster }: { inviteLink: string; onOpenPoster: () => void }) {
  const { t } = useTranslation('messaging')
  const { toast } = useToast()
  return (
    <div data-testid="group-invite-link" style={linkBlockStyle}>
      <div style={linkBoxStyle}>
        <span style={linkTextStyle}>{inviteLink}</span>
        <Button
          variant="primary"
          size="sm"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(inviteLink)
              toast(t('group.settings.inviteCopied'), 'success')
            } catch {
              toast(t('group.settings.inviteCopyFailed'), 'error')
            }
          }}
        >
          <Copy size={12} />
          {t('group.settings.copyLink')}
        </Button>
      </div>
      <div style={linkHintStyle}>{t('group.settings.shareLinkHint')}</div>
      <Button variant="secondary" size="md" style={posterButtonStyle} onClick={onOpenPoster}>{t('group.settings.sharePoster')}</Button>
    </div>
  )
}
