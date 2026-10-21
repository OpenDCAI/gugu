import EmojiPicker from '@emoji-mart/react'
import data from '@emoji-mart/data'
import zh from '@emoji-mart/data/i18n/zh.json'
import { useTranslation } from 'react-i18next'
import { useTheme } from '../store/theme'

/** 完整表情集沿用 emoji-mart;浮层、关闭与工作状态由消息动作面板负责。 */
export function EmojiPickerPanel({ onSelect }: { onSelect: (emoji: string) => void }) {
  const { theme } = useTheme()
  const { t, i18n } = useTranslation('messaging')
  return (
    <div className="w-full [&_em-emoji-picker]:w-full">
      <EmojiPicker
        data={data}
        i18n={i18n.language.startsWith('zh') ? { ...zh, categories: { ...zh.categories, frequent: t('emoji.frequent') } } : undefined}
        onEmojiSelect={(emoji: { native: string }) => onSelect(emoji.native)}
        theme={theme}
        locale={i18n.language.startsWith('zh') ? 'zh' : 'en'}
        skinTonePosition="none"
        previewPosition="none"
        navPosition="top"
        searchPosition="sticky"
        perLine={9}
        dynamicWidth
        maxFrequentRows={2}
        autoFocus={false}
        set="native"
      />
    </div>
  )
}
