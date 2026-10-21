import enUSAgents from './locales/en-US/agents'
import zhCNAgents from './locales/zh-CN/agents'
import { registerLocaleNamespace } from './runtime'

registerLocaleNamespace('agents', {
  'zh-CN': zhCNAgents,
  'en-US': enUSAgents,
})
