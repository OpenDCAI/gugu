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
    `先读owner-profile.md再整理：正文用「你」写1～3句已证身份、近况、作息；勿据mtime猜作息，未知省略，无标题。称呼仅「称呼：姓名」；称呼规矩仅留提示词，不入任何记忆。禁「他」，删除助理规矩及推理；本人确认约定移feedback并索引，事实、日期与来源保留，依据放末节。回读合规才在MEMORY.md原行记profile_rules:${PROFILE_RULES_VERSION}并回读；失败不标通过。不新建档案或报进度，再回复。`,
    '</gugu_profile_review>',
  ].join('\n')
  return { ...admission, beforeText: [admission.beforeText, review].filter(Boolean).join('\n\n') }
}
