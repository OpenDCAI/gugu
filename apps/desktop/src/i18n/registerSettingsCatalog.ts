import { registerLocaleNamespace } from './runtime'
import enUS from './locales/en-US/settings'
import zhCN from './locales/zh-CN/settings'

registerLocaleNamespace('settings', {
  'zh-CN': zhCN,
  'en-US': enUS,
})
