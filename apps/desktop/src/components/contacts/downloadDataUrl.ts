/** 把 data: URL 存成文件。二维码分享用它落盘一张 PNG。 */
export function downloadDataUrl(dataUrl: string, fileName: string): void {
  const link = document.createElement('a')
  link.href = dataUrl
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
}
