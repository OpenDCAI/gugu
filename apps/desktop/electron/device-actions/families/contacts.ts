/**
 * 通讯录(contacts.* 7 个):经原生助手走 Contacts 框架(native/mac-helper Contacts.swift)。
 * 找人在助手里做(名字 / 昵称 / 公司 / 邮箱按子串,电话按数字),这里管参数、说明与确认的规矩。
 * 要人点头的三种 —— 删一位、修改会丢掉已有的内容、新建同名联系人 —— 都在助手里判:只有它知道这位叫什么、会丢哪几项,
 * 问句才点得了名(删除是 confirm 'always' + confirmsItself:provider 开工前只看得到 id,问不出「删张三吗」,交给助手问)。
 */
import { DEVICE_ACTION_CONFIRMED_ARG } from '@gugu/core/shared/deviceActions'
import { MAC_PRIVACY, clampInt, num, ok, requestHelperPermission, str, type ActionDef, type ActionFamily, type ActionRunContext, type Args, type Outcome } from '../catalog'

async function helper(ctx: ActionRunContext, method: string, params: Record<string, unknown>, timeoutMs = 60_000): Promise<Outcome> {
  return ok(await ctx.deps.macHelper().call(method, params, { signal: ctx.signal, timeoutMs }))
}

const confirmed = (args: Args) => args[DEVICE_ACTION_CONFIRMED_ARG] === true

const STRING_FIELDS = ['firstName', 'lastName', 'middleName', 'nickname', 'organization', 'jobTitle', 'department', 'note', 'homePage', 'birthday'] as const
const LIST_FIELDS = ['emails', 'phones', 'addresses', 'urls'] as const
const EDIT_FIELDS = [...STRING_FIELDS, ...LIST_FIELDS] as const

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const URI = /^[a-z][a-z0-9+.-]*:\S+$/i
/** 「YYYY-MM-DD」或不记年份的「--MM-DD」。 */
const DAY = /^(?:\d{4}|-)-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/

const labeledList = (value: string, label: string) => ({
  type: 'array',
  maxItems: 50,
  items: {
    type: 'object',
    required: ['value'],
    properties: { label: { type: 'string', description: label }, value: { type: 'string', description: value } },
    additionalProperties: false,
  },
})

const FIELD_SCHEMA: Record<(typeof EDIT_FIELDS)[number], Record<string, unknown>> = {
  firstName: { type: 'string' },
  lastName: { type: 'string' },
  middleName: { type: 'string' },
  nickname: { type: 'string' },
  organization: { type: 'string', description: 'Company name' },
  jobTitle: { type: 'string' },
  department: { type: 'string' },
  note: { type: 'string' },
  homePage: { type: 'string', description: 'Homepage URL (absolute, e.g. https://…); stored as the URL labeled "homepage"' },
  birthday: { type: 'string', description: '"YYYY-MM-DD", or "--MM-DD" when the year is unknown' },
  emails: labeledList('Email address', 'home / work / iCloud / other, or any custom label'),
  phones: labeledList('Phone number as written, e.g. +86 138 0000 0000', 'mobile / iPhone / home / work / main / other, or any custom label'),
  addresses: {
    type: 'array',
    maxItems: 50,
    items: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'home / work / other, or any custom label' },
        street: { type: 'string' },
        city: { type: 'string' },
        state: { type: 'string' },
        zip: { type: 'string' },
        country: { type: 'string' },
        countryCode: { type: 'string', description: 'ISO 3166-1 alpha-2, e.g. cn, us' },
      },
      additionalProperties: false,
    },
  },
  urls: labeledList('Absolute URL, e.g. https://…', 'homepage / home / work / other, or any custom label'),
}

const entriesOf = (args: Args, key: string): Record<string, unknown>[] => (Array.isArray(args[key]) ? (args[key] as Record<string, unknown>[]) : [])
const valueOf = (entry: Record<string, unknown>) => (typeof entry.value === 'string' ? entry.value.trim() : '')

