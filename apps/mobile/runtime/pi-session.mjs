import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { createAgentSession, SessionManager, SettingsManager, DefaultResourceLoader, ModelRuntime } from '@earendil-works/pi-coding-agent'
import { phoneCalendarEventView } from '../../desktop/src/mobile/phone-device/phoneCalendarView.ts'
import { createPhonePiObserver } from './phone-agent-live.mjs'

const turns = new Map()
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function cancelTurn(sessionId) {
  const turn = turns.get(sessionId)
  if (!turn) return false
  turn.controller.abort(new Error('任务已取消'))
  void turn.session?.abort()
  return true
}

/** Each Gugu session owns its Pi transcript and cancellation boundary. No CLI tools are loaded. */
export async function runTurn(command, { emit, nativeCall, extraTools = [], systemPrompt = '', onRecord = async () => undefined }) {
  if (!UUID.test(command.sessionId)) throw new Error('无效的手机会话标识')
  if (command.contextEpoch && !UUID.test(command.contextEpoch)) throw new Error('无效的手机上下文标识')
  if (turns.has(command.sessionId)) throw new Error('这条会话还在运行')
  const turn = { controller: new AbortController(), session: null }
  turns.set(command.sessionId, turn)
  if (command.cancelled) turn.controller.abort()
  const context = { sessionId: command.sessionId, ...(command.agentUserId ? { agentUserId: command.agentUserId } : {}) }
  const output = (event) => emit({ ...event, ...context })
  const modelConfig = command.modelConfig ?? command
  try {
    turn.controller.signal.throwIfAborted()
    const cwd = command.contextEpoch ? join(process.env.GUGU_AGENT_HOME, command.sessionId, command.contextEpoch) : join(process.env.GUGU_AGENT_HOME, command.sessionId)
    await mkdir(cwd, { recursive: true })
    const legacyTools = [{
      name: 'phone_calendar_list', label: '读取这台手机的日历',
      description: '读取这台 Android 手机日历。查某天给 date（YYYY-MM-DD），查时间段给 start/end（ISO 8601）。不填日期则查从今天起7天。日期由手机按本地时区解释，不要计算时间戳。必须实际调用工具后再回答日程。工具拒绝授权时明确说明，不能猜测。',
      parameters: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD，当天' }, start: { type: 'string', description: 'ISO 8601，时间范围起点' }, end: { type: 'string', description: 'ISO 8601，时间范围终点' }, limit: { type: 'integer', minimum: 1, maximum: 500 } } },
      execute: async (_id, args, signal) => {
        const result = await nativeCall('calendar.events.list', args, signal, context)
        if (result.ok) result.data.events = result.data.events.map(phoneCalendarEventView)
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }
      },
    }, ...[
      { name: 'phone_contacts_list', label: '查询手机通讯录', native: 'contacts.list', description: '只读查询本手机通讯录。可按 query 搜索名字、电话或邮箱；不填则按名字列出。只有咕咕通讯录授权与系统读取权限都开启时才执行。授权失败如实说明，不猜测联系人。',
        parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 500 } } } },
      { name: 'phone_notifications_list', label: '读取手机通知', native: 'notifications.list', description: '只读查询手机通知栏及咕咕已获授权期间收到的近期通知。app 可按 App 名或包名筛选。只有用户开启通知组并授予系统通知使用权时才执行。',
        parameters: { type: 'object', properties: { app: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200 } } } },
    ].map(({ native, ...definition }) => ({ ...definition, execute: async (_id, args, signal) => {
      const result = await nativeCall(native, args, signal, context)
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }
    } }))]
    const tools = [...(command.phoneTools === 'catalog' ? [] : legacyTools), ...extraTools]
    if (new Set(tools.map((tool) => tool.name)).size !== tools.length) throw new Error('手机工具名称重复')
    const settingsManager = SettingsManager.inMemory({ defaultProvider: 'gugu', defaultModel: modelConfig.model, defaultThinkingLevel: 'off' })
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPromptOverride: () => `你是运行在咕咕 Android App 内的 Pi 任务 Agent。用中文简短回答。当前手机时间 ${new Date().toISOString()}，时区 ${Intl.DateTimeFormat().resolvedOptions().timeZone}。只有列出的受控工具，没有 shell。手机数据必须实际调用工具后才可陈述；授权失败要如实说明。\n${systemPrompt || command.systemPrompt || ''}` })
    await resourceLoader.reload()
    turn.controller.signal.throwIfAborted()
    const modelRuntime = await ModelRuntime.create({ modelsPath: null, authPath: join(cwd, 'auth.json'), refreshOnCreate: false })
    modelRuntime.registerProvider('gugu', {
      baseUrl: modelConfig.baseUrl, apiKey: modelConfig.apiKey, api: 'openai-completions',
      models: [{ id: modelConfig.model, name: modelConfig.model, reasoning: modelConfig.reasoning === true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: modelConfig.contextWindow || 128000, maxTokens: modelConfig.maxTokens || 4096 }],
    })
    turn.controller.signal.throwIfAborted()
    const sessionManager = SessionManager.continueRecent(cwd, join(cwd, 'sessions'))
    const created = await createAgentSession({ cwd, agentDir: cwd, modelRuntime, model: modelRuntime.getModel('gugu', modelConfig.model), thinkingLevel: 'off', settingsManager, resourceLoader,
      tools: tools.map((tool) => tool.name), customTools: tools, sessionManager })
    turn.session = created.session
    await onRecord({ path: sessionManager.getSessionFile(), providerSessionId: sessionManager.getSessionId() })
    const observe = createPhonePiObserver({ jobId: command.jobId ?? command.sessionId, sessionManager, emit: output })
    turn.session.subscribe((event) => {
      observe(event)
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') output({ type: 'text', text: event.assistantMessageEvent.delta })
      if (event.type === 'tool_execution_start') output({ type: 'tool_start', name: event.toolName, args: event.args })
      if (event.type === 'tool_execution_end') output({ type: 'tool_end', name: event.toolName, result: event.result, isError: event.isError })
    })
    output({ type: 'started', node: process.version, platform: process.platform, arch: process.arch, pid: process.pid })
    turn.controller.signal.throwIfAborted()
    await turn.session.prompt(command.prompt)
    const last = turn.session.messages.at(-1)
    if (turn.controller.signal.aborted || last?.stopReason === 'aborted') return { status: 'cancelled', text: '' }
    if (last?.role === 'assistant' && last.stopReason === 'error') return { status: 'failed', text: '', error: last.errorMessage || '模型请求失败' }
    return { status: 'done', text: turn.session.getLastAssistantText() ?? '' }
  } catch (error) {
    if (turn.controller.signal.aborted) return { status: 'cancelled', text: '' }
    throw error
  } finally {
    turn.session?.dispose()
    if (turns.get(command.sessionId) === turn) turns.delete(command.sessionId)
  }
}
