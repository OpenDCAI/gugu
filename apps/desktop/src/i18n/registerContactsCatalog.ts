import enUSContacts from './locales/en-US/contacts'
import zhCNContacts from './locales/zh-CN/contacts'
import { registerLocaleNamespace } from './runtime'

registerLocaleNamespace('contacts', {
  'zh-CN': zhCNContacts,
  'en-US': enUSContacts,
})
