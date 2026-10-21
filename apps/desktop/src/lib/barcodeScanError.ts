import type { TFunction } from 'i18next'
import { PlatformError } from '../platform/errors'

// Platform adapters return stable codes and raw diagnostics; renderer copy is chosen here.
export function describeBarcodeScanError(error: unknown, t: TFunction<'main'>): string {
  if (error instanceof PlatformError) {
    if (error.code === 'BARCODE_SCAN_CAMERA_PERMISSION_DENIED') {
      return t('shell.toast.scanCameraPermissionDenied')
    }
    if (error.code === 'BARCODE_SCAN_FAILED') {
      if (error.cause instanceof Error) return error.cause.message
      if (error.cause != null) return String(error.cause)
      return t('shell.toast.scanUnknownFailure')
    }
  }
  return error instanceof Error ? error.message : String(error)
}
