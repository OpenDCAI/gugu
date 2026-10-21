/**
 * 提醒事项(reminders.* 13 个):EventKit 经咕咕的原生助手(native/mac-helper Reminders.swift)。
 * 参数沿用咕咕第一版的名字(title / due / list / notes / include_completed),与日历一样用 snake_case;
 * 列表(容器)那几个用确切 id(list_id)。
 * 建提醒先查同一列表里有没有同名、没完成的(有就先问);删除(提醒 / 整个列表)每次先问,问句说出真名 ——
 * 和日历的删除同一个做法(见 calendar.ts 开头):confirm 'always' + confirmsItself,没带 confirmed 先读出那一条再问。
 */
import { DEVICE_ACTION_CONFIRMED_ARG } from '@gugu/core/shared/deviceActions'
import { bad, MAC_PRIVACY, ok, requestHelperPermission, str, TIME_HINT, type ActionFamily, type Args } from '../catalog'
import {
  ASK_MESSAGE,
  askFirst,
  CONFIRMED_PROP,
  CURSOR_PROP,
  DATE_ONLY,
  defined,
  helper,
  isTime,
  LIMIT_PROP,
  localMs,
  optText,
  pageParams,
  pageProblem,
  RECURRENCE_SCHEMA,
  recurrenceProblem,
  sameTitle,
  whenZh,
  type ContainerRow,
} from './calendar'

interface ReminderRow {
  reminder_id: string
  title: string
  completed: boolean
  list: string
  list_id: string
  due?: string
}

const PRIORITY_PROP = { type: 'string', enum: ['high', 'medium', 'low', 'none'] }
const COLOR_PROP = { type: 'string', description: 'Hex color like #FF9500' }
const colorProblem = (args: Args) => (args.color !== undefined && !/^#?[0-9a-f]{6}$/i.test(str(args, 'color')) ? 'color must be a hex color like #FF9500' : null)
const stringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === 'string' && v.trim().length > 0)

/** 建 / 改共用的检查。 */
function reminderFieldsProblem(args: Args): string | null {
  const due = args.due
  if (due !== undefined && due !== null && (typeof due !== 'string' || (due.trim() !== '' && !isTime(due.trim())))) return `due must be ${TIME_HINT}`
  if (args.priority !== undefined && !['high', 'medium', 'low', 'none'].includes(str(args, 'priority'))) return 'priority must be high / medium / low / none'
  if (args.alarm !== undefined && typeof args.alarm !== 'boolean') return 'alarm must be true or false'
  const url = optText(args, 'url')
  if (url && !/^[a-z][a-z0-9+.-]*:/i.test(url)) return 'url must be an absolute URL (https://…)'
  return recurrenceProblem(args.recurrence)
}

/** 发给原生助手的提醒字段。creating:空串不发;改:空串 = 清空,due: null / '' = 去掉到期。 */
function reminderFields(args: Args, creating: boolean) {
  const text = (key: string) => (creating ? str(args, key) || undefined : optText(args, key))
  const due = args.due === undefined ? undefined : args.due === null || str(args, 'due') === '' ? (creating ? undefined : null) : str(args, 'due')
  return {
    title: str(args, 'title') || undefined,
    notes: text('notes'),
    due,
    list: str(args, 'list') || undefined,
    priority: str(args, 'priority') || undefined,
    url: text('url'),
    alarm: typeof args.alarm === 'boolean' ? args.alarm : undefined,
    recurrence: args.recurrence,
  }
}

const REMINDER_PROPS = {
  title: { type: 'string' },
  notes: { type: 'string' },
  due: { type: ['string', 'null'], description: `Due. ${TIME_HINT} A date only (2026-10-16) = due that day without a time.` },
  list: { type: 'string', description: 'List name or id from reminders.lists' },
  priority: PRIORITY_PROP,
  url: { type: 'string' },
  alarm: { type: 'boolean', description: 'Alert at the due time (default true when due has a time)' },
  recurrence: RECURRENCE_SCHEMA,
}

