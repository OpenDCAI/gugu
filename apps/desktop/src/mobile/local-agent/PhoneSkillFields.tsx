import { Field } from '@/components/ui/Field'
import { Switch } from '@/components/ui/Switch'
import { SettingsNote, SettingsRow } from '@/components/settings/SettingsPrimitives'
import { phoneSkillCharacterCount, type PhoneSkillLimits, type PhoneTaskSkill } from './phoneTaskSkills'

export function PhoneSkillFields({ skill, limits, disabled, onChange }: { skill: PhoneTaskSkill; limits: PhoneSkillLimits; disabled: boolean; onChange: (skill: PhoneTaskSkill) => void }) {
  return (
    <div className="gg-phone-skill-fields" data-testid="phone-skill-fields">
      <Field.Root>
        <Field.Label>名称</Field.Label>
        <Field.Input value={skill.name} disabled={disabled} onValueChange={(name) => onChange({ ...skill, name })} data-testid="phone-skill-name" autoComplete="off" />
      </Field.Root>
      <Field.Root>
        <Field.Label>什么时候使用</Field.Label>
        <Field.Input value={skill.description} disabled={disabled} onValueChange={(description) => onChange({ ...skill, description })} data-testid="phone-skill-description" placeholder="例如：整理当天的日历安排时" autoComplete="off" />
      </Field.Root>
      <Field.Root>
        <Field.Label>操作说明</Field.Label>
        <Field.Textarea value={skill.instructions} disabled={disabled} rows={10} onValueChange={(instructions) => onChange({ ...skill, instructions })} data-testid="phone-skill-instructions" placeholder="写下步骤、注意事项和希望怎样回复。支持 Markdown。" spellCheck={false} />
        <Field.Description>{phoneSkillCharacterCount(skill.instructions)} / {limits.maxInstructionChars} 字符</Field.Description>
      </Field.Root>
      <SettingsRow title="启用这个 Skill" description="手机 Agent 可在任务中读取这份说明。" control={<Switch aria-label="启用这个 Skill" checked={skill.enabled} disabled={disabled} onCheckedChange={(enabled) => onChange({ ...skill, enabled })} />} />
      <SettingsNote>说明只指导现有工具的使用，不授予手机权限，也不运行脚本或附带文件。</SettingsNote>
    </div>
  )
}