/** create / update 共用的字段检查(助手里还会再判一遍,这里先把明显的错挡在开工前)。 */
function checkFields(args: Args): string | null {
  for (const key of STRING_FIELDS) {
    if (args[key] !== undefined && typeof args[key] !== 'string') return `${key} must be a string`
  }
  for (const key of LIST_FIELDS) {
    const list = args[key]
    if (list === undefined) continue
    if (!Array.isArray(list)) return `${key} must be an array of objects`
    if (list.length > 50) return `${key}: at most 50 entries`
    if (list.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) return `${key}: every entry must be an object`
  }
  const badEmail = entriesOf(args, 'emails').find((e) => !EMAIL.test(valueOf(e)))
  if (badEmail) return `emails: "${valueOf(badEmail)}" is not an email address`
  if (entriesOf(args, 'phones').some((e) => !/\d/.test(valueOf(e)))) return 'phones: every entry needs a value with digits'
  const badUrl = entriesOf(args, 'urls').find((e) => !URI.test(valueOf(e)))
  if (badUrl) return `urls: "${valueOf(badUrl)}" is not an absolute URL (e.g. https://…)`
  if (entriesOf(args, 'addresses').some((e) => !['street', 'city', 'state', 'zip', 'country'].some((k) => typeof e[k] === 'string' && (e[k] as string).trim()))) {
    return 'addresses: every entry needs at least one of street, city, state, zip, country'
  }
  const homePage = str(args, 'homePage')
  if (homePage && !URI.test(homePage)) return 'homePage must be an absolute URL (e.g. https://…), or "" to remove it'
  const birthday = str(args, 'birthday')
  if (birthday && !DAY.test(birthday)) return 'birthday must be "YYYY-MM-DD" or "--MM-DD" (no year), or "" to remove it'
  return null
}

/** 只把认得的字段交给助手(❌ 原样转发 args)。 */
function pickFields(args: Args, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]))
}

const idOrName = (args: Args) => (str(args, 'id') || str(args, 'name') ? null : 'Pass id (from contacts.list) or name')

const contactsList: ActionDef = {
  name: 'contacts.list',
  group: 'contacts',
  title: '查联系人',
  titleEn: 'List contacts',
  description: 'List or search contacts in this Mac\'s Contacts. `search` matches name, nickname, company and email as a case-insensitive substring, and phone numbers by digits ("138 0000" finds +86 138-0000-…). `group` limits to a Contacts group by exact name (an unknown name returns the list of groups). Returns `total` matches and up to `limit` rows (default 50, max 500; `truncated` when more matched): id, name, organization, job_title, emails and phones with labels, birthday. Pass the id to contacts.get / update / delete / export.',
  risk: 'medium',
  confirm: 'never',
  input_schema: {
    type: 'object',
    properties: {
      search: { type: 'string', description: 'Text to find in name, nickname, company, email, or phone digits' },
      group: { type: 'string', description: 'Contacts group name' },
      limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Max rows (default 50)' },
    },
    additionalProperties: false,
  },
  validate: (args) => (args.limit !== undefined && num(args, 'limit') === undefined ? 'limit must be a number' : null),
  run: (args, ctx) =>
    helper(ctx, 'contacts.list', {
      ...(str(args, 'search') ? { search: str(args, 'search') } : {}),
      ...(str(args, 'group') ? { group: str(args, 'group') } : {}),
      limit: clampInt(num(args, 'limit'), 50, 1, 500),
    }),
}

const contactsGet: ActionDef = {
  name: 'contacts.get',
  group: 'contacts',
  title: '读联系人',
  titleEn: 'Get contact',
  description: 'Full detail of one contact, by `id` (from contacts.list) or by `name` (substring of name, nickname or company). When several match and exactly one has that exact name, that one is returned; otherwise you get { multiple: true, total, candidates } — pick one (ask the person if unsure) and call again with its id. Detail: names, organization, department, job_title, emails, phones, addresses, urls, birthday, dates, related_names, social_profiles, note (first 4000 chars).',
  risk: 'medium',
  confirm: 'never',
  input_schema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'Contact id from contacts.list' }, name: { type: 'string', description: 'Name to look up when the id is unknown' } },
    additionalProperties: false,
  },
  validate: idOrName,
  run: (args, ctx) => helper(ctx, 'contacts.get', str(args, 'id') ? { id: str(args, 'id') } : { name: str(args, 'name') }),
}

const contactsMe: ActionDef = {
  name: 'contacts.me',
  group: 'contacts',
  title: '读我的名片',
  titleEn: 'Get my card',
  description: 'The person\'s own contact card ("My Card" in Contacts) with the same fields as contacts.get: their name, phones, emails, addresses, birthday. Fails with a hint if no card is set as My Card on this Mac.',
  risk: 'medium',
  confirm: 'never',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
  run: (_args, ctx) => helper(ctx, 'contacts.me', {}),
}

