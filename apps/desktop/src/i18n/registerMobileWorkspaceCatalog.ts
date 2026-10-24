import enUSMobileWorkspace from './locales/en-US/mobileWorkspace'
import zhCNMobileWorkspace from './locales/zh-CN/mobileWorkspace'
import { registerLocaleNamespace } from './runtime'

registerLocaleNamespace('mobileWorkspace', {
  'zh-CN': zhCNMobileWorkspace,
  'en-US': enUSMobileWorkspace,
})
