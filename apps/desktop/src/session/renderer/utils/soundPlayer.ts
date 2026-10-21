import type { SoundEvent } from '@shared/core/agents/agentEvents';
import type { NotificationSettings } from '@shared/core/app-settings';
import { rpc } from '../lib/ipc';
import { queryClient } from '../lib/query-client';

let audioCtx: AudioContext | null = null;
let settings: NotificationSettings = {
  enabled: true,
  sound: true,
  customSoundPath: '',
  osNotifications: true,
  soundFocusMode: 'always',
};
const customAudioCache = new Map<string, string>();
let activePreviewAudio: HTMLAudioElement | null = null;
let activePreviewTones: Array<() => void> = [];
let previewGeneration = 0;
let unsubscribeSettingsCache: (() => void) | null = null;
const recentSounds = new Map<string, number>();

const NOTIFICATIONS_QUERY_KEY = ['appSettings', 'notifications', 'meta'] as const;
const SOUND_DEDUPE_WINDOW_MS = 1_000;

function pruneRecentSounds(now: number): void {
  for (const [key, lastPlayedAt] of recentSounds) {
    if (now - lastPlayedAt >= SOUND_DEDUPE_WINDOW_MS) {
      recentSounds.delete(key);
    }
  }
}

function applySettings(nextSettings: NotificationSettings): void {
  const nextCustomSoundPath = nextSettings.customSoundPath?.trim() ?? '';
  const currentCustomSoundPath = settings.customSoundPath?.trim() ?? '';
  if (nextCustomSoundPath !== currentCustomSoundPath) {
    customAudioCache.clear();
  }
  settings = { ...nextSettings, customSoundPath: nextCustomSoundPath };
}

function applyMeta(meta: unknown): void {
  if (!meta || typeof meta !== 'object' || !('value' in meta)) return;
  applySettings((meta as { value: NotificationSettings }).value);
}

export function initSoundPlayer(): () => void {
  rpc.appSettings
    .getWithMeta('notifications')
    .then((meta) => {
      queryClient.setQueryData([...NOTIFICATIONS_QUERY_KEY], meta);
      applyMeta(meta);
    })
    .catch(() => {});

  unsubscribeSettingsCache?.();
  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    const key = event.query.queryKey;
    if (
      Array.isArray(key) &&
      key[0] === NOTIFICATIONS_QUERY_KEY[0] &&
      key[1] === NOTIFICATIONS_QUERY_KEY[1] &&
      key[2] === NOTIFICATIONS_QUERY_KEY[2]
    ) {
      applyMeta(event.query.state.data);
    }
  });
  unsubscribeSettingsCache = unsubscribe;

  return () => {
    unsubscribe();
    if (unsubscribeSettingsCache === unsubscribe) {
      unsubscribeSettingsCache = null;
    }
  };
}

export function configureSoundPlayer(nextSettings: NotificationSettings): void {
  applySettings(nextSettings);
}

/**
 * 最后一个音落下之后,再过这么久把 AudioContext 挂起。
 *
 * 一个 running 的 AudioContext 即使不出声也一直在渲染静音:声卡流开着、渲染进程里一条实时音频线程
 * 每 ~20ms 醒一次(mac1 2026-09-25 实测:一次任务完成提示音之后 `WebAudio.getRealtimeData` 读到
 * currentTime 一路涨到几百秒)。提示音一次不到一秒,平时一声不响 ⇒ 响完就挂起,下次要响时再 resume。
 * 省的是这条线程的持续唤醒(CPU/电量),❌ 不是内存:Chromium 的 AudioService 子进程挂起后照样留着
 * (同日实测挂起后 200 s 内一直在)。代价是每声多等一次 resume:同机实测 5–16 ms。
 */
const AUDIO_IDLE_SUSPEND_MS = 1_000;
let suspendTimer: ReturnType<typeof setTimeout> | null = null;

function getContext(): AudioContext {
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
  if (suspendTimer !== null) {
    clearTimeout(suspendTimer);
    suspendTimer = null;
  }
  // 无条件 resume:suspend() 是异步的,state 要等它落定才变 —— 刚发出挂起、还读到 'running' 的那一刻
  // 来的音若只看 state 就不会 resume,挂起随后生效,这一声就哑了。对 running 的上下文 resume 是空操作。
  void audioCtx.resume();
  return audioCtx;
}

/** 在 `endTime`(AudioContext 时钟,秒)之后挂起;期间有新的音会经 getContext 取消这次挂起。 */
function suspendAfter(endTime: number): void {
  const ctx = audioCtx;
  if (!ctx) return;
  const delayMs = Math.max(0, (endTime - ctx.currentTime) * 1000) + AUDIO_IDLE_SUSPEND_MS;
  suspendTimer = setTimeout(() => {
    suspendTimer = null;
    if (ctx.state === 'running') void ctx.suspend();
  }, delayMs);
}

