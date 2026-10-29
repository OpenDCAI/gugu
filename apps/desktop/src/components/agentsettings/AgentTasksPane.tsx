// #987 定时任务 pane — data-pane="tasks"。设计稿只给空态；列表/建表单按 gg-as 设计系统补。
// 给 agent 配周期 prompt（间隔 + 内容），到点经设备运行时 tick → ACP deliver 触发 agent 回合（owner↔agent 私聊里）。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useAuth } from '../../store/auth'
import { agentScheduledTaskService, type AgentScheduledTask } from '../../lib/agentScheduledTasks'
import type { AgentSettingsPaneProps } from './types'
import { agentSettingsPaneClass, asClass, profileInputClass } from './agentSettingsStyles'

const INTERVAL_PRESETS: { labelKey: string; seconds: number }[] = [
  { labelKey: 'preset30Minutes', seconds: 1800 },
  { labelKey: 'presetHour', seconds: 3600 },
  { labelKey: 'preset3Hours', seconds: 10800 },
  { labelKey: 'presetDay', seconds: 86400 },
  { labelKey: 'presetWeek', seconds: 604800 },
]

function intervalLabel(seconds: number | null, t: TFunction<'agents'>): string {
  if (!seconds) return t('settings.tasks.once')
  if (seconds % 86400 === 0) return t('settings.tasks.everyDays', { count: seconds / 86400 })
  if (seconds % 3600 === 0) return t('settings.tasks.everyHours', { count: seconds / 3600 })
  if (seconds % 60 === 0) return t('settings.tasks.everyMinutes', { count: seconds / 60 })
  return t('settings.tasks.everySeconds', { count: seconds })
}

function nextRunLabel(iso: string | null, enabled: boolean, t: TFunction<'agents'>): string {
  if (!enabled) return t('settings.tasks.paused')
  if (!iso) return t('settings.tasks.unscheduled')
  const timestamp = Date.parse(iso)
  if (!Number.isFinite(timestamp)) return t('settings.tasks.unscheduled')
  const diffMin = Math.round((timestamp - Date.now()) / 60000)
  if (diffMin <= 0) return t('settings.tasks.soon')
  if (diffMin < 60) return t('settings.tasks.minutesLater', { count: diffMin })
  const hr = Math.round(diffMin / 60)
  if (hr < 24) return t('settings.tasks.hoursLater', { count: hr })
  return t('settings.tasks.daysLater', { count: Math.round(hr / 24) })
}

