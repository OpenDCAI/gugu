// 所有「保存」都走这里:先取 blob,再交给宿主的 saveFile(桌面 / 网页是 a[download],安卓是系统的「保存到…」)。
import { platform } from '../platform'

export async function fetchBlob(url: string): Promise<Blob> {
  // 不带 credentials:storage 响应 Access-Control-Allow-Origin: * 与 include 模式按规范互斥
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`fetch ${resp.status}`)
  return resp.blob()
}

export function downloadBlob(blob: Blob, filename: string): Promise<{ saved: boolean }> {
  return platform.saveFile(blob, filename)
}

export async function downloadRemoteFile(url: string, filename: string): Promise<{ saved: boolean }> {
  return downloadBlob(await fetchBlob(url), filename)
}
