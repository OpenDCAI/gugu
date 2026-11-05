import { NativeCallError } from './native/mac-helper-client'

interface CaptureImage {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  resize(size: { width: number; height: number; quality: 'good' }): CaptureImage
  toJPEG(quality: number): Buffer
}

interface ScreenCaptureDeps {
  platform: NodeJS.Platform
  primaryDisplay(): { id: number; size: { width: number; height: number } }
  displayCount(): number
  screenAccess(): string
  sources(options: { types: ['screen']; thumbnailSize: { width: number; height: number } }): Promise<Array<{
    display_id: string
    thumbnail: CaptureImage
  }>>
}

const permissionError = () => new NativeCallError('os_permission',
  'macOS has not allowed 咕咕 to capture the screen. Allow Screen Recording in System Settings → Privacy & Security, then restart 咕咕 if macOS requires it.')

/** Electron owns generic screen capture on every desktop platform, independently of Computer Use. */
export function createScreenCapture(deps: ScreenCaptureDeps) {
  return async ({ maxEdge }: { maxEdge: number }) => {
    if (!Number.isSafeInteger(maxEdge) || maxEdge < 1) throw new NativeCallError('invalid_args', 'maxEdge must be a positive integer')
    const checkAccess = () => {
      if (deps.platform === 'darwin' && deps.screenAccess() !== 'granted') throw permissionError()
    }
    checkAccess()
    const primary = deps.primaryDisplay()
    const scale = Math.min(1, maxEdge / Math.max(primary.size.width, primary.size.height))
    const sources = await deps.sources({ types: ['screen'], thumbnailSize: {
      width: Math.max(1, Math.round(primary.size.width * scale)),
      height: Math.max(1, Math.round(primary.size.height * scale)),
    } })
    checkAccess()
    // PipeWire can return one system-selected source without a display id. Never
    // guess among several sources or substitute a different identified monitor.
    const source = sources.find(item => item.display_id === String(primary.id))
      ?? (sources.length === 1 && sources[0]!.display_id === '' ? sources[0] : undefined)
    if (!source || source.thumbnail.isEmpty()) throw new NativeCallError('execution_failed', 'Electron returned no image for the requested screen')
    const size = source.thumbnail.getSize()
    if (size.width < 1 || size.height < 1) throw new NativeCallError('execution_failed', 'Electron returned an empty screen image')
    const shrink = Math.min(1, maxEdge / Math.max(size.width, size.height))
    const image = shrink < 1 ? source.thumbnail.resize({
      width: Math.max(1, Math.round(size.width * shrink)),
      height: Math.max(1, Math.round(size.height * shrink)),
      quality: 'good',
    }) : source.thumbnail
    const actual = image.getSize()
    return { mimeType: 'image/jpeg', data: image.toJPEG(72).toString('base64'),
      width: actual.width, height: actual.height, displays: deps.displayCount() }
  }
}
