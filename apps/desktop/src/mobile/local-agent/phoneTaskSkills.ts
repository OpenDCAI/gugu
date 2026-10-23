import { parseDocument } from 'yaml'
import { invokePhoneHost } from './phoneHostRpc'

export interface PhoneTaskSkill { id: string; name: string; description: string; instructions: string; enabled: boolean }
export interface PhoneSkillLimits { maxSkills: number; maxNameChars: number; maxDescriptionChars: number; maxInstructionChars: number; maxTotalBytes: number }
export interface PhoneTaskSkillsSnapshot {
  conversationId: string
  revision: number
  updatedAt: string | null
  skills: PhoneTaskSkill[]
  editable: boolean
  busy: boolean
  limits: PhoneSkillLimits
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const phoneSkillCharacterCount = (value: string): number => Array.from(value).length

/** Validation shared by manual editing and document import; never truncates user instructions. */
export function validatePhoneTaskSkills(skills: PhoneTaskSkill[], limits: PhoneSkillLimits): void {
  if (skills.length > limits.maxSkills) throw new Error(`每个任务最多配置 ${limits.maxSkills} 个 Skill。`)
  const ids = new Set<string>()
  for (const skill of skills) {
    if (!UUID.test(skill.id) || ids.has(skill.id)) throw new Error('Skill 标识重复或无效，请重新添加。')
    ids.add(skill.id)
    if (!skill.name.trim() || phoneSkillCharacterCount(skill.name.trim()) > limits.maxNameChars) throw new Error(`Skill 名称须为 1–${limits.maxNameChars} 个字符。`)
    if (phoneSkillCharacterCount(skill.description) > limits.maxDescriptionChars) throw new Error(`「${skill.name}」的简短说明超过 ${limits.maxDescriptionChars} 个字符。`)
    if (!skill.instructions.trim() || phoneSkillCharacterCount(skill.instructions) > limits.maxInstructionChars) throw new Error(`「${skill.name}」的操作说明须为 1–${limits.maxInstructionChars} 个字符。`)
  }
  if (new TextEncoder().encode(JSON.stringify(skills)).byteLength > limits.maxTotalBytes) throw new Error('Skill 配置总大小超限，请精简后再保存。')
}

function snapshot(value: PhoneTaskSkillsSnapshot, sessionId: string): PhoneTaskSkillsSnapshot {
  if (!value || value.conversationId !== sessionId || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.skills)
    || typeof value.editable !== 'boolean' || typeof value.busy !== 'boolean'
    || !value.limits || (['maxSkills', 'maxNameChars', 'maxDescriptionChars', 'maxInstructionChars', 'maxTotalBytes'] as const).some((key) => !Number.isSafeInteger(value.limits[key]) || value.limits[key] <= 0)
    || value.skills.some((skill) => !skill || typeof skill.id !== 'string' || typeof skill.name !== 'string' || typeof skill.description !== 'string' || typeof skill.instructions !== 'string' || typeof skill.enabled !== 'boolean')) {
    throw new Error('手机返回的 Skill 配置无法读取，请更新咕咕后重试。')
  }
  validatePhoneTaskSkills(value.skills, value.limits)
  return value
}

export async function readPhoneTaskSkills(deviceId: string, sessionId: string): Promise<PhoneTaskSkillsSnapshot> {
  return snapshot(await invokePhoneHost<PhoneTaskSkillsSnapshot>(deviceId, 'sessionTimeline.phoneSkillsGet', [{ conversationId: sessionId }]), sessionId)
}

export async function savePhoneTaskSkills(deviceId: string, sessionId: string, expectedRevision: number, skills: PhoneTaskSkill[]): Promise<PhoneTaskSkillsSnapshot> {
  return snapshot(await invokePhoneHost<PhoneTaskSkillsSnapshot>(deviceId, 'sessionTimeline.phoneSkillsSet', [{ conversationId: sessionId, expectedRevision, skills }]), sessionId)
}

/** Import one document as text. Frontmatter only supplies labels; it never registers tools or loads files. */
export async function importPhoneTaskSkill(file: File, limits: PhoneSkillLimits): Promise<PhoneTaskSkill> {
  if (file.size > limits.maxTotalBytes) throw new Error('文件过大，请选择较小的 SKILL.md。')
  const text = (await file.text()).replace(/^\uFEFF/, '')
  let name = file.name.replace(/\.(md|markdown)$/i, '')
  let description = ''
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (match) {
    const doc = parseDocument(match[1], { uniqueKeys: true })
    if (doc.errors.length) throw new Error('SKILL.md 的开头配置无法解析，请检查名称与说明。')
    const metadata = doc.toJS({ maxAliasCount: 0 }) as Record<string, unknown> | null
    if (metadata !== null && metadata !== undefined && (typeof metadata !== 'object' || Array.isArray(metadata))) throw new Error('SKILL.md 的开头配置须为名称和说明等字段。')
    if (metadata?.name !== undefined && typeof metadata.name !== 'string') throw new Error('Skill 名称须为文字。')
    if (metadata?.description !== undefined && typeof metadata.description !== 'string') throw new Error('Skill 说明须为文字。')
    name = typeof metadata?.name === 'string' ? metadata.name : name
    description = typeof metadata?.description === 'string' ? metadata.description : ''
  }
  const skill = { id: crypto.randomUUID(), name, description, instructions: text, enabled: true }
  validatePhoneTaskSkills([skill], limits)
  return skill
}
