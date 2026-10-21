import enUSCloudBrowser from './locales/en-US/cloudBrowser'
import zhCNCloudBrowser from './locales/zh-CN/cloudBrowser'
import { registerLocaleNamespace } from './runtime'

registerLocaleNamespace('cloudBrowser', {
  'zh-CN': zhCNCloudBrowser,
  'en-US': enUSCloudBrowser,
})
