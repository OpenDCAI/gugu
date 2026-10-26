import { registerPlugin, type PermissionState } from '@capacitor/core'

/** Permission only: neither checking nor requesting starts an audio capture session. */
export const nativeAudioPermissions = registerPlugin<{
  checkPermissions(): Promise<{ microphone: PermissionState }>
  requestPermissions(options: { permissions: ['microphone'] }): Promise<{ microphone: PermissionState }>
}>('GuguAudioPermissions')
