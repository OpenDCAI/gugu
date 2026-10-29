import enUSBrowserUse from './locales/en-US/browserUse'
import zhCNBrowserUse from './locales/zh-CN/browserUse'
import { registerLocaleNamespace } from './runtime'

registerLocaleNamespace('browserUse', {
  'zh-CN': zhCNBrowserUse,
  'en-US': enUSBrowserUse,
})
