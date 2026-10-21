import { ComposerModelMenu, MessageProvider, type ComposerModelItem } from '@gugu/session-ui/react/components'
import { useTranslation } from 'react-i18next'
import { translateSessionMessage } from '@/session/renderer/localization/locale-store'
import type { SessionMessageLookupKey } from '@/session/renderer/localization/messages'

/** 与会话输入框共用模型菜单：搜索、厂商筛选、来源分组和受控滚动。 */
export function AgentModelPicker({ items, value, disabled, onChange }: {
  items: ComposerModelItem[]
  value: string
  disabled: boolean
  onChange: (value: string) => void
}) {
  const { i18n } = useTranslation()
  return (
    <MessageProvider locale={i18n.language} translate={(key, values) => translateSessionMessage(key as SessionMessageLookupKey, values)}>
      <ComposerModelMenu
        panel={{ kind: 'shown', modelRow: 'list' }}
        modelItems={items}
        selectedModel={value}
        onModelChange={onChange}
        disabled={disabled}
        effortItems={[]}
      />
    </MessageProvider>
  )
}
