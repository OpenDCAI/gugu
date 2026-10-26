import { expect, it } from 'vitest'
import { panelApplicationFailure } from '../../packages/core/src/shared/assistantPanelFailure'
it('shows a resource and a public reason in each language without leaking raw runtime details', () => {
  expect(panelApplicationFailure('schedules','晨间提醒','PANEL_SCHEDULE_NOT_OWNED','zh-CN')).toContain('定时任务「晨间提醒」未能应用：这项定时任务不属于当前助理')
  expect(panelApplicationFailure('memory','note','EACCES','en-US')).toContain('Memory “note” could not be applied: Permission')
  expect(panelApplicationFailure('memory','note','raw transport details','zh-CN','remove')).toBe('记忆「note」的删除清理未完成：处理过程中未能完成读写。')
})
