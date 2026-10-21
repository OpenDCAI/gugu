import type { FileMessagePartComponent } from '@assistant-ui/react'

/**
 * 文件片段的占位实现（与 attachment.aui 同一个理由：附件链路后端还没接）。
 * 咕咕的时间线目前不会产出 file 片段，所以渲染成空；接通后整份换成官方的 file.tsx 即可，
 * thread 那边一行都不用动。
 */
export const File: FileMessagePartComponent = () => null
