import enUSMain from './locales/en-US/main'
import zhCNMain from './locales/zh-CN/main'
import { registerLocaleNamespace } from './runtime'

registerLocaleNamespace('main', {
  'zh-CN': zhCNMain,
  'en-US': enUSMain,
})
