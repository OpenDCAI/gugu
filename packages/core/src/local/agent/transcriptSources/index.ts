import { TRANSCRIPT_SOURCE_IDS, type TranscriptSource } from '../../../shared/types/transcripts'
import type { TranscriptSourceSpec } from '../transcriptSource'
import { claudeCodeTranscriptSource } from './claudeCode'
import { codexTranscriptSource } from './codex'

/**
 * 咕咕**已接通**的本机会话来源注册表。
 *
 * 类型是 `Record<TranscriptSource, …>` 而不是数组：往 `TRANSCRIPT_SOURCE_IDS` 加了 id 却忘了
 * 加 spec，tsc 当场红。反过来，写了 spec 却没进 id 表，`TranscriptSource` 里没有那个键，同样红。
 * 两边靠类型互相钉住，不需要额外的守卫。
 *
 * ⚠️ 加一家的门槛是「咕咕真读得回来」，不是「厂商有本地历史」。spec 写完请自己拿一份**真会话
 * 文件**跑一遍 `readLocalTranscript`：分帧写错时不会报错，只会安静地少几轮或多出一堆注入块。
 */
export const TRANSCRIPT_SOURCE_SPECS: Readonly<Record<TranscriptSource, TranscriptSourceSpec>> = {
  'claude-code': claudeCodeTranscriptSource,
  codex: codexTranscriptSource
}

/** 注册顺序 = 清单扫描顺序，与 `TRANSCRIPT_SOURCE_IDS` 一致。 */
export function allTranscriptSourceSpecs(): readonly TranscriptSourceSpec[] {
  return TRANSCRIPT_SOURCE_IDS.map((id) => TRANSCRIPT_SOURCE_SPECS[id])
}

/**
 * 取一家的 spec。认不出的 id **抛错**而不是回退到某一家 ——
 * 这个参数是从渲染层经 IPC 递进来的（`electron/main.ts` 那句 `source as TranscriptSource`
 * 只是断言，运行时什么都不挡）。从前的三元表达式会把任何非 `'claude-code'` 的值当 codex 处理，
 * 报出来的错是「路径不在允许的扫描目录内」——离真因十万八千里。
 */
export function requireTranscriptSourceSpec(source: TranscriptSource): TranscriptSourceSpec {
  const spec = TRANSCRIPT_SOURCE_SPECS[source]
  if (!spec) throw new Error(`未接通的 transcript 来源：${String(source)}`)
  return spec
}

export type { TranscriptSourceSpec }
