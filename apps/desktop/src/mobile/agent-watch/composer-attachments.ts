import type { AttachmentAdapter, CompleteAttachment, PendingAttachment } from '@assistant-ui/react'
import { stringifyMention } from '@gugu/session-shared/markdown'
import {
  AttachmentUploadCancelled,
  AttachmentUploadFailure,
  uploadComposerAttachment,
  type AttachmentUploadRpc,
  type CommittedAttachment,
  type UploadFailureReason,
} from '@renderer/features/sessions/acp/composer-file-upload'

/**
 * 手机会话页输入框的附件:assistant-ui 的 `AttachmentAdapter`,传输是桌面输入框同一个 `uploadComposerAttachment`
 * (字节先送到会话所在的机器)。状态归 assistant-ui 的输入框管:`add` 边传边报进度,`send` 等传完、传失败就抛
 * (消息不发),`remove` 取消。发出去的是那台机器上的路径,写成 mention 放进附件内容,与桌面同一种表示。
 */
export function sessionAttachmentAdapter(deps: {
  rpc: AttachmentUploadRpc
  sessionId: string
  describe: (reason: UploadFailureReason) => string
}): AttachmentAdapter {
  const uploads = new Map<string, { controller: AbortController; committed: Promise<CommittedAttachment> }>()
  /*
   * 一次只传一件:一起选的几张排队,前一件落定(传完、失败、取消)再传下一件。❌ 并行:几件的块挤在同一条
   * 连接里,每一块的往返都排在别的几件的块后面,随件数线性变长,手机上行稍慢就越过单块 12s 的超时 ——
   * mac1 实测 10 张一起选、1Mbps 上行,10 张全部「没传到那台机器」;排队传,每块只等它自己。总时长不变(按带宽算)。
   */
  let queue: Promise<unknown> = Promise.resolve()
  return {
    accept: '*',
    async *add({ file }): AsyncGenerator<PendingAttachment, void> {
      const id = crypto.randomUUID()
      const base = {
        id,
        type: file.type.startsWith('image/') ? 'image' : 'file',
        name: file.name || 'attachment',
        contentType: file.type || undefined,
        file,
      } satisfies Omit<PendingAttachment, 'status'>
      const controller = new AbortController()
      let progress = 0
      let settled = false
      let wake = () => {}
      // 排着的那几件显示 0%;× 掉还没轮到的那件,轮到时开头就按取消收场,不往那台机器发一块字节。
      const committed = queue.then(() => uploadComposerAttachment({
        rpc: deps.rpc,
        sessionId: deps.sessionId,
        uploadId: id,
        source: {
          kind: 'file',
          name: base.name,
          ...(file.type ? { mimeType: file.type } : {}),
          size: file.size,
          slice: async (start, end) => new Uint8Array(await file.slice(start, end).arrayBuffer()),
        },
        signal: controller.signal,
        onProgress: (sent, total) => {
          progress = total > 0 ? sent / total : 1
          wake()
        },
      }))
      queue = committed.catch(() => undefined)
      uploads.set(id, { controller, committed })
      void committed.then(
        () => undefined,
        () => undefined,
      ).then(() => {
        settled = true
        wake()
      })
      // 每报一次进度吐一份;两次之间来的几次进度只取最新那个。
      while (!settled) {
        yield { ...base, status: { type: 'running', reason: 'uploading', progress } }
        if (!settled) await new Promise<void>((resolve) => { wake = resolve })
      }
      try {
        await committed
      } catch (error) {
        if (error instanceof AttachmentUploadCancelled) return
        const reason = error instanceof AttachmentUploadFailure ? error.reason : 'failed'
        yield { ...base, status: { type: 'incomplete', reason: 'error', message: deps.describe(reason) } }
        return
      }
      yield { ...base, status: { type: 'requires-action', reason: 'composer-send' } }
    },
    async send(attachment): Promise<CompleteAttachment> {
      const upload = uploads.get(attachment.id)
      if (!upload) throw new AttachmentUploadFailure('failed', `${attachment.name} was never uploaded`)
      // 还在传就等它传完;传失败就抛,这条消息不发(附件上已经写着原因)。
      const committed = await upload.committed
      uploads.delete(attachment.id)
      const target = committed.mentionPath.trim().replace(/\\/g, '/')
      return {
        ...attachment,
        status: { type: 'complete' },
        content: [{ type: 'text', text: stringifyMention({ label: attachment.name, target, kind: 'file' }) }],
      }
    },
    async remove(attachment) {
      uploads.get(attachment.id)?.controller.abort()
      uploads.delete(attachment.id)
    },
  }
}

/** 发出去的那几件附件在那台机器上的路径 mention(`send` 写进附件内容的那一条)。 */
export function attachmentMentions(attachments: readonly CompleteAttachment[] | undefined): string[] {
  return (attachments ?? []).flatMap((attachment) =>
    attachment.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])),
  )
}
