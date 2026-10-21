import { registerPlugin } from '@capacitor/core'
import type { PhoneActionDefinition } from './phoneActionCatalog'

export type PhoneDataGroup = 'sms' | 'recordings' | 'photos'
export interface PhoneDataStatus {
  supported: boolean
  sms: boolean
  audio: boolean
  images: boolean
  videos: boolean
  selected: boolean
}

interface PhoneDataPlugin {
  status(): Promise<PhoneDataStatus>
  request(args: { group: PhoneDataGroup }): Promise<PhoneDataStatus>
  smsList(args: Record<string, unknown>): Promise<unknown>
  smsGet(args: { id: string }): Promise<unknown>
  mediaList(args: Record<string, unknown>): Promise<unknown>
  mediaRead(args: Record<string, unknown>): Promise<unknown>
}
export const nativePhoneData = registerPlugin<PhoneDataPlugin>('GuguPhoneData')

export const NO_PHONE_DATA: PhoneDataStatus = { supported: false, sms: false, audio: false, images: false, videos: false, selected: false }
export async function readPhoneDataStatus(): Promise<PhoneDataStatus> {
  try { return await nativePhoneData.status() } catch (error) {
    const e = error as { code?: string; message?: string }
    if (e.code === 'UNIMPLEMENTED' || /not implemented|No method \w+ found/i.test(e.message ?? '')) return NO_PHONE_DATA
    throw error
  }
}

export function phoneDataAllowed(group: PhoneDataGroup, state: PhoneDataStatus): boolean {
  return group === 'sms' ? state.sms : group === 'recordings' ? state.audio : state.images || state.videos || state.selected
}

const pageProperties = {
  query: { type: 'string', description: '短信正文关键词或媒体文件名的一部分' },
  after: { type: 'string', description: '起点 ISO 8601,带时区偏移' },
  before: { type: 'string', description: '终点 ISO 8601,不含' },
  before_id: { type: 'string', description: '上一页返回的 next_before_id;不传为第一页' },
  limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
}

export class PhoneDataFailure extends Error {
  constructor(readonly code: 'invalid_args' | 'unsupported', message: string) { super(message) }
}
function invalid(message: string): never { throw new PhoneDataFailure('invalid_args', message) }
function numericId(args: Record<string, unknown>, key = 'id'): string {
  const value = args[key]
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) invalid(`${key} 必须是列表返回的数字编号`)
  return value
}
function pageArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of ['query', 'address'] as const) {
    if (args[key] !== undefined) {
      if (typeof args[key] !== 'string') invalid(`${key} 必须是文字`)
      out[key] = args[key]
    }
  }
  if (args.before_id !== undefined) out.before_id = numericId(args, 'before_id')
  if (args.limit !== undefined) {
    if (!Number.isInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 100) invalid('limit 必须在 1–100')
    out.limit = args.limit
  }
  for (const key of ['after', 'before'] as const) {
    if (args[key] === undefined) continue
    if (typeof args[key] !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(args[key])) invalid(`${key} 必须是带时区的 ISO 时间`)
    const ms = Date.parse(args[key])
    if (!Number.isFinite(ms) || ms < 0) invalid(`${key} 时间无效`)
    out[`${key}_ms`] = ms
  }
  if (typeof out.after_ms === 'number' && typeof out.before_ms === 'number' && out.before_ms <= out.after_ms) invalid('before 必须晚于 after')
  return out
}

function mediaKind(args: Record<string, unknown>): 'image' | 'video' {
  const kind = args.kind ?? 'image'
  if (kind !== 'image' && kind !== 'video') invalid('kind 必须是 image 或 video')
  return kind
}

const fileProperties = {
  id: { type: 'string', description: '列表返回的文件编号' },
  version: { type: 'string', description: '列表返回的 version,防止读到变化后的文件' },
}
function readArgs(args: Record<string, unknown>, kind: string): Record<string, unknown> {
  if (args._phone_file_transport !== 1) throw new PhoneDataFailure('unsupported', '请更新 agent 所在电脑或云电脑上的咕咕:这个版本还不能接收手机媒体文件')
  const out: Record<string, unknown> = { id: numericId(args), kind }
  if (args.version !== undefined) {
    if (typeof args.version !== 'string') invalid('version 必须是列表返回的文字')
    out.version = args.version
  }
  // 宿主内部续传;字节不会作为文字交给模型。
  if (args.offset !== undefined) {
    if (!Number.isSafeInteger(args.offset) || Number(args.offset) < 0) invalid('offset 无效')
    out.offset = args.offset
  }
  return out
}