function playTone(
  frequency: number,
  startTime: number,
  duration: number,
  type: OscillatorType = 'triangle',
  gain = 0.15
): () => void {
  const ctx = getContext();
  const osc = ctx.createOscillator();
  const vol = ctx.createGain();
  osc.type = type;
  osc.frequency.value = frequency;
  vol.gain.setValueAtTime(gain, startTime);
  vol.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
  osc.connect(vol);
  vol.connect(ctx.destination);
  osc.start(startTime);
  osc.stop(startTime + duration);
  return () => {
    try {
      osc.stop();
    } catch {
      // Already stopped.
    }
    osc.disconnect();
    vol.disconnect();
  };
}

function playNeedsAttention(): Array<() => void> {
  const ctx = getContext();
  const now = ctx.currentTime;
  const tones = [playTone(880, now, 0.12), playTone(1100, now + 0.15, 0.12)];
  suspendAfter(now + 0.27);
  return tones;
}

function playTaskComplete(): Array<() => void> {
  const ctx = getContext();
  const now = ctx.currentTime;
  const tones = [
    playTone(523.25, now, 0.15, 'triangle', 0.12),
    playTone(659.25, now + 0.18, 0.15, 'triangle', 0.12),
    playTone(783.99, now + 0.36, 0.2, 'triangle', 0.12),
  ];
  suspendAfter(now + 0.56);
  return tones;
}

async function getCustomSoundDataUrl(path: string): Promise<string | null> {
  let dataUrl = customAudioCache.get(path);
  if (!dataUrl) {
    const result = (await rpc.app.readAudioFileDataUrl(path)) as
      | { success: true; dataUrl: string }
      | { success: false; error: string };
    if (!result.success) return null;
    dataUrl = result.dataUrl;
    customAudioCache.set(path, dataUrl);
  }
  return dataUrl;
}

async function playCustomSound(path: string): Promise<boolean> {
  try {
    const dataUrl = await getCustomSoundDataUrl(path);
    if (!dataUrl) return false;
    const audio = new Audio(dataUrl);
    await audio.play();
    return true;
  } catch {
    return false;
  }
}

function playBuiltinSound(event: SoundEvent): Array<() => void> {
  switch (event) {
    case 'needs_attention':
      return playNeedsAttention();
    case 'task_complete':
      return playTaskComplete();
  }
}

function stopActivePreview(): void {
  if (activePreviewAudio) {
    activePreviewAudio.pause();
    activePreviewAudio.currentTime = 0;
    activePreviewAudio = null;
  }
  for (const stopTone of activePreviewTones) {
    stopTone();
  }
  activePreviewTones = [];
}

export const soundPlayer = {
  play(event: SoundEvent, appFocused?: boolean, dedupeKey?: string): void {
    if (!settings.enabled) return;
    if (!settings.sound) return;
    if (settings.soundFocusMode === 'unfocused' && appFocused) return;
    if (dedupeKey) {
      const now = Date.now();
      pruneRecentSounds(now);
      const key = `${event}:${dedupeKey}`;
      const lastPlayedAt = recentSounds.get(key);
      if (lastPlayedAt !== undefined && now - lastPlayedAt < SOUND_DEDUPE_WINDOW_MS) return;
      recentSounds.set(key, now);
    }

    try {
      const customSoundPath = settings.customSoundPath?.trim() ?? '';
      if (customSoundPath) {
        void playCustomSound(customSoundPath).then((played) => {
          if (!played) playBuiltinSound(event);
        });
        return;
      }
      playBuiltinSound(event);
    } catch {
      // Audio may fail if user hasn't interacted with page yet
    }
  },

  preview(path?: string): void {
    stopActivePreview();
    const generation = ++previewGeneration;
    const previewPath = path?.trim();

    if (previewPath) {
      void getCustomSoundDataUrl(previewPath)
        .then((dataUrl) => {
          if (generation !== previewGeneration) return;
          if (!dataUrl) {
            activePreviewTones = playBuiltinSound('needs_attention');
            return;
          }

          const audio = new Audio(dataUrl);
          activePreviewAudio = audio;
          audio.addEventListener(
            'ended',
            () => {
              if (activePreviewAudio === audio) activePreviewAudio = null;
            },
            { once: true }
          );
          void audio.play();
        })
        .catch(() => {
          if (generation === previewGeneration) {
            activePreviewTones = playBuiltinSound('needs_attention');
          }
        });
      return;
    }

    activePreviewTones = playBuiltinSound('needs_attention');
  },
};
