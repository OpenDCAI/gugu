export const VOICE_ATTACHMENT_LINE_PREFIX = '[语音] durationMs='
export const VOICE_TRANSCRIPT_LINE_PREFIX = '[转写] '

export interface VoiceAttachmentMeta {
  fileName: string
  mimeType: string | null
  durationMs: number
  transcript: string
}

export function formatVoiceAttachmentMetadata(durationMs: number, transcript: string): string {
  const normalizedDurationMs = Math.max(1, Math.round(durationMs))
  const normalizedTranscript = transcript.trim()
  if (!normalizedTranscript) {
    throw new Error('transcript is required')
  }
  return `${VOICE_ATTACHMENT_LINE_PREFIX}${normalizedDurationMs}\n${VOICE_TRANSCRIPT_LINE_PREFIX}${normalizedTranscript}`
}

export function parseVoiceAttachmentContent(content: string | null): VoiceAttachmentMeta | null {
  if (!content) return null

  const lines = content.split('\n')
  if (lines.length !== 3) {
    return null
  }

  const [headerLine, voiceLine, transcriptLine] = lines
  if (
    !headerLine.startsWith('[附件] ') ||
    !voiceLine.startsWith(VOICE_ATTACHMENT_LINE_PREFIX) ||
    !transcriptLine.startsWith(VOICE_TRANSCRIPT_LINE_PREFIX)
  ) {
    return null
  }

  const durationMs = Number(voiceLine.slice(VOICE_ATTACHMENT_LINE_PREFIX.length))
  if (!Number.isInteger(durationMs) || durationMs <= 0) {
    return null
  }

  const rawFileDescriptor = headerLine.slice('[附件] '.length).trim()
  if (!rawFileDescriptor) {
    return null
  }

  const headerMatch = rawFileDescriptor.match(/^(.*?)(?: \(([^()]+)\))?$/)
  if (!headerMatch) {
    return null
  }

  const fileName = headerMatch[1]?.trim() ?? ''
  const mimeType = headerMatch[2]?.trim() ?? null
  if (!fileName || !mimeType?.startsWith('audio/')) {
    return null
  }

  const transcript = transcriptLine.slice(VOICE_TRANSCRIPT_LINE_PREFIX.length).trim()
  if (!transcript) {
    return null
  }

  return {
    fileName,
    mimeType,
    durationMs,
    transcript,
  }
}

export function formatVoiceDuration(durationMs: number): string {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}
