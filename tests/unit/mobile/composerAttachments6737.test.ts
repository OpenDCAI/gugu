import { describe, expect, it, vi } from 'vitest'
import type { AttachmentUploadRpc } from '@renderer/features/sessions/acp/composer-file-upload'

const { attachmentMentions, sessionAttachmentAdapter } = await import('@/mobile/agent-watch/composer-attachments')

// 类型从适配器自己取:仓根的测试解析不到 @assistant-ui/react(它是 apps/desktop 的依赖)。
type AttachmentAdapter = ReturnType<typeof sessionAttachmentAdapter>
type PendingAttachment = Parameters<AttachmentAdapter['send']>[0]

/**
 * #6737 手机会话页输入框的附件:assistant-ui 适配器 + 设备 RPC 那一层。
 * 传输本身(分块、上限、取消即清)是桌面同一个 `uploadComposerAttachment`,它的判据在 composer-file-upload.test.ts;
 * 这里钉手机这一层自己的事:进度吐到哪一格、发出去的是不是那台机器上的路径、几件排队传。
 */

async function drain(adapter: AttachmentAdapter, file: File): Promise<PendingAttachment[]> {
  const out: PendingAttachment[] = []
  // 这个适配器的 add 是异步生成器(边传边报进度)。
  for await (const attachment of adapter.add({ file }) as AsyncGenerator<PendingAttachment, void>) out.push(attachment)
  return out
}

describe('手机任务页输入框附件(#6737)', () => {
  it('边传边报进度、传完等发送;send 交回那台机器上的路径,拼进正文的是 mention', async () => {
    const rpc: AttachmentUploadRpc = {
      writeAttachmentChunk: vi.fn(async (chunk) => ({ success: true as const, data: { received: chunk.offset + chunk.data.byteLength } })),
      commitAttachmentUpload: vi.fn(async () => ({
        success: true as const,
        data: { id: 'a', storedPath: 'C:\\m\\a b.txt', mentionPath: 'C:\\m\\a b.txt', name: 'a b.txt', size: 5 },
      })),
      discardAttachmentUpload: vi.fn(async () => ({ success: true as const, data: undefined })),
    }
    const adapter = sessionAttachmentAdapter({ rpc, sessionId: 'c1', describe: (reason) => reason })

    const statuses = await drain(adapter, new File(['hello'], 'a b.txt', { type: 'text/plain' }))
    expect(statuses[0]).toMatchObject({ type: 'file', name: 'a b.txt', status: { type: 'running', progress: 0 } })
    expect(statuses.at(-1)!.status).toEqual({ type: 'requires-action', reason: 'composer-send' })
    expect(rpc.commitAttachmentUpload).toHaveBeenCalledWith(expect.objectContaining({ name: 'a b.txt', mimeType: 'text/plain' }))

    const complete = await adapter.send(statuses.at(-1)!)
    // 反斜杠换成正斜杠、带空格的路径包尖括号:与桌面输入框拼出来的同一种 mention。
    expect(attachmentMentions([complete])).toEqual(['@[a b.txt](<C:/m/a b.txt>)'])
  })

  /**
   * 一起选的几件排队传。并行时几件的块挤在同一条连接里,每块的往返随件数变长,手机上行慢一点就越过单块 12s 超时
   * (mac1 实测 10 张 × 1Mbps 全挂)。判据:第二件的第一块在第一件**提交之后**才发;并行的实现两件的块会先后挤在前面。
   */
  it('一起选的几件排队传:前一件提交了,下一件才发第一块', async () => {
    const calls: string[] = []
    const rpc: AttachmentUploadRpc = {
      writeAttachmentChunk: vi.fn(async (chunk) => {
        calls.push(`chunk:${chunk.segments[0]}`)
        await new Promise((resolve) => setTimeout(resolve, 5))
        return { success: true as const, data: { received: chunk.offset + chunk.data.byteLength } }
      }),
      commitAttachmentUpload: vi.fn(async (commit) => {
        calls.push(`commit:${commit.name}`)
        return { success: true as const, data: { id: commit.name, storedPath: `/m/${commit.name}`, mentionPath: `/m/${commit.name}`, name: commit.name, size: 1 } }
      }),
      discardAttachmentUpload: vi.fn(async () => ({ success: true as const, data: undefined })),
    }
    const adapter = sessionAttachmentAdapter({ rpc, sessionId: 'c1', describe: (reason) => reason })

    const files = ['IMG_1.jpg', 'IMG_2.jpg', 'IMG_3.jpg'].map((name) => new File(['x'], name, { type: 'image/jpeg' }))
    const results = await Promise.all(files.map((file) => drain(adapter, file)))

    expect(calls).toEqual(['chunk:IMG_1.jpg', 'commit:IMG_1.jpg', 'chunk:IMG_2.jpg', 'commit:IMG_2.jpg', 'chunk:IMG_3.jpg', 'commit:IMG_3.jpg'])
    // 排着的那几件也照常走到「等发送」。
    expect(results.map((statuses) => statuses.at(-1)!.status)).toEqual(files.map(() => ({ type: 'requires-action', reason: 'composer-send' })))
  })

  it('还排着的那件被 × 掉:轮到它时一块都不发,后面那件照传', async () => {
    const written: string[] = []
    let releaseFirst = () => {}
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const rpc: AttachmentUploadRpc = {
      writeAttachmentChunk: vi.fn(async (chunk) => {
        written.push(chunk.segments[0]!)
        if (chunk.segments[0] === 'IMG_1.jpg') await firstGate
        return { success: true as const, data: { received: chunk.offset + chunk.data.byteLength } }
      }),
      commitAttachmentUpload: vi.fn(async (commit) => ({
        success: true as const,
        data: { id: commit.name, storedPath: `/m/${commit.name}`, mentionPath: `/m/${commit.name}`, name: commit.name, size: 1 },
      })),
      discardAttachmentUpload: vi.fn(async () => ({ success: true as const, data: undefined })),
    }
    const adapter = sessionAttachmentAdapter({ rpc, sessionId: 'c1', describe: (reason) => reason })

    const first = drain(adapter, new File(['x'], 'IMG_1.jpg', { type: 'image/jpeg' }))
    const second = adapter.add({ file: new File(['x'], 'IMG_2.jpg', { type: 'image/jpeg' }) }) as AsyncGenerator<PendingAttachment, void>
    const queued = (await second.next()).value as PendingAttachment
    const third = drain(adapter, new File(['x'], 'IMG_3.jpg', { type: 'image/jpeg' }))
    await adapter.remove(queued)
    releaseFirst()
    const rest: PendingAttachment[] = []
    for await (const status of second) rest.push(status)
    await Promise.all([first, third])

    expect(written).toEqual(['IMG_1.jpg', 'IMG_3.jpg'])
    // 取消的那件不报失败:生成器安静收场,输入框上不留一枚红 chip。
    expect(rest.every((status) => status.status.type === 'running')).toBe(true)
  })
})
