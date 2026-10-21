export type PlatformErrorCode =
  | 'PLATFORM_CAPABILITY_UNAVAILABLE'
  | 'BARCODE_SCAN_CAMERA_PERMISSION_DENIED'
  | 'BARCODE_SCAN_FAILED'

export class PlatformError extends Error {
  readonly code: PlatformErrorCode
  readonly details?: Readonly<Record<string, string>>

  constructor(
    code: PlatformErrorCode,
    options: { cause?: unknown; details?: Readonly<Record<string, string>> } = {},
  ) {
    const details = options.details
    const suffix = details
      ? ` (${Object.entries(details).map(([key, value]) => `${key}=${value}`).join(', ')})`
      : ''
    super(`${code}${suffix}`, { cause: options.cause })
    this.name = 'PlatformError'
    this.code = code
    this.details = details
  }
}

export function unavailableCapability(capability: string, platform: string): PlatformError {
  return new PlatformError('PLATFORM_CAPABILITY_UNAVAILABLE', {
    details: { capability, platform },
  })
}
