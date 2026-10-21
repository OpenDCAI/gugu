export declare const PLATFORM_FILES: Record<string, string[]>
export declare function preflight(options: {
  directory?: string
  version: string
  statePath?: string
}): Promise<{ state: 'preflight_passed'; version: string; manifest: Record<string, Record<string, { size: number; sha256: string }>>; recordedAt: string }>
export declare function markPublished(options: {
  version: string
  statePath?: string
}): Promise<Record<string, unknown> & { state: 'published'; version: string }>
export declare function verify(options: {
  version: string
  tag?: string
  baseUrl?: string
  token?: string
  repository?: string
  statePath?: string
}): Promise<{ state: 'verified'; version: string; tag: string; ossObjects: number; releaseAssets: number; verifiedAt: string }>