export function createRemindersFamily(): ActionFamily {
  return {
    groups: [{
      id: 'reminders',
      platforms: ['darwin'],
      needs: 'macHelper',
      iconApp: '/System/Applications/Reminders.app',
      settingsUrl: MAC_PRIVACY('Privacy_Reminders'),
      osPermission: '系统设置 → 隐私与安全性 → 提醒事项 → 打开咕咕（完全访问）',
      probe: (ctx) => requestHelperPermission(ctx, 'reminders', '提醒事项'),
    }],
    actions: [
      {
        name: 'reminders.status',
        succeedsWithoutPermission: true,
        group: 'reminders',
        title: '提醒事项授权状态',
        titleEn: 'Reminders status',
        description: 'Read whether 咕咕 may use this Mac\'s Reminders, without prompting: authorization (granted / denied / not_determined / restricted), full_access, timezone, and with access the default list and the number of lists. Use it to explain os_permission failures.',
        risk: 'low',
        confirm: 'never',
        input_schema: { type: 'object', properties: {}, additionalProperties: false },
        run: async (_args, ctx) => ok(await helper(ctx, 'reminders.status', {})),
      },
      {
        name: 'reminders.sources.list',
        group: 'reminders',
        title: '列出提醒账户',
        titleEn: 'List reminder accounts',
        description: 'List the Reminders accounts on this Mac (iCloud, Exchange, On My Mac …): id, name, type and the ids of their lists. A source id goes into reminders.lists.create as source_id.',
        risk: 'low',
        confirm: 'never',
        input_schema: { type: 'object', properties: {}, additionalProperties: false },
        run: async (_args, ctx) => ok(await helper(ctx, 'reminders.sources', {})),
      },
      {
        name: 'reminders.lists',
        group: 'reminders',
        title: '列出提醒列表',
        titleEn: 'List reminder lists',
        description: 'List the reminder lists on this Mac ("Reminders", "Shopping" …): id, name, color, account (source), writable, is_default (where new reminders go when list is omitted). Filters: writable_only, source_id. This lists the lists, not the reminders in them (that is reminders.list).',
        risk: 'low',
        confirm: 'never',
        input_schema: {
          type: 'object',
          properties: { writable_only: { type: 'boolean' }, source_id: { type: 'string', description: 'Only lists of this account (reminders.sources.list)' } },
          additionalProperties: false,
        },
        run: async (args, ctx) => ok(await helper(ctx, 'reminders.lists.list', defined({
          writable_only: typeof args.writable_only === 'boolean' ? args.writable_only : undefined,
          source_id: str(args, 'source_id') || undefined,
        }))),
      },
      {
        name: 'reminders.lists.get',
        group: 'reminders',
        title: '查看提醒列表',
        titleEn: 'Get reminder list',
        description: 'Read one reminder list (the container) by its exact list_id from reminders.lists: same fields as a reminders.lists row plus reminder_count and incomplete_count.',
        risk: 'low',
        confirm: 'never',
        input_schema: { type: 'object', required: ['list_id'], properties: { list_id: { type: 'string' } }, additionalProperties: false },
        validate: (args) => (str(args, 'list_id') ? null : 'list_id is required (from reminders.lists)'),
        run: async (args, ctx) => ok(await helper(ctx, 'reminders.lists.get', { list_id: str(args, 'list_id'), count: true })),
      },
      {
        name: 'reminders.lists.create',
        group: 'reminders',
        title: '新建提醒列表',
        titleEn: 'Create reminder list',
        description: 'Create a new, empty reminder list. name is required; color is a hex like #FF9500; source_id picks the account (reminders.sources.list; default = the account of the default list). If a list with that name already exists it returns needs_confirmation first. Returns the new list row.',
        risk: 'medium',
        confirm: 'on_conflict',
        input_schema: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' }, color: COLOR_PROP, source_id: { type: 'string' }, ...CONFIRMED_PROP },
          additionalProperties: false,
        },
        validate: (args) => (str(args, 'name') ? colorProblem(args) : 'name is required'),
        async run(args, ctx) {
          const name = str(args, 'name')
          const sourceId = str(args, 'source_id') || undefined
          if (args[DEVICE_ACTION_CONFIRMED_ARG] !== true) {
            const { lists } = await helper<{ lists: ContainerRow[] }>(ctx, 'reminders.lists.list', {})
            const same = lists.filter((l) => sameTitle(l.name, name) && (!sourceId || l.source?.id === sourceId))
            if (same.length > 0) {
              const where = same.map((l) => l.source?.name).filter(Boolean).join('、')
              return askFirst(ASK_MESSAGE('created'), `已经有叫「${name}」的提醒列表${where ? `（${where}）` : ''}，还要再建一个同名的吗？`, { existing: same })
            }
          }
          return ok(await helper(ctx, 'reminders.lists.create', defined({ name, color: str(args, 'color') || undefined, source_id: sourceId })))
        },
      },
      {
        name: 'reminders.lists.update',
        group: 'reminders',
        title: '改提醒列表',
        titleEn: 'Update reminder list',
        description: 'Rename and/or recolor a reminder list by its exact list_id from reminders.lists (name, color as #RRGGBB; at least one). Returns the updated list row.',
        risk: 'medium',
        confirm: 'never',
        input_schema: {
          type: 'object',
          required: ['list_id'],
          properties: { list_id: { type: 'string' }, name: { type: 'string' }, color: COLOR_PROP },
          additionalProperties: false,
        },
        validate: (args) => {
          if (!str(args, 'list_id')) return 'list_id is required (from reminders.lists)'
          if (!str(args, 'name') && !str(args, 'color')) return 'pass name and/or color'
          return colorProblem(args)
        },
        run: async (args, ctx) => ok(await helper(ctx, 'reminders.lists.update', defined({
          list_id: str(args, 'list_id'),
          name: str(args, 'name') || undefined,
          color: str(args, 'color') || undefined,
        }))),
      },
      {
        name: 'reminders.lists.delete',
        group: 'reminders',
        title: '删除提醒列表',
        titleEn: 'Delete reminder list',
        description: 'Delete a whole reminder list AND every reminder in it, by its exact list_id from reminders.lists. The person is always asked first: without confirmed: true nothing is deleted and it returns needs_confirmation naming the list and how many reminders it holds; ask them, and only if they agree call again with the same args plus confirmed: true.',
        risk: 'high',
        confirm: 'always',
        confirmsItself: true,
        input_schema: { type: 'object', required: ['list_id'], properties: { list_id: { type: 'string' }, ...CONFIRMED_PROP }, additionalProperties: false },
        validate: (args) => (str(args, 'list_id') ? null : 'list_id is required (from reminders.lists)'),
        async run(args, ctx) {
          const id = str(args, 'list_id')
          if (args[DEVICE_ACTION_CONFIRMED_ARG] !== true) {
            const list = await helper<ContainerRow & { reminder_count?: number }>(ctx, 'reminders.lists.get', { list_id: id, count: true })
            if (list.immutable) return bad(`"${list.name}" is a system list and cannot be deleted.`)
            const where = list.source?.name ? `（${list.source.name}）` : ''
            const count = typeof list.reminder_count === 'number' ? `全部 ${list.reminder_count} 条` : '全部'
            const isDefault = list.is_default ? '它是新提醒默认放进去的列表。' : ''
            return askFirst(ASK_MESSAGE('deleted'), `要删除提醒列表「${list.name}」${where}和里面的${count}提醒吗？删了不能撤销。${isDefault}`, { list })
          }
          ctx.note('正在删除提醒列表…')
          return ok(await helper(ctx, 'reminders.lists.delete', { list_id: id, confirmed: true }))
        },
      },
      {
        name: 'reminders.list',
        group: 'reminders',
        title: '查提醒',
        titleEn: 'List reminders',
        description: `List reminders. status: incomplete (default) / completed / all (include_completed: true = all). Filters: list (name or id), list_ids, due_after / due_before (${TIME_HINT} a date-only due_before includes that day; reminders without a due date drop out when either is set), query (matches title / notes). Sorted: not-done first by due (no due last), then done ones newest first. Each reminder: reminder_id (for get / update / complete / delete), title, completed, list, list_id, due (date-only = no time; due_all_day), priority, notes (first 300 chars), url, recurring. Pages: limit (default 50), then next_cursor as cursor while has_more.`,
        risk: 'medium',
        confirm: 'never',
        input_schema: {
          type: 'object',
          properties: {
            list: { type: 'string', description: 'List name or id' },
            list_ids: { type: 'array', items: { type: 'string' } },
            status: { type: 'string', enum: ['incomplete', 'completed', 'all'] },
            include_completed: { type: 'boolean', description: 'Same as status: all' },
            due_after: { type: 'string' },
            due_before: { type: 'string' },
            query: { type: 'string' },
            limit: LIMIT_PROP,
            cursor: CURSOR_PROP,
          },
          additionalProperties: false,
        },
        validate: (args) => {
          if (args.status !== undefined && !['incomplete', 'completed', 'all'].includes(str(args, 'status'))) return 'status must be incomplete / completed / all'
          for (const key of ['due_after', 'due_before']) if (str(args, key) && !isTime(str(args, key))) return `${key} must be ${TIME_HINT}`
          const after = str(args, 'due_after')
          const before = str(args, 'due_before')
          if (after && before && localMs(before) + (DATE_ONLY.test(before) ? 86_400_000 : 0) <= localMs(after)) return 'due_before must be after due_after'
          if (args.list_ids !== undefined && !stringList(args.list_ids)) return 'list_ids must be an array of list ids'
          return pageProblem(args)
        },
        run: async (args, ctx) => ok(await helper(ctx, 'reminders.items.list', defined({
          list: str(args, 'list') || undefined,
          list_ids: stringList(args.list_ids) ? args.list_ids : undefined,
          status: str(args, 'status') || (args.include_completed === true ? 'all' : undefined),
          due_after: str(args, 'due_after') || undefined,
          due_before: str(args, 'due_before') || undefined,
          query: str(args, 'query') || undefined,
          ...pageParams(args),
        }))),
      },
      {
        name: 'reminders.get',
        group: 'reminders',
        title: '看提醒',
        titleEn: 'Get reminder',
        description: 'Read one reminder by reminder_id (from reminders.list): everything list returns plus notes (up to 2000 chars), alarms, recurrence (RRULE), start, created, modified.',
        risk: 'medium',
        confirm: 'never',
        input_schema: { type: 'object', required: ['reminder_id'], properties: { reminder_id: { type: 'string' } }, additionalProperties: false },
        validate: (args) => (str(args, 'reminder_id') ? null : 'reminder_id is required (from reminders.list)'),
        run: async (args, ctx) => ok(await helper(ctx, 'reminders.items.get', { reminder_id: str(args, 'reminder_id') })),
      },
      {
        name: 'reminders.create',
        group: 'reminders',
        title: '建提醒',
        titleEn: 'Create reminder',
        description: `Create a reminder in this Mac's Reminders. title is required. due: ${TIME_HINT} A date only (2026-10-16) = due that day without a time; with a time the person is also alerted at that moment (alarm: false to skip). list: name or id from reminders.lists (default = the default list). Optional notes, priority (high / medium / low), url, recurrence (needs due). If that list already has an unfinished reminder with the same title, nothing is created and it returns needs_confirmation — ask the person, and only if they agree call again with the same args plus confirmed: true. Returns the reminder (reminder_id, title, due, list …).`,
        risk: 'medium',
        confirm: 'on_conflict',
        input_schema: { type: 'object', required: ['title'], properties: { ...REMINDER_PROPS, ...CONFIRMED_PROP }, additionalProperties: false },
        validate: (args) => {
          if (!str(args, 'title')) return 'title is required'
          if (args.recurrence !== undefined && !str(args, 'due')) return 'a repeating reminder needs due as well'
          return reminderFieldsProblem(args)
        },
        async run(args, ctx) {
          const fields = reminderFields(args, true)
          const title = str(args, 'title')
          if (args[DEVICE_ACTION_CONFIRMED_ARG] !== true) {
            const r = await helper<{ reminders: ReminderRow[] }>(ctx, 'reminders.items.list', defined({
              list: fields.list,
              default_list: fields.list ? undefined : true,
              status: 'incomplete',
              query: title,
              limit: 500,
            }))
            const same = r.reminders.filter((x) => !x.completed && sameTitle(x.title, title))
            if (same.length > 0) {
              const first = same[0]!
              const due = first.due ? `（到期 ${whenZh(first.due, ctx.deps.now())}）` : ''
              return askFirst(
                `Nothing was created yet: the list already has an unfinished reminder with this title (confirm.details.existing). Ask the person the confirm.question; only if they still want another one, call again with the same args plus confirmed: true.`,
                `「${first.list}」里已经有没完成的提醒「${first.title}」${due}，还要再建一条吗？`,
                { existing: same.slice(0, 10) },
              )
            }
          }
          ctx.note('正在建提醒…')
          return ok(await helper(ctx, 'reminders.items.create', defined(fields)))
        },
      },
      {
        name: 'reminders.update',
        group: 'reminders',
        title: '改提醒',
        titleEn: 'Update reminder',
        description: `Change a reminder by reminder_id (from reminders.list). Only the fields you pass change: title, notes, due (${TIME_HINT} null removes the due date), list (move; name or id), priority, url, alarm, recurrence ({"frequency":"none"} stops repeating). An empty string clears notes / url. To tick it off use reminders.complete. Returns the updated reminder plus changed (field names).`,
        risk: 'medium',
        confirm: 'never',
        input_schema: { type: 'object', required: ['reminder_id'], properties: { reminder_id: { type: 'string' }, ...REMINDER_PROPS }, additionalProperties: false },
        validate: (args) => {
          if (!str(args, 'reminder_id')) return 'reminder_id is required (from reminders.list)'
          const keys = ['title', 'notes', 'due', 'list', 'priority', 'url', 'alarm', 'recurrence']
          if (!keys.some((k) => args[k] !== undefined)) return `nothing to change: pass at least one of ${keys.join(', ')}`
          if (args.title !== undefined && !str(args, 'title')) return 'title cannot be empty'
          return reminderFieldsProblem(args)
        },
        async run(args, ctx) {
          ctx.note('正在改提醒…')
          return ok(await helper(ctx, 'reminders.items.update', defined({ reminder_id: str(args, 'reminder_id'), ...reminderFields(args, false) })))
        },
      },
      {
        name: 'reminders.complete',
        group: 'reminders',
        title: '完成提醒',
        titleEn: 'Complete reminder',
        description: 'Tick a reminder off (completed: true, the default) or mark it not done again (completed: false), by reminder_id from reminders.list. completion_date sets when it was done (default now; an already-done reminder keeps its time). For a repeating reminder read the returned reminder (or reminders.list) instead of assuming a next occurrence was made. Returns the reminder.',
        risk: 'medium',
        confirm: 'never',
        input_schema: {
          type: 'object',
          required: ['reminder_id'],
          properties: { reminder_id: { type: 'string' }, completed: { type: 'boolean' }, completion_date: { type: 'string' } },
          additionalProperties: false,
        },
        validate: (args) => {
          if (!str(args, 'reminder_id')) return 'reminder_id is required (from reminders.list)'
          if (args.completed !== undefined && typeof args.completed !== 'boolean') return 'completed must be true or false'
          if (str(args, 'completion_date') && !isTime(str(args, 'completion_date'))) return `completion_date must be ${TIME_HINT}`
          if (args.completed === false && str(args, 'completion_date')) return 'completion_date only goes with completed: true'
          return null
        },
        run: async (args, ctx) => ok(await helper(ctx, 'reminders.items.complete', defined({
          reminder_id: str(args, 'reminder_id'),
          completed: typeof args.completed === 'boolean' ? args.completed : true,
          completion_date: str(args, 'completion_date') || undefined,
        }))),
      },
      {
        name: 'reminders.delete',
        group: 'reminders',
        title: '删提醒',
        titleEn: 'Delete reminder',
        description: 'Delete a reminder by reminder_id (from reminders.list). The person is always asked first: without confirmed: true nothing is deleted and it returns needs_confirmation naming the reminder and its list — ask them, and only if they agree call again with the same args plus confirmed: true. To tick a reminder off use reminders.complete instead.',
        risk: 'high',
        confirm: 'always',
        confirmsItself: true,
        input_schema: { type: 'object', required: ['reminder_id'], properties: { reminder_id: { type: 'string' }, ...CONFIRMED_PROP }, additionalProperties: false },
        validate: (args) => (str(args, 'reminder_id') ? null : 'reminder_id is required (from reminders.list)'),
        async run(args, ctx) {
          const id = str(args, 'reminder_id')
          if (args[DEVICE_ACTION_CONFIRMED_ARG] !== true) {
            const reminder = await helper<ReminderRow>(ctx, 'reminders.items.get', { reminder_id: id })
            const due = reminder.due ? `，到期 ${whenZh(reminder.due, ctx.deps.now())}` : ''
            return askFirst(ASK_MESSAGE('deleted'), `要删除提醒「${reminder.title}」（「${reminder.list}」列表${due}）吗？`, { reminder })
          }
          ctx.note('正在删提醒…')
          return ok(await helper(ctx, 'reminders.items.delete', { reminder_id: id, confirmed: true }))
        },
      },
    ],
  }
}
