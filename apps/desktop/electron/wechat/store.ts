// 桌面第一版(#7236 前半段)把微信连接存在本机:一个咕咕账号一份,整份用系统钥匙串(safeStorage)加密。
// 现在收发都在管家上(gugu-supabase services/cloud-computer/src/channels),这里只剩「读出来交给管家、交完删掉」。
import fs from 'node:fs'
import path from 'node:path'

/** 本机旧连接的形状(只读);credentials + cursor 原样交给管家的 import。 */
export interface LegacyWechatRecord {
  version: 1
  credentials: { botToken: string; botId: string; baseUrl: string; userId: string }
  agentId: string | null
  connectedAt: number
  cursor: { updatesBuf?: string; contextToken?: string | null }
}

export interface SecretCodec {
  decrypt: (data: Buffer) => string
}

export class LegacyWechatStore {
  constructor(
    private readonly dir: string,
    private readonly codec: SecretCodec
  ) {}

  private file(guguUserId: string): string {
    if (!/^[0-9a-zA-Z-]+$/.test(guguUserId)) throw new Error(`wechat store: bad user id ${JSON.stringify(guguUserId)}`)
    return path.join(this.dir, `${guguUserId}.enc`)
  }

  read(guguUserId: string): LegacyWechatRecord | null {
    const file = this.file(guguUserId)
    if (!fs.existsSync(file)) return null
    const parsed = JSON.parse(this.codec.decrypt(fs.readFileSync(file))) as Partial<LegacyWechatRecord>
    const credentials = parsed.credentials
    if (parsed.version !== 1 || !credentials?.botToken || !credentials.botId || !credentials.baseUrl || !credentials.userId) {
      throw new Error(`微信连接文件格式不对: ${file}`)
    }
    return {
      version: 1,
      credentials,
      agentId: typeof parsed.agentId === 'string' ? parsed.agentId : null,
      connectedAt: typeof parsed.connectedAt === 'number' ? parsed.connectedAt : 0,
      cursor: parsed.cursor ?? {},
    }
  }

  remove(guguUserId: string): void {
    fs.rmSync(this.file(guguUserId), { force: true })
  }
}
