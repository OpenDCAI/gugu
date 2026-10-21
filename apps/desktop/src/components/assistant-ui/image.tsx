import type { ImageMessagePartComponent } from '@assistant-ui/react'

/**
 * 图片片段的占位实现（与 attachment.aui 同一个理由）。
 * 官方那份带灯箱、缩放、加载失败重试，等附件链路接通再整份换回来。
 */
export const Image: ImageMessagePartComponent = () => null
