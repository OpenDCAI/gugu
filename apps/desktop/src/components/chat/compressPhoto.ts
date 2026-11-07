/**
 * 手机「照片」「拍摄」进附件区默认是压缩图(附件上可切回原图)。和 IM 的常见做法一样:
 * 长边缩到 2048,重新编码成 JPEG(质量 0.85)。本来就小的图、动图、矢量图原样发;压完反而更大也发原件。
 */
const MAX_EDGE = 2048
const QUALITY = 0.85
const SMALL_ENOUGH = 512 * 1024

export async function compressPhoto(file: File): Promise<File> {
  if (file.type === 'image/gif' || file.type === 'image/svg+xml') return file
  // 解不出来的格式(本机解码器不认)没法压,那就是原件;它照样能发出去,这里不算失败。
  const bitmap = await createImageBitmap(file).catch(() => null)
  if (!bitmap) return file
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
    if (scale === 1 && file.size <= SMALL_ENOUGH) return file
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY))
    if (!blob || blob.size >= file.size) return file
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg', lastModified: file.lastModified })
  } finally {
    bitmap.close()
  }
}
