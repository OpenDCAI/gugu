/**
 * #7199 语音笔记在会话页渲染层与主进程之间的契约。
 *
 * 转写走咕咕的模型网关(按积分计费):主进程以个人助理的名义签一张平台票(与它开会话同一个签发口),
 * 把一段录音交给会听录音的那个模型。渲染层够不到凭据,只把音频与提示交过去,拿回模型说的那段字。
 */

/** 听录音用哪个平台模型、哪条协议(网关上「Chat Completions + input_audio」,2026-10-15 预发与 my-laptop 实测能分说话人)。 */
export const VOICE_NOTE_MODEL_ID = 'gemini-3.8-flash';
export const VOICE_NOTE_MODEL_PROTOCOL = 'openai-chat-completions';

/** 渲染层 → 主进程:转写一段。入参 {@link VoiceNoteTranscribeRequest},回 {@link VoiceNoteTranscribeResult}。 */
export const VOICE_NOTE_TRANSCRIBE_CHANNEL = 'voice-notes:transcribe';
/** 一条笔记转写完:把为它签的票结掉(不结也会在几分钟没用之后自己结)。入参 agentUserId。 */
export const VOICE_NOTE_RELEASE_CHANNEL = 'voice-notes:release';
/** 麦克风授权:`request` 问系统(第一次会弹系统框),`open-settings` 打开系统设置里麦克风那一页。 */
export const VOICE_NOTE_MICROPHONE_CHANNEL = 'voice-notes:microphone';

export type VoiceNoteTranscribeRequest = {
  /** 以谁的名义签票(个人助理;账单记在它名下)。 */
  agentUserId: string;
  /** 16k 单声道 WAV 的 base64。 */
  audioBase64: string;
  prompt: string;
};

/**
 * - `signed-out` / `membership-required` / `model-unavailable` / `unreachable` / `service-unavailable`:签票那一步(原因同会话签票);
 * - `refused`:网关拒了(积分用完、分组不对……),`message` 是网关那句话;
 * - `failed`:模型那一轮出错 / 超时。
 */
export type VoiceNoteTranscribeResult =
  | { ok: true; text: string }
  | {
      ok: false;
      code: 'signed-out' | 'membership-required' | 'model-unavailable' | 'unreachable' | 'service-unavailable' | 'refused' | 'failed';
      message: string;
    };

export type VoiceNoteMicrophoneAction = 'request' | 'open-settings';
export type VoiceNoteMicrophoneStatus = 'granted' | 'denied' | 'unsupported';

/**
 * 会议提醒:这台电脑日历里前后一小段时间的日程(与「设备 → 这台电脑能做的事」里连上的「日历」同一份授权;没连上就不读)。
 * 无入参,回 {@link VoiceNoteMeetingsResult}。
 */
export const VOICE_NOTE_MEETINGS_CHANNEL = 'voice-notes:upcoming-meetings';

export type VoiceNoteMeetingsResult =
  | { ok: true; meetings: { id: string; title: string; start: string; end: string | null; allDay: boolean }[] }
  /** not_granted = 日历没连上;unsupported = 这台电脑读不了(不是 Mac / 原生助手不在);其余 = 这一次没读成。 */
  | { ok: false; code: string };
