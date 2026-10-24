import type { ReactNode } from 'react'
import { observer } from 'mobx-react-lite'
import { useTranslation } from 'react-i18next'
import { MoreHorizontal } from '@/lib/icons'
import { installedExtensionsStore } from '../../session/renderer/features/extensions/installed-extensions-store'
import { IconButton } from '../ui/IconButton'
import { DropdownMenu } from '../ui/Menu'
import { OpenAppMenuItems } from './OpenAppMenuItems'

/**
 * A topic's ⋯ (TopicSplitPane), the group header's menu over again (ChatHeaderActions): on the phone what its header has
 * no room for (`items`, as a group's compact header folds them in), then the Apps that open in the source chat's panel. With
 * neither, no ⋯.
 */
export const TopicMoreMenu = observer(function TopicMoreMenu({ chatId, mobile, items }: {
  chatId: string
  mobile: boolean
  items?: ReactNode
}) {
  const { t } = useTranslation('messaging')
  if (!items && installedExtensionsStore.openableApps.length === 0) return null
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger
        data-testid="topic-split-more"
        title={t('header.more')}
        aria-haspopup="menu"
        render={(
          <IconButton size={mobile ? 'md' : 'sm'} tone="strong" aria-label={t('header.more')}>
            <MoreHorizontal size={16} />
          </IconButton>
        )}
      />
      <DropdownMenu.Content side="bottom" align="end" sideOffset={4} className="min-w-[148px]">
        {items}
        <OpenAppMenuItems chatId={chatId} separated={Boolean(items)} />
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  )
})