export function AgentTasksPane({ agent }: AgentSettingsPaneProps) {
  const { t } = useTranslation('agents')
  const { user } = useAuth()
  const ownerUserId = user?.id ?? null
  const [tasks, setTasks] = useState<AgentScheduledTask[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [intervalSeconds, setIntervalSeconds] = useState(INTERVAL_PRESETS[1].seconds)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setTasks(await agentScheduledTaskService.list(agent.id))
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.tasks.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [agent.id, t])

  useEffect(() => {
    void reload()
  }, [reload])

  const handleCreate = useCallback(async () => {
    if (!ownerUserId || !prompt.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await agentScheduledTaskService.create({ agentUserId: agent.id, ownerUserId, prompt, intervalSeconds })
      setPrompt('')
      setShowForm(false)
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.tasks.createFailed'))
    } finally {
      setBusy(false)
    }
  }, [ownerUserId, prompt, intervalSeconds, agent.id, busy, reload, t])

  const handleToggle = useCallback(
    async (task: AgentScheduledTask) => {
      // optimistic：先翻转，失败回滚 + 报错。
      setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, enabled: !t.enabled } : t)))
      try {
        await agentScheduledTaskService.setEnabled(task.id, !task.enabled)
        await reload()
      } catch (e) {
        setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, enabled: task.enabled } : t)))
        setError(e instanceof Error ? e.message : t('settings.tasks.operationFailed'))
      }
    },
    [reload, t],
  )

  const handleRemove = useCallback(async (task: AgentScheduledTask) => {
    try {
      await agentScheduledTaskService.remove(task.id)
      setTasks((prev) => prev.filter((t) => t.id !== task.id))
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.tasks.deleteFailed'))
    }
  }, [t])

  const canSubmit = useMemo(() => !!ownerUserId && prompt.trim().length > 0 && !busy, [ownerUserId, prompt, busy])

  return (
    <div className={agentSettingsPaneClass(true)} data-pane="tasks">
      <div className={asClass.tasksHead}>
        <div className={asClass.tasksHeading}>{t('settings.tasks.title', { count: tasks.length })}</div>
        <button className={asClass.tasksAddButton} onClick={() => setShowForm((v) => !v)} data-testid="agent-task-add">
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24">
            <g fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M2 12c0-4.714 0-7.071 1.464-8.536C4.93 2 7.286 2 12 2s7.071 0 8.535 1.464C22 4.93 22 7.286 22 12s0 7.071-1.465 8.535C19.072 22 16.714 22 12 22s-7.071 0-8.536-1.465C2 19.072 2 16.714 2 12Z" />
              <path strokeLinecap="round" d="M15 12h-3m0 0H9m3 0V9m0 3v3" />
            </g>
          </svg>
          {showForm ? t('common.collapse') : t('common.add')}
        </button>
      </div>

      {showForm && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            padding: 12,
            marginBottom: 12,
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-surface)',
            background: 'var(--bg-secondary)',
          }}
        >
          <div>
            <div className={asClass.profileLabel}>{t('settings.tasks.content')}</div>
            <textarea
              className={profileInputClass('textarea')}
              placeholder={t('settings.tasks.placeholder')}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              data-testid="agent-task-prompt"
            />
          </div>
          <div>
            <div className={asClass.profileLabel}>{t('settings.tasks.interval')}</div>
            <select
              className={asClass.aiModelSelect}
              value={intervalSeconds}
              onChange={(e) => setIntervalSeconds(Number(e.target.value))}
              data-testid="agent-task-interval"
            >
              {INTERVAL_PRESETS.map((p) => (
                <option key={p.seconds} value={p.seconds}>
                  {t(`settings.tasks.${p.labelKey}`)}
                </option>
              ))}
            </select>
          </div>
          <button className={asClass.tasksSave} disabled={!canSubmit} onClick={handleCreate} data-testid="agent-task-save">
            {busy ? t('settings.tasks.creating') : t('settings.tasks.create')}
          </button>
        </div>
      )}

      {error && <div style={{ fontSize: 'var(--font-body)', color: 'var(--danger-fg)', marginBottom: 10 }}>{error}</div>}

      {loading ? (
        <div className={asClass.tasksLoading}>{t('settings.tasks.loading')}</div>
      ) : tasks.length === 0 ? (
        <div className={asClass.tasksEmpty}>
          <div className={asClass.tasksIconBox}>
            <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24">
              <g fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M16 4.002c2.175.012 3.353.109 4.121.877C21 5.758 21 7.172 21 10v6c0 2.829 0 4.243-.879 5.122C19.243 22 17.828 22 15 22H9c-2.828 0-4.243 0-5.121-.878C3 20.242 3 18.829 3 16v-6c0-2.828 0-4.242.879-5.121c.768-.768 1.946-.865 4.121-.877" />
                <path strokeLinecap="round" d="M8 14h8m-9-3.5h10m-8 7h6" />
                <path d="M8 3.5A1.5 1.5 0 0 1 9.5 2h5A1.5 1.5 0 0 1 16 3.5v1A1.5 1.5 0 0 1 14.5 6h-5A1.5 1.5 0 0 1 8 4.5z" />
              </g>
            </svg>
          </div>
          <div>{t('settings.tasks.empty')}</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {tasks.map((task) => (
            <div
              key={task.id}
              data-testid="agent-task-row"
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                padding: '10px 12px',
                border: '1px solid var(--border-color)',
                borderRadius: 'var(--radius-surface)',
                background: 'var(--bg-secondary)',
                opacity: task.enabled ? 1 : 0.62,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 'var(--font-body)', color: 'var(--text-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {task.title || task.prompt}
                </div>
                <div style={{ fontSize: 'var(--font-caption)', color: 'var(--text-tertiary)', marginTop: 4 }}>
                  {intervalLabel(task.intervalSeconds, t)} · {nextRunLabel(task.nextRunAt, task.enabled, t)}
                </div>
              </div>
              <button
                onClick={() => handleToggle(task)}
                data-testid="agent-task-toggle"
                style={{
                  flexShrink: 0,
                  height: 26,
                  padding: '0 10px',
                  borderRadius: 'var(--radius-control)',
                  border: '1px solid var(--border-subtle)',
                  background: 'var(--bg-elevated)',
                  color: task.enabled ? 'var(--text-secondary)' : 'var(--accent)',
                  fontSize: 'var(--font-body)',
                  cursor: 'pointer',
                }}
              >
                {task.enabled ? t('settings.tasks.pause') : t('settings.tasks.enable')}
              </button>
              <button
                onClick={() => handleRemove(task)}
                data-testid="agent-task-delete"
                aria-label={t('settings.tasks.delete')}
                style={{
                  flexShrink: 0,
                  height: 26,
                  width: 26,
                  borderRadius: 'var(--radius-control)',
                  border: '1px solid var(--border-subtle)',
                  background: 'var(--bg-elevated)',
                  color: 'var(--danger-fg)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24">
                  <path
                    fill="none"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeWidth="1.5"
                    d="M9.17 4a3.001 3.001 0 0 1 5.66 0m5.67 2h-17m15.333 2.5l-.46 6.9c-.177 2.654-.265 3.981-1.13 4.79s-2.196.81-4.856.81h-.774c-2.66 0-3.991 0-4.856-.81c-.865-.809-.954-2.136-1.13-4.79l-.46-6.9M9.5 11l.5 5m4.5-5l-.5 5"
                  />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
