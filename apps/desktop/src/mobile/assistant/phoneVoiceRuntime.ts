import { messageForUser } from '@/lib/userFacingError';
// #7199 手机助理 App 的「录制语音笔记」:把录音机(phoneVoiceRecorder)与进度(phoneVoiceJobs)接上真东西 ——
// 麦克风(WebAudio)、手机壳通往它家里那台的工作区(PhoneMachineState)、手机上的存储。手机只录和传,转写在桌面点「开始转写」。
// 一个 App 进程里一份:离开助理那一格 / 切到别的页也接着录、接着传,回来录音条还在。
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { AndroidSettings, IOSSettings, NativeSettings } from 'capacitor-native-settings'
import { useToast } from '@/components/toastContext'
import { rendererLogger } from '@/lib/log'
import { createIndexedDbBacklog } from './phoneVoiceBacklog'
import { createPhoneVoiceJobs, type VoiceJobHeld, type VoiceJobView, type VoiceNotesContext } from './phoneVoiceJobs'
import { PhoneVoiceRecorder, webAudioBackend, type RecorderSnapshot } from './phoneVoiceRecorder'
import type { PhoneMachineState } from './phoneMachine'
import '@/i18n/registerVoiceNotesCatalog'

const log = rendererLogger('mobile/assistant')
const warn = (fields: Record<string, unknown>, message: string) => log.warn(fields, message)

let context: VoiceNotesContext | null = null

export const phoneVoiceRecorder = new PhoneVoiceRecorder(webAudioBackend)

export const phoneVoiceJobs = createPhoneVoiceJobs({
  context: () => context,
  recorder: phoneVoiceRecorder,
  backlog: createIndexedDbBacklog(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => new Date(),
  random: () => Math.random().toString(36).slice(2, 6),
  warn,
})

export function useRecorder(): RecorderSnapshot {
  return useSyncExternalStore(phoneVoiceRecorder.subscribe, phoneVoiceRecorder.getSnapshot)
}

export function useVoiceJobs(): readonly VoiceJobView[] {
  return useSyncExternalStore(phoneVoiceJobs.subscribe, phoneVoiceJobs.getSnapshot)
}

/** 去系统设置里咕咕那一页开麦克风(拒过之后系统不再弹框,只剩这条路)。web 目标没有这个插件:什么也不做。 */
export async function openMicrophoneSettings(): Promise<void> {
  try {
    await NativeSettings.open({ optionAndroid: AndroidSettings.ApplicationDetails, optionIOS: IOSSettings.App })
  } catch (error) {
    warn({ error: error instanceof Error ? error.message : String(error) }, 'open app settings failed')
  }
}

export type PhoneVoice = {
  /** 「+」里的「录制语音笔记」。 */
  start: () => void
  /** 「+」里这一项置灰:正在录(含正在开始、暂停、正在收尾),或还没有它家里那台可挂的机器。 */
  disabled: boolean
  /** 系统没给麦克风:录音条上说怎么开,直到人关掉或下次成功开录。 */
  micDenied: boolean
  clearMicDenied: () => void
}

/**
 * 助理 App 挂上时:告诉进度此刻是哪位助理、它家里那台(现读,❌ 用最后一次渲染的快照);
 * 把手机上没传完的接着传。App 卸下时只清掉上下文,录音与进度留着(回来接上)。
 */
export function usePhoneVoiceNotes(input: {
  assistantId: string
  deviceId: string | null
  machine: PhoneMachineState
}): PhoneVoice {
  const { t } = useTranslation('voiceNotes')
  const { toast } = useToast()
  const ref = useRef(input)
  ref.current = input
  const { assistantId, deviceId } = input

  useEffect(() => {
    if (!deviceId) return
    context = {
      deviceId,
      assistantId,
      machine: () => {
        const now = ref.current
        return now.machine.state === 'ready' ? now.machine.machine : null
      },
      held: (): VoiceJobHeld => {
        const now = ref.current
        if (now.machine.state === 'opening') return 'waking'
        return 'unreachable'
      },
    }
    void phoneVoiceJobs.restore(assistantId)
    return () => {
      context = null
    }
  }, [deviceId, assistantId])

  const recorder = useRecorder()
  const [micDenied, setMicDenied] = useState(false)
  const start = useCallback(() => {
    void (async () => {
      const outcome = await phoneVoiceJobs.start()
      if (outcome === 'started') {
        setMicDenied(false)
        return
      }
      const cause = phoneVoiceRecorder.getSnapshot().cause
      phoneVoiceRecorder.clearError()
      if (outcome === 'mic_denied') setMicDenied(true)
      else if (outcome === 'mic_missing') toast(t('mic.missing'), 'error')
      else if (outcome === 'busy') toast(t('mic.busy'), 'info')
      else if (outcome !== 'no_assistant' && outcome !== 'cancelled') toast(t('mic.failed'), 'error', messageForUser(cause))
    })()
  }, [t, toast])
  const clearMicDenied = useCallback(() => setMicDenied(false), [])
  return { start, disabled: recorder.phase !== 'idle' || !deviceId, micDenied, clearMicDenied }
}
