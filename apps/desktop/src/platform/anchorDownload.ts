// @@@remote-download (#1892) - 跨域 URL 上 <a download> 会被 Chromium 忽略并整窗导航到裸文件,应用被顶掉且无法返回。
// 所以先取 blob,经同源 object URL 触发真下载。桌面与网页的 saveFile 都是这一份。
export async function anchorDownload(blob: Blob, filename: string): Promise<{ saved: boolean }> {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 延迟 revoke:非 Chromium 引擎(web 构建)可能在 click 后异步解引用 blob URL
  setTimeout(() => URL.revokeObjectURL(url), 200)
  return { saved: true }
}
