import { useEffect, useState } from 'react'
import { formatElapsed } from '@gugu/session-chat-ui/background-rosters'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { ChevronDown, ChevronRight, Square, SquareTerminal, User, X } from '@/lib/icons'
import { translateSessionMessage as st } from '@renderer/localization/locale-store'
import { backgroundTasksLabel, type PhoneBackgroundTasks as Tasks } from './background-tasks'

/**
 * 手机看会话:还在跑的后台命令与子智能体(#638 搬到手机,owner 2026-10-27「后台任务放进主对话」)。
 * 贴在输入框上面、对话的末尾:收着时一句「后台 · … ›」带微光,点开就地展开单子;每行图标、名字、(子智能体)步数与时长、
 * 停止、×(只收起这一行,❌ 不停)。一条不剩就整句消失。停止只在那台电脑接得住时画(老版本主机没有这条路)。
 */
export function PhoneBackgroundTasks({ tasks, onStop, onDismiss }: {
  tasks: Tasks
  onStop: (stopId: string) => void
  onDismiss: (entryId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const count = tasks.commands.length + tasks.subagents.length
  // 单子开着才数秒(同桌面:收着时屏上没有跟着时间走的数)。
  useEffect(() => {
    if (!open || count === 0) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [open, count])
  if (count === 0) return null
  const Chevron = open ? ChevronDown : ChevronRight
  const stopButton = (stopId: string, label: string) => tasks.canStop ? (
    <IconButton size="sm" aria-label={label} title={label} className="gg-aw-bg-stop" onClick={() => onStop(stopId)}><Square size={14} /></IconButton>
  ) : null
  const dismissButton = (entryId: string) => (
    <IconButton size="sm" aria-label={st('transcript.backgroundTasks.dismiss')} title={st('transcript.backgroundTasks.dismiss')} onClick={() => onDismiss(entryId)}><X size={14} /></IconButton>
  )
  return (
    <div className="gg-aw-bg" data-testid="agent-watch-background-tasks">
      <Button variant="ghost" size="sm" className="gg-aw-bg-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="gg-aw-bg-label shimmer motion-reduce:animate-none">{backgroundTasksLabel(tasks.commands.length, tasks.subagents.length)}</span>
        <Chevron size={14} aria-hidden />
      </Button>
      {open ? (
        <div className="gg-aw-bg-list" data-testid="agent-watch-background-list">
          {tasks.commands.map((command) => (
            <div key={command.id} className="gg-aw-bg-row" data-task-kind="command">
              <SquareTerminal size={16} className="gg-aw-bg-icon" aria-hidden />
              <span className="gg-aw-bg-name">{command.name}</span>
              {stopButton(command.taskId, st('transcript.backgroundTasks.stopCommand'))}
              {dismissButton(command.id)}
            </div>
          ))}
          {tasks.subagents.map((agent) => (
            <div key={agent.id} className="gg-aw-bg-row" data-task-kind="subagent">
              <User size={16} className="gg-aw-bg-icon" aria-hidden />
              <span className="gg-aw-bg-name">{agent.name}</span>
              <span className="gg-aw-bg-meta">
                {[
                  agent.completedSteps > 0 ? st(agent.completedSteps === 1 ? 'transcript.backgroundTasks.stepsOne' : 'transcript.backgroundTasks.steps', { count: agent.completedSteps }) : '',
                  agent.startedAt === undefined ? '' : formatElapsed(Math.max(0, now - agent.startedAt)),
                ].filter(Boolean).join(' · ')}
              </span>
              {agent.canCancel ? stopButton(agent.launchToolCallId, st('transcript.backgroundTasks.stopSubagent')) : null}
              {dismissButton(agent.id)}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
