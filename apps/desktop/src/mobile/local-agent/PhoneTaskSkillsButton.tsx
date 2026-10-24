import { useEffect, useRef, useState } from 'react'
import { ArrowUpToLine, BookOpen, ChevronLeft, Plus, Trash2 } from '@/lib/icons'
import { useAuth } from '@/store/auth'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { PaneHeader } from '@/components/ui/Pane'
import { ListRowContent } from '@/components/ui/ListRow'
import { Sheet } from '@/components/ui/Sheet'
import { Switch } from '@/components/ui/Switch'
import { PaneEmptyState } from '@/components/ui/PaneEmptyState'
import { SettingsNote } from '@/components/settings/SettingsPrimitives'
import { phoneAgentAvailable } from './nativeAgent'
import { thisPhoneDeviceId } from '../phone-device/phoneDeviceSettings'
import { PhoneSkillFields } from './PhoneSkillFields'
import { PhoneSheetHandle } from '../PhoneSheetHandle'
import { importPhoneTaskSkill, readPhoneTaskSkills, savePhoneTaskSkills, validatePhoneTaskSkills, type PhoneTaskSkill, type PhoneTaskSkillsSnapshot } from './phoneTaskSkills'
import './phone-task-skills.css'

/** The phone's owner configures this task through the existing trusted native UI bridge. */
export function PhoneTaskSkills({ deviceId, sessionId, online, busy = false }: { deviceId: string; sessionId: string; online: boolean; busy?: boolean }) {
  const ownerId = useAuth().user?.id ?? null
  const [open, setOpen] = useState(false)
  useEffect(() => setOpen(false), [ownerId, deviceId, sessionId])
  if (!ownerId || !phoneAgentAvailable() || thisPhoneDeviceId(ownerId) !== deviceId) return null
  return (
    <>
      <IconButton size="md" aria-label="配置 Skill" title={online ? '配置 Skill' : '连接这台手机后配置 Skill'} disabled={!online} onClick={() => setOpen(true)} data-testid="phone-task-skills-open"><BookOpen /></IconButton>
      {open && <PhoneSkillsManager key={`${ownerId}:${deviceId}:${sessionId}`} deviceId={deviceId} sessionId={sessionId} busy={busy || !online} onClose={() => setOpen(false)} />}
    </>
  )
}

