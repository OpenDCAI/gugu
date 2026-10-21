import enUSMessaging from './locales/en-US/messaging'
import zhCNMessaging from './locales/zh-CN/messaging'
import { registerLocaleNamespace } from './runtime'

registerLocaleNamespace('messaging', {
  'zh-CN': zhCNMessaging,
  'en-US': enUSMessaging,
})
