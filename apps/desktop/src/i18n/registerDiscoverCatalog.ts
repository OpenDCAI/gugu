import { registerLocaleNamespace } from './runtime'
import enUS from './locales/en-US/discover'
import zhCN from './locales/zh-CN/discover'

registerLocaleNamespace('discover', {
  'zh-CN': zhCN,
  'en-US': enUS,
})
