import enUSAssistant from './locales/en-US/assistant'
import zhCNAssistant from './locales/zh-CN/assistant'
import { registerLocaleNamespace } from './runtime'

registerLocaleNamespace('assistant', {
  'zh-CN': zhCNAssistant,
  'en-US': enUSAssistant,
})
