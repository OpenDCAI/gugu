import { useEffect, useRef } from 'react'
import { useOpenedOutputOpener } from './opened-output-opener'

/** An App's working-copy click uses the same preview as the timeline, loaded only when a file is opened. */
export function OpenedFilePreview({ path, ...options }: Parameters<typeof useOpenedOutputOpener>[0] & { path: string }) {
  const { openFile, panel } = useOpenedOutputOpener(options)
  const open = useRef(openFile)
  open.current = openFile
  useEffect(() => { open.current(path) }, [path, options.readFileChunk])
  return panel
}