type Definition = Omit<PhoneActionDefinition, 'risk' | 'confirm'>
const readOnly = (definition: Definition): PhoneActionDefinition => ({ ...definition, risk: 'low', confirm: 'never' })

export const PHONE_DATA_ACTIONS: readonly PhoneActionDefinition[] = [
  readOnly({
    name: 'sms.list', group: 'sms', title: '查手机短信', requires: 'sms',
    description: () => '查询这台手机系统短信库(只读,不含 MMS / RCS / 微信)。按正文 query、号码 address、时间 after / before 筛选;按入库编号倒序分页,回 messages 与 next_before_id。含完整正文 body、号码 address、时间 date_ms、type(1收件/2已发送/3草稿/其他为系统类型)、read、thread_id。不会标记已读。系统或安装来源拒绝短信权限时不能读。',
    input_schema: { type: 'object', properties: { ...pageProperties, address: { type: 'string', description: '号码的一部分' } } },
    run: (args) => nativePhoneData.smsList(pageArgs(args)),
  }),
  readOnly({
    name: 'sms.get', group: 'sms', title: '读一条手机短信', requires: 'sms',
    description: () => '按 sms.list 返回的 id 读取完整短信;只读,不标记已读。',
    input_schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    run: (args) => nativePhoneData.smsGet({ id: numericId(args) }),
  }),
  readOnly({
    name: 'recordings.list', group: 'recordings', title: '查手机里的录音与共享音频', requires: 'recordings',
    description: () => '查询这台手机共享音频库(含系统录音机公开保存的录音,也可能含音乐)。query 按文件名筛,after / before 按入库时间筛。回 items:id、name、folder(系统支持时)、mime_type、size、duration_ms、added_at_ms、version;next_before_id 继续翻页。其他 App 的私有录音不在此范围。',
    input_schema: { type: 'object', properties: pageProperties },
    run: (args) => nativePhoneData.mediaList({ ...pageArgs(args), kind: 'audio' }),
  }),
  readOnly({
    name: 'recordings.read', group: 'recordings', title: '读手机里的录音文件', requires: 'recordings',
    description: () => '读取 recordings.list 的原始音频,自动分块传到你所在的电脑,返回 file_path、mime_type、size、sha256;用该本机文件转写或分析。无需用户再次分享,不会开启麦克风。建议传列表的 version。手机断开 / 撤权 / 文件变化时整次失败,不返回残缺文件。大文件可给 device_call timeout_ms:300000。',
    input_schema: { type: 'object', required: ['id'], properties: fileProperties },
    run: (args) => nativePhoneData.mediaRead(readArgs(args, 'audio')),
  }),
  readOnly({
    name: 'photos.list', group: 'photos', title: '查手机相册', requires: 'photos',
    description: () => '查询系统授权范围内的共享照片或视频(kind:image / video,默认 image)。可以授权全部或只授权部分;结果的 access 说明系统实际给了什么。query 按文件名、after / before 按入库时间筛。回 items:id、name、size、mime_type、width、height、added_at_ms、version,视频另带 duration_ms;next_before_id 继续翻页。',
    input_schema: { type: 'object', properties: { ...pageProperties, kind: { type: 'string', enum: ['image', 'video'], default: 'image' } } },
    run: (args) => nativePhoneData.mediaList({ ...pageArgs(args), kind: mediaKind(args) }),
  }),
  readOnly({
    name: 'photos.read', group: 'photos', title: '读相册里的照片或视频', requires: 'photos',
    description: () => '读取 photos.list 的原文件,自动传到你所在的电脑,返回 file_path、mime_type、size、sha256,并尽可能附图片 / 视频缩略图供你看。kind 要与列表一致。建议传 version。授权范围之外的文件会被系统拒绝。大文件可给 device_call timeout_ms:300000。',
    input_schema: { type: 'object', required: ['id'], properties: { ...fileProperties, kind: { type: 'string', enum: ['image', 'video'], default: 'image' } } },
    run: (args) => nativePhoneData.mediaRead(readArgs(args, mediaKind(args))),
  }),
]