export function PhoneSkillsManager({ deviceId, sessionId, busy, onClose }: { deviceId: string; sessionId: string; busy: boolean; onClose: () => void }) {
  const [loaded, setLoaded] = useState<PhoneTaskSkillsSnapshot | null>(null)
  const [draft, setDraft] = useState<PhoneTaskSkill[]>([])
  const [editId, setEditId] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [discard, setDiscard] = useState<'close' | 'reload' | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const alive = useRef(true)
  const dirty = loaded !== null && JSON.stringify(draft) !== JSON.stringify(loaded.skills)
  const disabled = saving || importing || loading || busy || loaded?.busy === true || loaded?.editable !== true
  const selected = draft.find((skill) => skill.id === editId)

  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    let current = true
    setLoading(true); setError(null)
    void readPhoneTaskSkills(deviceId, sessionId).then((value) => {
      if (!current) return
      setLoaded(value); setDraft(value.skills); setEditId(null); setDiscard(null)
    }).catch((cause) => { if (current) setError(cause instanceof Error ? cause.message : String(cause)) })
      .finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [deviceId, sessionId, attempt])

  const close = () => { if (!saving && !importing) dirty ? setDiscard('close') : onClose() }
  const update = (next: PhoneTaskSkill) => { setDraft((items) => items.map((item) => item.id === next.id ? next : item)); setError(null); setDiscard(null) }
  const add = () => {
    const skill = { id: crypto.randomUUID(), name: '', description: '', instructions: '', enabled: true }
    setDraft((items) => [...items, skill]); setEditId(skill.id); setError(null); setDiscard(null)
  }
  const save = async () => {
    if (!loaded || disabled || !dirty) return
    try { validatePhoneTaskSkills(draft, loaded.limits) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return }
    setSaving(true); setError(null)
    try {
      const value = await savePhoneTaskSkills(deviceId, sessionId, loaded.revision, draft)
      if (!alive.current) return
      setLoaded(value); setDraft(value.skills); onClose()
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (alive.current) setSaving(false) }
  }
  const importFile = async (file: File) => {
    if (!loaded || disabled) return
    setImporting(true)
    try {
      const skill = await importPhoneTaskSkill(file, loaded.limits)
      if (!alive.current) return
      validatePhoneTaskSkills([...draft, skill], loaded.limits)
      setDraft((items) => [...items, skill]); setEditId(skill.id); setError(null)
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (alive.current) setImporting(false) }
  }

  return (
    <Sheet onClose={close} onEscape={() => { if (selected && !saving) { setEditId(null); return true } return false }} mobileHeight="92dvh" desktopWidth="min(640px, 100%)" desktopHeight="640px" testId="phone-task-skills" ariaLabel="任务 Skill" closeOnBackdrop={!saving}>
      <div className="gg-phone-skills">
        <PhoneSheetHandle onDismiss={close} disabled={saving || importing} />
        <PaneHeader mobile title={selected ? selected.name || '新 Skill' : '任务 Skill'} titleLevel="page" leading={<IconButton size="md" aria-label={selected ? '返回 Skill 列表' : '返回任务'} disabled={saving} onClick={selected ? () => setEditId(null) : close}><ChevronLeft /></IconButton>} actions={selected ? <IconButton size="md" aria-label="删除这个 Skill" disabled={disabled} onClick={() => { setDraft((items) => items.filter((item) => item.id !== selected.id)); setEditId(null); setError(null) }} data-testid="phone-skill-delete"><Trash2 /></IconButton> : undefined} />
        <div className="gg-phone-skills-body">
          <SettingsNote>只用于这个手机任务。手机 Agent 按需要读取已启用的说明，手机权限仍以授权设置为准。</SettingsNote>
          {loading ? <SettingsNote role="status">正在读取 Skill…</SettingsNote> : loaded ? (
            <>
              {(busy || loaded.busy) && <SettingsNote role="status">任务正在处理或等待确认，结束后重新读取即可配置。</SettingsNote>}
              {!loaded.editable && <SettingsNote>请在这台手机上配置任务 Skill。</SettingsNote>}
              {selected ? <PhoneSkillFields skill={selected} limits={loaded.limits} disabled={disabled} onChange={update} /> : (
                <>
                  <div className="gg-phone-skills-toolbar">
                    <Button size="sm" variant="primary" disabled={disabled || draft.length >= loaded.limits.maxSkills} onClick={add} data-testid="phone-skill-add"><Plus className="size-4" />添加 Skill</Button>
                    <Button size="sm" variant="ghost" disabled={disabled || draft.length >= loaded.limits.maxSkills} onClick={() => fileInput.current?.click()} data-testid="phone-skill-import"><ArrowUpToLine className="size-4" />{importing ? '正在导入' : '导入 SKILL.md'}</Button>
                    <input ref={fileInput} type="file" hidden accept=".md,.markdown,text/markdown,text/plain" aria-label="导入 Skill 文件" onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void importFile(file) }} />
                  </div>
                  {draft.length === 0 ? <PaneEmptyState icon={<BookOpen />} caption="还没有配置 Skill" hint="添加一份操作说明，让手机 Agent 按你的方式处理手机任务。" /> : (
                    <div className="gg-phone-skills-list">
                      {draft.map((skill) => <div className="gg-phone-skill-row" key={skill.id}>
                        <Button variant="ghost" size="option" className="gg-list-row gg-row" data-mobile="" onClick={() => setEditId(skill.id)} data-testid={`phone-skill-edit-${skill.id}`}>
                          <ListRowContent title={skill.name || '未命名 Skill'} leading={<BookOpen className="size-5" />} subtitle={skill.description || (skill.enabled ? '已启用' : '未启用')} />
                        </Button>
                        <Switch checked={skill.enabled} disabled={disabled} onCheckedChange={(enabled) => update({ ...skill, enabled })} aria-label={`启用 ${skill.name || '未命名 Skill'}`} />
                      </div>)}
                    </div>
                  )}
                </>
              )}
            </>
          ) : null}
          {error && <SettingsNote role="alert" tone="danger" data-testid="phone-skills-error">{error}</SettingsNote>}
          {(!loading && (!loaded || error || loaded.busy)) && <Button size="sm" variant="ghost" disabled={saving || importing} onClick={() => { if (dirty) setDiscard('reload'); else setAttempt((n) => n + 1) }}>{dirty ? '放弃修改后重新读取' : '重新读取'}</Button>}
        </div>
        <div className="gg-phone-skills-footer">
          {discard ? (
            <>
              <SettingsNote>还没有保存修改。</SettingsNote>
              <div className="gg-phone-skills-actions"><Button variant="ghost" onClick={() => setDiscard(null)}>继续编辑</Button><Button onClick={() => { if (discard === 'reload') { setDraft(loaded?.skills ?? []); setEditId(null); setDiscard(null); setAttempt((n) => n + 1) } else onClose() }} data-testid="phone-skills-discard">{discard === 'reload' ? '放弃修改并重新读取' : '放弃修改并返回'}</Button></div>
            </>
          ) : (
            <>
              <SettingsNote>保存后从下一轮生效，已有对话和记录保留。</SettingsNote>
              <div className="gg-phone-skills-actions"><Button variant="ghost" disabled={saving} onClick={close}>取消</Button><Button variant="primary" disabled={disabled || !dirty} onClick={() => void save()} data-testid="phone-skills-save">{saving ? '正在保存' : '保存'}</Button></div>
            </>
          )}
        </div>
      </div>
    </Sheet>
  )
}
