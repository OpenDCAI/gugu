import { GroupRenameContext } from './use-chat-commands'
import { useContext, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { resolveOrLoud } from '@gugu/core/shared/resolveOrLoud'
import { Pencil } from '@/lib/icons'
import { IconButton } from '../ui/IconButton'
import { InlineNameInput } from '../ui/InlineNameInput'

// @@@2070 群名就地编辑:默认显示为文字;canEdit(manager)点名字旁的编辑钮或双击 → 变输入框(回车/失焦确认、Esc 取消)。
// 编辑钮是触屏上唯一的入口:双击与 title 提示在手机上都不成立。
// onCommit 只在「有改动的非空名」时触发——空名 / 未改静默取消(绝不提交空名,守「空群名 → '群聊'」兜底)。
// 抽成独立组件:编辑态/草稿/busy 局部自持,父层只提供当前 name + 保存回调(复用既有改名链路)。
export function GroupNameInlineEdit({
  name,
  canEdit,
  onCommit,
  labels,
  wrap = false,
}: {
  name: string | null
  canEdit: boolean
  onCommit: (next: string) => Promise<void>
  /** 话题复用这个控件,但文案要说「话题」而不是「群名」(spec:界面文案中文写「话题」)。 */
  labels?: { editHint: string; placeholder: string }
  /** 在群自己的设置页里显示全名(换行);页头这类单行位置照旧截断。 */
  wrap?: boolean
}) {
  const { t } = useTranslation('messaging')
  const [editing, setEditing] = useState(false)

  const renameCommand = useContext(GroupRenameContext)
  const handledRequest = useRef(0)
  useEffect(() => {
    if (renameCommand?.request && renameCommand.request !== handledRequest.current && canEdit && name !== null) {
      handledRequest.current = renameCommand.request
      setEditing(true)
    }
  }, [renameCommand?.request, canEdit, name])

  if (name === null) {
    return (
      <div
        data-testid="group-name-display"
        aria-busy="true"
        style={{
          fontSize: 'var(--font-heading)',
          fontWeight: 600,
          color: 'var(--text-secondary)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          cursor: 'default',
          userSelect: 'none',
        }}
      >
        {t('group.nameLoading')}
      </div>
    )
  }

  if (canEdit && editing) {
    return (
      <InlineNameInput name={name} onCommit={onCommit} onClose={() => setEditing(false)}
        placeholder={labels?.placeholder ?? t('group.namePlaceholder')} />
    )
  }
  const startEditing = () => setEditing(true)
  return (
    <div className="flex min-w-0 items-center gap-1">
      <div
        data-testid="group-name-display"
        onDoubleClick={canEdit ? startEditing : undefined}
        style={{
          fontSize: 'var(--font-heading)',
          fontWeight: 600,
          color: 'var(--text-primary)',
          ...(wrap ? { overflowWrap: 'anywhere' } : { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
          minWidth: 0,
          cursor: canEdit ? 'text' : 'default',
          userSelect: canEdit ? 'none' : 'auto',
        }}
      >
        {resolveOrLoud(name, 'group members panel title')}
      </div>
      {canEdit ? (
        <IconButton size="sm" data-testid="group-name-edit" aria-label={labels?.editHint ?? t('group.editName')} onClick={startEditing}>
          <Pencil />
        </IconButton>
      ) : null}
    </div>
  )
}
