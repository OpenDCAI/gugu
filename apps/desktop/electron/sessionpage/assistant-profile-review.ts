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
    ...(unavailable ? ['宿主无法核对版本。'] : []),
    '本轮先整理owner-profile.md：正文先用「你」写1～3句身份、近况和已确认作息，不加标题；称呼仅一行。全文不用「他」；助理规矩与推理不进档案；本人确认约定归feedback，保留事实、日期和来源。',
    `回读合规后才在MEMORY.md原档案行记profile_rules:${PROFILE_RULES_VERSION}，再回读索引；失败不标通过。不新建档案、不发进度，随后回复本轮消息。`,
    '</gugu_profile_review>',
  ].join('\n')
  return { ...admission, trailingText: [admission.trailingText, review].filter(Boolean).join('\n\n') }
}