const contactsCreate: ActionDef = {
  name: 'contacts.create',
  group: 'contacts',
  title: '新建联系人',
  titleEn: 'Create contact',
  description: 'Create a contact. Give at least one of firstName, lastName or organization (company: true makes a company record; organization is then required). emails / phones / urls are lists of {label?, value}; addresses are {label?, street, city, state, zip, country, countryCode}; labels like mobile, home, work, iPhone, homepage, or any custom text. birthday is "YYYY-MM-DD" or "--MM-DD". If a contact with the same full name already exists it returns needs_confirmation listing it — prefer contacts.update on that one; resend with confirmed: true only if the person wants a second contact. Returns the new contact with its id.',
  risk: 'medium',
  confirm: 'on_conflict',
  input_schema: {
    type: 'object',
    properties: {
      ...FIELD_SCHEMA,
      company: { type: 'boolean', description: 'true = a company record instead of a person' },
      [DEVICE_ACTION_CONFIRMED_ARG]: { type: 'boolean', description: 'The person agreed to create it although the same name already exists' },
    },
    additionalProperties: false,
  },
  validate(args) {
    if (!str(args, 'firstName') && !str(args, 'lastName') && !str(args, 'organization')) return 'At least one of firstName, lastName or organization is required'
    if (args.company !== undefined && typeof args.company !== 'boolean') return 'company must be a boolean'
    if (args.company === true && !str(args, 'organization')) return 'organization is required when company is true'
    return checkFields(args)
  },
  run: (args, ctx) =>
    helper(ctx, 'contacts.create', {
      ...pickFields(args, EDIT_FIELDS),
      ...(typeof args.company === 'boolean' ? { company: args.company } : {}),
      confirmed: confirmed(args),
    }),
}

const contactsUpdate: ActionDef = {
  name: 'contacts.update',
  group: 'contacts',
  title: '修改联系人',
  titleEn: 'Update contact',
  description: 'Change a contact by id. Only the fields you pass change; a text field set to "" is cleared. emails / phones / addresses / urls REPLACE that whole list — to add a phone, pass the existing phones (from contacts.get) plus the new one. homePage replaces only the homepage URL. If the change would remove existing data (a cleared field, or entries missing from a list), it returns needs_confirmation naming exactly what would be lost; resend with confirmed: true only after the person agrees. Returns the updated contact.',
  risk: 'medium',
  confirm: 'on_conflict',
  input_schema: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', description: 'Contact id from contacts.list / contacts.get' },
      ...FIELD_SCHEMA,
      [DEVICE_ACTION_CONFIRMED_ARG]: { type: 'boolean', description: 'The person agreed to the data this change removes' },
    },
    additionalProperties: false,
  },
  validate(args) {
    if (!str(args, 'id')) return 'id is required (from contacts.list / contacts.get)'
    if (!EDIT_FIELDS.some((k) => args[k] !== undefined)) return `Nothing to change: pass at least one of ${EDIT_FIELDS.join(', ')}`
    return checkFields(args)
  },
  run: (args, ctx) => helper(ctx, 'contacts.update', { id: str(args, 'id'), ...pickFields(args, EDIT_FIELDS), confirmed: confirmed(args) }),
}

const contactsDelete: ActionDef = {
  name: 'contacts.delete',
  group: 'contacts',
  title: '删除联系人',
  titleEn: 'Delete contact',
  description: 'Permanently delete a contact by id (from contacts.list / contacts.get). It always asks first: without confirmed: true it returns needs_confirmation naming the contact (no change is made); resend with confirmed: true once the person agrees. Cannot be undone. Returns { deleted, id, name }.',
  risk: 'high',
  confirm: 'always',
  confirmsItself: true,
  input_schema: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', description: 'Contact id from contacts.list / contacts.get' },
      [DEVICE_ACTION_CONFIRMED_ARG]: { type: 'boolean', description: 'The person confirmed deleting this contact' },
    },
    additionalProperties: false,
  },
  validate: (args) => (str(args, 'id') ? null : 'id is required (from contacts.list / contacts.get)'),
  run: (args, ctx) => helper(ctx, 'contacts.delete', { id: str(args, 'id'), confirmed: confirmed(args) }),
}

const contactsExport: ActionDef = {
  name: 'contacts.export',
  group: 'contacts',
  title: '导出联系人名片',
  titleEn: 'Export vCard',
  description: 'Export contacts as vCard 3.0 text: one contact by `id`, or every contact whose name matches `name`. Photos are left out. Returns contacts: [{id, name, vcard}] up to 256 KB in total, with `total` matched and `truncated: true` when not all fit.',
  risk: 'medium',
  confirm: 'never',
  input_schema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'Contact id — exports that one contact' }, name: { type: 'string', description: 'Name substring — exports every match' } },
    additionalProperties: false,
  },
  validate: idOrName,
  run: (args, ctx) => helper(ctx, 'contacts.export', str(args, 'id') ? { id: str(args, 'id') } : { name: str(args, 'name') }),
}

export function createContactsFamily(): ActionFamily {
  return {
    groups: [
      {
        id: 'contacts',
        platforms: ['darwin'],
        needs: 'macHelper',
        iconApp: '/System/Applications/Contacts.app',
        settingsUrl: MAC_PRIVACY('Privacy_Contacts'),
        osPermission: '系统设置 → 隐私与安全性 → 通讯录 → 打开咕咕',
        probe: (ctx) => requestHelperPermission(ctx, 'contacts', '通讯录'),
      },
    ],
    actions: [contactsList, contactsGet, contactsMe, contactsCreate, contactsUpdate, contactsDelete, contactsExport],
  }
}
