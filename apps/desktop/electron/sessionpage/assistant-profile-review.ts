import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PROFILE_RULES_VERSION } from '@gugu/core/shared/assistantWorkflow'
import type { PanelPreparedAdmission } from './assistant-panel-admission'

/** Run at the final host admission, including warm native sessions. Neither history nor auto-memory is a receipt. */
export async function prepareAssistantProfileReview(admission: PanelPreparedAdmission, memoryDir: string): Promise<PanelPreparedAdmission> {
  const profile = join(memoryDir, 'owner-profile.md'), index = join(memoryDir, 'MEMORY.md')
  let unavailable = false, current: string | undefined
  try { await access(profile) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return admission; unavailable = true }
  try {
    const text = await readFile(index, 'utf8')
    const lines = text.split(/\r?\n/).filter(line => /\]\((?:\.\/)?owner-profile\.md\)/.test(line))
    if (lines.length === 1) current = lines[0]!.match(/\bprofile_rules:\s*(\d+)\b/)?.[1]
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unavailable = true }
  if (!unavailable && current === String(PROFILE_RULES_VERSION)) return admission
  const review = [
    '<gugu_profile_review>',
    ...(unavailable ? ['未核。'] : []),
    `需回复时先用message_send按信封回复，再整理，不再发消息。读owner-profile.md：「你」开头，几句已证身份、近况、作息；未知省略，禁标题及mtime推测。仅留「称呼：姓名」，其余称呼原话、助理规矩全删，勿记忆。禁「他」；其他本人确认约定移feedback并索引。保留事实、日期、来源；依据放末节。回读合规才在MEMORY.md原行记profile_rules:${PROFILE_RULES_VERSION}并回读；失败不记。`,
    '</gugu_profile_review>',
  ].join('\n')
  return { ...admission, beforeText: [admission.beforeText, review].filter(Boolean).join('\n\n') }
}
