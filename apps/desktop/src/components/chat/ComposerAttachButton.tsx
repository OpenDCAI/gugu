import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Paperclip } from '@/lib/icons'
import { IconButton } from '../ui/IconButton'
import { DropdownMenu, MenuItem } from '../ui/Menu'

/** #7199 输入框「+」菜单里文件之后的那几项(助理 App:录制语音笔记)。 */
export type ComposerAttachAction = { id: string; label: string; icon?: ReactNode; disabled?: boolean; onSelect: () => void }

/**
 * 输入框左边的附件钮。
 * @@@ui-ruler 附件钮 = ui/IconButton(药丸档)。原来是 GHOST_BTN 内联 30×30 + `.composer-gh` 手写 hover
 * + mobile 三元改 44 —— 三态与触控档都归原语,`--icon-md` 出图标尺寸,不再传 width/height。
 * 图标改 @/lib/icons 的 Solar Paperclip:与原来手写的那条 path 逐字节相同,字形不变。
 *
 * 给了 `actions` 就做成菜单(助理聊天框的「+」):第一项「文件」照旧选文件,后面接这几项;缺省 = 点一下直接选文件。
 */
export function ComposerAttachButton({
  glyph,
  actions,
  disabled,
  mobile,
  onPickFile,
}: {
  glyph?: ReactNode
  actions?: readonly ComposerAttachAction[]
  disabled: boolean
  mobile: boolean
  onPickFile: () => void
}) {
  const { t } = useTranslation('messaging')
  if (!actions?.length) {
    return (
      <IconButton shape="pill" size="md" title={t('composer.file')} aria-label={t('composer.file')} disabled={disabled} onClick={onPickFile}>
        {glyph ?? <Paperclip />}
      </IconButton>
    )
  }
  return (
    <DropdownMenu.Root modal={false}>
      {/* 与 IconButton 同一身样子(药丸档),只是点了开菜单。 */}
      <DropdownMenu.Trigger
        disabled={disabled}
        data-testid="chat-composer-attach-menu"
        data-slot="icon-button"
        data-size="md"
        data-shape="pill"
        data-mobile={mobile || undefined}
        className="gg-icon-btn gg-ghost window-no-drag-region"
        title={t('composer.attach')}
        aria-label={t('composer.attach')}
      >
        {glyph ?? <Paperclip />}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content side="top" align="start" sideOffset={6}>
        <MenuItem icon={<Paperclip />} onClick={onPickFile} data-testid="chat-composer-attach-file">
          {t('composer.file')}
        </MenuItem>
        {actions.map((action) => (
          <MenuItem key={action.id} icon={action.icon} disabled={action.disabled} onClick={action.onSelect} data-testid={`chat-composer-attach-${action.id}`}>
            {action.label}
          </MenuItem>
        ))}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  )
}
