// @@@blob-first-clipboard (#1892/#1900) - 图片写剪贴板的唯一通道。硬约束:ClipboardItem 的值
// 必须是**已 resolve 的 Blob**——Promise 值的 ClipboardItem 要 Chrome 122+,Electron 28 =
// Chromium 120 会构造即抛。三个调用点(图片预览复制/海报复制/群二维码复制)统一走这里,
// 防止任何一处被「优化」回 Promise 形态复发 #1892。

export function canWriteImageToClipboard(): boolean {
  return (
    typeof window !== 'undefined' &&
    !!window.isSecureContext &&
    typeof navigator.clipboard?.write === 'function' &&
    typeof ClipboardItem !== 'undefined'
  )
}

// blob 必须已 resolve(见文件头)且为 PNG——Chromium 剪贴板图片只收 image/png,其它类型会被
// write() 拒绝,症状是「复制悄悄没生效」;在唯一通道上 fail loud,把先转码的要求抛回调用方
// (转码参考 ImagePreviewProvider.fetchImageAsPngBlob)。失败向上抛,toast/降级由调用方决定。
export async function writeImageBlobToClipboard(blob: Blob): Promise<void> {
  if (blob.type && blob.type !== 'image/png') {
    throw new Error(`[imageClipboard] clipboard images require image/png; received ${blob.type}; convert to PNG first`)
  }
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
}
