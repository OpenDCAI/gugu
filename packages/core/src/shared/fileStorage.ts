/**
 * 「文件存储与读取」(owner 10-27):一个人一份,不按群设。存在账号设置(identity.user_settings,scope 'user')的
 * file_storage 一格;发文件的人用自己这一份(项目群没有 host),后端在用到时现读(chat.file_storage_of)。
 * 取值与后端的 CHECK 是同一张表,缺省值也一样:没设过 = 默认。读写库在 app 侧(apps/desktop/src/lib/fileStorage.ts)。
 */

export const FILE_RETENTIONS = ['read-once', '1d', '7d', '30d'] as const
export const IMAGE_RETENTIONS = ['1d', '7d', '30d'] as const

export type FileStorage = {
  /** 项目群里的文件也上传到云端,永久保存(默认关:文件留在机器上)。 */
  proactive_upload: boolean
  /** 有人打开留在机器上的文件时,经云端临时中转。 */
  temporary_transfer: boolean
  /** 那份临时副本留多久。 */
  retention: (typeof FILE_RETENTIONS)[number]
  /** 项目群里的图片发送时上传,留多久。 */
  image_retention: (typeof IMAGE_RETENTIONS)[number]
  /**
   * 标成「临时」的文件留多久(owner 10-28:数据层与图片分开存,设置上共用一个控件)。用上传者自己的这一格。
   */
  temporary_retention: (typeof IMAGE_RETENTIONS)[number]
}

/** 上传时(agent 或人)给这份文件定的分类:临时(到期删云端副本)或一直保留。不给 = 照这个群的规矩。 */
export const FILE_KEEPS = ['temporary', 'permanent'] as const
export type FileKeep = (typeof FILE_KEEPS)[number]

export const DEFAULT_FILE_STORAGE: FileStorage = { proactive_upload: false, temporary_transfer: true, retention: '7d', image_retention: '7d', temporary_retention: '7d' }

/**
 * 账号设置里那一格 → 生效值。认识的键写坏了 throw(❌ 当默认值悄悄用):后端的 CHECK 本来就写不进去。
 * 不认识的键是更新的客户端写的(如 temporary_retention):这里不管它,❌ 把整格判成坏的 —— 写回时由 writeFileStorage 原样留着。
 */
export function parseFileStorage(config: Record<string, unknown>): FileStorage {
  const value = config.file_storage
  if (value === undefined) return DEFAULT_FILE_STORAGE
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('user_settings.file_storage is malformed')
  const stored = value as Record<string, unknown>
  const next: Record<string, unknown> = { ...DEFAULT_FILE_STORAGE }
  for (const key of Object.keys(DEFAULT_FILE_STORAGE)) if (stored[key] !== undefined) next[key] = stored[key]
  if (typeof next.proactive_upload !== 'boolean' || typeof next.temporary_transfer !== 'boolean'
    || !FILE_RETENTIONS.includes(next.retention as FileStorage['retention'])
    || !IMAGE_RETENTIONS.includes(next.image_retention as FileStorage['image_retention'])
    || !IMAGE_RETENTIONS.includes(next.temporary_retention as FileStorage['temporary_retention'])) {
    throw new Error('user_settings.file_storage is malformed')
  }
  return next as FileStorage
}
