import enUSVoiceNotes from './locales/en-US/voiceNotes'
import zhCNVoiceNotes from './locales/zh-CN/voiceNotes'
import { registerLocaleNamespace } from './runtime'

registerLocaleNamespace('voiceNotes', {
  'zh-CN': zhCNVoiceNotes,
  'en-US': enUSVoiceNotes,
})
